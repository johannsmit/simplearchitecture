import { randomUUID } from 'node:crypto';
import {
  architectureStates,
  buildModelGraph,
  containerOf,
  containsType,
  defaultArchitectureState,
  edgeTypes,
  canBeTwoWay,
  hasStandardEdgeProperty,
  isEdgeType,
  isRelationTextProperty,
  relationTextProperties,
  retiredDataKey,
  standardProperties,
  relationshipConflictMessage,
  relationshipProblems,
  type DeletedRelationshipResult,
  type JgfDocument,
  type JgfEdge,
  type JgfValidationResult,
  type ModelAuthor,
  type NestingChange,
  type RelationshipChangeResult,
  type RelationshipFieldIssue,
  type StoredRelationship,
  type ValidationIssue,
} from '@simplearchitecture/shared';
import { z } from 'zod';
import { retiredInformationFlowKey } from '../jgf/older-types.js';
import { validateJgf } from '../jgf/validate.js';
import {
  maxElementIdLength,
  maxMetadataEntries,
  maxPropertyValueLength,
  maxRelationshipDescriptionLength,
  maxRelationshipLabelLength,
} from '../limits.js';
import type { EditableModel, ElementStore, ModelStore } from '../storage/model-store.js';
import {
  apply,
  ConflictError,
  deleteSchema,
  EditingUnavailableError,
  isEntries,
  issueId,
  keyProblem,
  NotFoundError,
  parse as parseRequest,
  plan,
  refuseErrors,
  RejectedError,
  sameValue,
  Unchanged,
  versionSchema,
  type Entries,
} from './common.js';

/**
 * Adding, changing (type, Architecture state, description, label, direction, Identity, Identity
 * Context, Request Data, Response Data) and deleting one relationship of a stored model, beside ElementService and through the same store change: one
 * transaction under the model's row lock, the counts and list cache kept, one audit row.
 *
 * - Every change is checked against the whole model with the full validation and refused on an
 *   error; warnings never stop it.
 * - Rules for changes made here only (never applied to stored models), from
 *   `relationshipProblems`: a relationship from an element to itself (any type), a Contains that
 *   makes a cycle, and the same Contains twice (naming the existing one). They apply when the ends
 *   or the type change
 *   (add, type change, reverse): a stored model may already break them.
 * - Update and delete carry the relationship's version as read; another one is a conflict.
 */

type IdEdge = JgfEdge & { id: string };

const noun = 'a relationship';
const parse = <T>(schema: z.ZodType<T>, input: unknown): T => parseRequest(schema, input, noun);

const endSchema = (message: string) =>
  z
    .string({ error: message })
    .min(1, { error: message })
    .max(maxElementIdLength, { error: message });
const typeSchema = z.enum(edgeTypes, { error: `Must be one of ${edgeTypes.join(', ')}.` });
const stateSchema = z.enum(architectureStates, {
  error: `Must be one of ${architectureStates.join(', ')}.`,
});
const tooLong = `Must be at most ${maxRelationshipDescriptionLength} characters.`;
const labelTooLong = `Must be at most ${maxRelationshipLabelLength} characters.`;
const valueTooLong = `Must be at most ${maxPropertyValueLength} characters.`;

/** Custom metadata: the count and the keys here; the values are checked against the stored ones. */
const metadataSchema = z
  .record(z.string(), z.unknown(), { error: 'Must be an object.' })
  .superRefine((record, ctx) => {
    const keys = Object.keys(record);
    if (keys.length > maxMetadataEntries) {
      ctx.addIssue({
        code: 'custom',
        message: `Send at most ${maxMetadataEntries} entries in one change.`,
      });
      return;
    }
    for (const key of keys) {
      const problem =
        key === retiredInformationFlowKey
          ? 'This key is reserved.'
          : // Removing one kept from before (where Request Data had a value) is fine.
            key === retiredDataKey && record[key] !== null
            ? 'This key is reserved: Data is now Request Data and Response Data.'
            : key === 'description' ||
                key === 'architectureState' ||
                // Removing one kept as custom metadata (on a Contains) is fine.
                (isRelationTextProperty(key) && record[key] !== null)
              ? 'Set this in its own field.'
              : keyProblem(key);
      if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem, path: [key] });
    }
  });

/** Why a custom value can't be stored, or undefined. A value equal to the stored one is fine. */
function customValueProblem(value: unknown, stored: Entries, key: string): string | undefined {
  if (value === null || (Object.hasOwn(stored, key) && sameValue(stored[key], value))) {
    return undefined;
  }
  if (typeof value !== 'string') return 'Must be text.';
  return value.length > maxPropertyValueLength ? valueTooLong : undefined;
}

const newRelationshipSchema = z.strictObject({
  source: endSchema('Choose the source element.'),
  target: endSchema('Choose the target element.'),
  type: typeSchema,
  architectureState: stateSchema.optional(),
  description: z
    .string({ error: 'Must be text.' })
    .max(maxRelationshipDescriptionLength, { error: tooLong })
    .optional(),
});

// The description's and label's lengths are checked when they change: an imported one may be longer.
const updateRelationshipSchema = z.strictObject({
  version: versionSchema,
  type: typeSchema.optional(),
  architectureState: stateSchema.optional(),
  description: z.string({ error: 'Must be text.' }).nullable().optional(),
  label: z.string({ error: 'Must be text.' }).nullable().optional(),
  reverse: z.boolean({ error: 'Must be true or false.' }).optional(),
  twoWay: z.boolean({ error: 'Must be true or false.' }).optional(),
  identity: z.string({ error: 'Must be text.' }).nullable().optional(),
  identityContext: z.string({ error: 'Must be text.' }).nullable().optional(),
  requestData: z.string({ error: 'Must be text.' }).nullable().optional(),
  responseData: z.string({ error: 'Must be text.' }).nullable().optional(),
  metadata: metadataSchema.optional(),
});

/** A validation field of the edge as the request names it. */
function requestField(field: string): string {
  if (field === 'relation') return 'type';
  if (field === 'metadata.architectureState') return 'architectureState';
  if (field === 'metadata.description') return 'description';
  const key = field.slice('metadata.'.length);
  if (field.startsWith('metadata.') && isRelationTextProperty(key)) return key;
  if (field === 'label') return 'label';
  if (field.startsWith('metadata.')) return field;
  return field === 'source' || field === 'target' ? field : '';
}

/** The edge, its position and version, or NotFoundError. Only edges with an id are editable. */
function currentRelationship(
  model: EditableModel,
  relationshipId: string,
): { edge: IdEdge; index: number; version: number } {
  const edges = model.document.graph.edges ?? [];
  const index = edges.findIndex((edge) => edge.id === relationshipId);
  const version = model.relationshipVersionOf(relationshipId);
  if (index === -1 || version === undefined) throw new NotFoundError('relationship');
  return { edge: edges[index] as IdEdge, index, version };
}

/** The document with `edge` at `index`, or added last when `index` is undefined. */
function withEdge(document: JgfDocument, edge: JgfEdge, index?: number): JgfDocument {
  const edges = [...(document.graph.edges ?? [])];
  if (index === undefined) edges.push(edge);
  else edges[index] = edge;
  return { graph: { ...document.graph, edges } };
}

function withoutEdge(document: JgfDocument, index: number): JgfDocument {
  const edges = (document.graph.edges ?? []).filter((_, at) => at !== index);
  return { graph: { ...document.graph, edges } };
}

/**
 * The Modelling-only rules (`relationshipProblems`) for `edge` against the model before the
 * change, leaving out the relationship being changed (`ignore`).
 */
function refuseModellingProblems(
  before: JgfDocument,
  edge: IdEdge,
  field: string,
  ignore?: string,
): void {
  const type = edge.relation;
  if (!isEdgeType(type)) return; // validation has refused it already
  const candidate = {
    source: edge.source,
    target: edge.target,
    type,
    ...(ignore ? { ignore } : {}),
  };
  const [problem] = relationshipProblems(buildModelGraph(before), candidate);
  if (problem === undefined) return;
  const duplicateOf = problem.kind === 'duplicate' ? problem.duplicateOf : undefined;
  throw new RejectedError([{ field, message: problem.message }], duplicateOf);
}

/** Warnings about the edge, and about its target having several containers (Contains). */
function warningsFor(validation: JgfValidationResult, edge: IdEdge): ValidationIssue[] {
  const id = issueId(edge.id);
  const target = issueId(edge.target);
  return validation.warnings.filter(
    (issue) =>
      issue.edgeId === id ||
      (edge.relation === containsType &&
        issue.nodeId === target &&
        issue.code === 'multiple-containers'),
  );
}

/** Every element drawn inside another container (or none) after the change than before. */
function nestingChanges(before: JgfDocument, after: JgfDocument): NestingChange[] {
  const old = buildModelGraph(before);
  const now = buildModelGraph(after);
  const changes: NestingChange[] = [];
  for (const elementId of now.elements.keys()) {
    const containerId = containerOf(now, elementId);
    if (containerOf(old, elementId) !== containerId) {
      changes.push({ elementId, containerId: containerId ?? null });
    }
  }
  return changes;
}

export class RelationshipService {
  readonly #store: ModelStore;

  constructor(store: ModelStore) {
    this.#store = store;
  }

  #elements(): ElementStore {
    const elements = this.#store.elements;
    if (elements === undefined) throw new EditingUnavailableError();
    return elements;
  }

  /** One relationship with its version, for the editing form. */
  async getRelationship(
    modelId: string,
    relationshipId: string,
  ): Promise<RelationshipChangeResult> {
    const model = await this.#elements().read(modelId);
    if (model === undefined) throw new NotFoundError('model');
    const { edge, version } = currentRelationship(model, relationshipId);
    return {
      relationship: { id: relationshipId, version, edge },
      warnings: warningsFor(model.validation, edge),
      nestingChanges: [],
    };
  }

  async addRelationship(
    modelId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<RelationshipChangeResult> {
    const elements = this.#elements();
    const request = parse(newRelationshipSchema, input);
    const id = randomUUID();
    const metadata: Entries = {
      architectureState: request.architectureState ?? defaultArchitectureState,
    };
    const fields = ['source', 'target', 'type', 'architectureState'];
    if (request.description !== undefined) {
      metadata.description = request.description;
      fields.push('description');
    }
    const edge: IdEdge = {
      id,
      source: request.source,
      target: request.target,
      relation: request.type,
      directed: true,
      metadata,
    };
    let warnings: ValidationIssue[] = [];
    let nesting: NestingChange[] = [];
    const applied = await elements.change(modelId, (model) => {
      const nodes = model.document.graph.nodes ?? {};
      for (const end of ['source', 'target'] as const) {
        if (!Object.hasOwn(nodes, edge[end])) throw new NotFoundError(end);
      }
      const document = withEdge(model.document, edge);
      const validation = validateJgf(document);
      refuseErrors(validation, { kind: 'edge', id }, requestField);
      refuseModellingProblems(model.document, edge, 'target');
      warnings = warningsFor(validation, edge);
      nesting = nestingChanges(model.document, document);
      const write = { kind: 'put-relationship', relationshipId: id, edge } as const;
      return plan(write, document, 'relationship-added', actor, fields);
    });
    if (applied === undefined) throw new NotFoundError('model');
    return {
      relationship: { id, version: applied.version ?? 1, edge },
      warnings,
      nestingChanges: nesting,
    };
  }

  async updateRelationship(
    modelId: string,
    relationshipId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<RelationshipChangeResult> {
    const elements = this.#elements();
    const request = parse(updateRelationshipSchema, input);
    let stored: StoredRelationship | undefined;
    let warnings: ValidationIssue[] = [];
    let nesting: NestingChange[] = [];
    try {
      const applied = await elements.change(modelId, (model) => {
        const current = currentRelationship(model, relationshipId);
        if (current.version !== request.version) {
          throw new ConflictError(current.version, relationshipConflictMessage);
        }
        const before = current.edge.metadata;
        const metadata: Entries = isEntries(before) ? { ...before } : {};
        const changed: string[] = [];
        const issues: RelationshipFieldIssue[] = [];
        let { source, target, relation } = current.edge;
        if (request.type !== undefined && request.type !== relation) {
          relation = request.type;
          changed.push('type');
        }
        if (request.architectureState !== undefined) {
          const state = request.architectureState;
          apply(metadata, 'architectureState', state, 'architectureState', changed);
        }
        if (request.description !== undefined) {
          const { description } = request;
          if (
            description !== null &&
            description.length > maxRelationshipDescriptionLength &&
            !sameValue(before?.description, description)
          ) {
            issues.push({ field: 'description', message: tooLong });
          }
          apply(metadata, 'description', description, 'description', changed);
        }
        for (const [key, value] of Object.entries(request.metadata ?? {})) {
          const problem = customValueProblem(value, metadata, key);
          if (problem !== undefined) issues.push({ field: `metadata.${key}`, message: problem });
          apply(metadata, key, value, `metadata.${key}`, changed);
        }
        // Identity, Identity Context, Request Data and Response Data: trimmed text, and blank
        // removes the key. A change to
        // a type without them removes them.
        const textFits = (key: (typeof relationTextProperties)[number]) =>
          !isEdgeType(relation) || hasStandardEdgeProperty(key, relation);
        for (const key of relationTextProperties) {
          const sent = request[key];
          if (sent === undefined) {
            if (!textFits(key) && changed.includes('type')) {
              apply(metadata, key, null, key, changed);
            }
            continue;
          }
          const text = sent === null ? '' : sent.trim();
          if (text !== '' && !textFits(key)) {
            const label = standardProperties[key].label;
            issues.push({ field: key, message: `A ${String(relation)} can't have ${label}.` });
          } else if (text.length > maxPropertyValueLength && !sameValue(before?.[key], text)) {
            issues.push({ field: key, message: valueTooLong });
          }
          apply(metadata, key, text === '' ? null : text, key, changed);
        }
        // Blank removes the label from the edge.
        const label = request.label === undefined ? undefined : (request.label ?? '').trim();
        if (label !== undefined && label !== (current.edge.label ?? '')) {
          if (label.length > maxRelationshipLabelLength) {
            issues.push({ field: 'label', message: labelTooLong });
          }
          changed.push('label');
        }
        // Two-way is stored as `"directed": false`. A type that can't be two-way
        // (Contains) is always one-way: a change to it sets one way.
        const wasTwoWay = current.edge.directed === false;
        let twoWay = request.twoWay ?? wasTwoWay;
        if (isEdgeType(relation) && !canBeTwoWay(relation)) {
          if (request.twoWay === true) {
            issues.push({ field: 'twoWay', message: `${relation} is always one way.` });
          }
          twoWay = false;
        }
        if (twoWay !== wasTwoWay) changed.push('directed');
        // A relationship from an element to itself has nothing to reverse.
        const reversed = request.reverse === true && source !== target;
        if (reversed) {
          [source, target] = [target, source];
          changed.push('source', 'target');
        }
        if (issues.length > 0) throw new RejectedError(issues);
        if (changed.length === 0) {
          throw new Unchanged<RelationshipChangeResult>({
            relationship: { id: relationshipId, version: current.version, edge: current.edge },
            warnings: warningsFor(model.validation, current.edge),
            nestingChanges: [],
          });
        }

        const keepsNoMetadata = before === undefined && Object.keys(metadata).length === 0;
        const edge: IdEdge = {
          ...current.edge,
          source,
          target,
          ...(relation === undefined ? {} : { relation }),
          ...(twoWay === wasTwoWay ? {} : { directed: !twoWay }),
          ...(keepsNoMetadata ? {} : { metadata }),
        };
        if (changed.includes('label')) {
          if (label) edge.label = label;
          else delete edge.label;
        }
        const document = withEdge(model.document, edge, current.index);
        const validation = validateJgf(document);
        refuseErrors(validation, { kind: 'edge', id: relationshipId }, requestField);
        if (reversed || changed.includes('type')) {
          const field = reversed ? 'reverse' : 'type';
          refuseModellingProblems(model.document, edge, field, relationshipId);
        }
        warnings = warningsFor(validation, edge);
        nesting = nestingChanges(model.document, document);
        stored = { id: relationshipId, version: current.version, edge };
        const action = reversed ? 'relationship-reversed' : 'relationship-updated';
        const write = { kind: 'put-relationship', relationshipId, edge } as const;
        return plan(write, document, action, actor, changed);
      });
      if (applied === undefined) throw new NotFoundError('model');
      if (stored === undefined || applied.version === undefined) {
        throw new Error('no relationship written');
      }
      return {
        relationship: { ...stored, version: applied.version },
        warnings,
        nestingChanges: nesting,
      };
    } catch (error) {
      if (error instanceof Unchanged) return error.result as RelationshipChangeResult;
      throw error;
    }
  }

  async deleteRelationship(
    modelId: string,
    relationshipId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<DeletedRelationshipResult> {
    const elements = this.#elements();
    const { version } = parse(deleteSchema, input);
    let nesting: NestingChange[] = [];
    const applied = await elements.change(modelId, (model) => {
      const current = currentRelationship(model, relationshipId);
      if (current.version !== version) {
        throw new ConflictError(current.version, relationshipConflictMessage);
      }
      const document = withoutEdge(model.document, current.index);
      refuseErrors(validateJgf(document), { kind: 'edge', id: relationshipId }, requestField);
      nesting = nestingChanges(model.document, document);
      const write = { kind: 'delete-relationship', relationshipId } as const;
      return plan(write, document, 'relationship-deleted', actor, []);
    });
    if (applied === undefined) throw new NotFoundError('model');
    return { id: relationshipId, nestingChanges: nesting };
  }
}

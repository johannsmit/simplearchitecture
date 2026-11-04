import { randomUUID } from 'node:crypto';
import {
  buildModelGraph,
  childrenOf,
  containerOf,
  isNodeType,
  isStandardPropertyOf,
  nodeTypeKey,
  nodeTypes,
  type DeletedElementResult,
  type ElementChangeResult,
  type ElementFieldIssue,
  type JgfDocument,
  type JgfNode,
  type JgfValidationResult,
  type ModelAuthor,
  type NodeType,
  type ValidationIssue,
} from '@simplearchitecture/shared';
import { z } from 'zod';
import { validateJgf } from '../jgf/validate.js';
import {
  maxElementDescriptionLength,
  maxElementNameLength,
  maxListEntries,
  maxMetadataEntries,
  maxPropertyValueLength,
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
  refuseErrors as refuse,
  RejectedError,
  rejectedMessage,
  sameValue,
  Unchanged,
  versionSchema,
  type Entries,
} from './common.js';

// The names the element routes and tests know.
export {
  ConflictError as ElementConflictError,
  EditingUnavailableError,
  NotFoundError as ElementNotFoundError,
  RejectedError as ElementRejectedError,
  rejectedMessage as elementRejectedMessage,
};
const ElementNotFoundError = NotFoundError;
const ElementConflictError = ConflictError;
const ElementRejectedError = RejectedError;

/**
 * Adding, changing and deleting one element of a stored model: the rules live here, so the REST
 * routes and a future MCP server behave the same. Input is `unknown` and checked here.
 *
 * - Every change is checked against the whole model with the full validation and refused
 *   with field messages when the model would have an error. Warnings never stop a change. The
 *   rules are the existing ones: editing makes no stored model unreadable.
 * - Update and delete carry the element's version as read; another one is a conflict.
 * - Nothing is stored for a refused change, and every stored change has one audit row (the store
 *   writes it in the same transaction).
 */

// Input. Messages stand alone, so the form can show them under the field.

const nameSchema = z
  .string({ error: 'Enter a name.' })
  .trim()
  .min(1, { error: 'Enter a name.' })
  .max(maxElementNameLength, { error: `Must be at most ${maxElementNameLength} characters.` });
const typeSchema = z.enum(nodeTypes, { error: `Must be one of ${nodeTypes.join(', ')}.` });
const descriptionSchema = z.string({ error: 'Must be text.' }).max(maxElementDescriptionLength, {
  error: `Must be at most ${maxElementDescriptionLength} characters.`,
});
const tooLong = `Must be at most ${maxPropertyValueLength} characters.`;

/** A standard property value: text, or a list of text (Functions). The validation checks which. */
function propertyValueProblem(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > maxPropertyValueLength ? tooLong : undefined;
  if (Array.isArray(value)) {
    if (value.length > maxListEntries) return `Must have at most ${maxListEntries} values.`;
    if (!value.every((entry) => typeof entry === 'string')) return 'Must be a list of text values.';
    return value.some((entry) => entry.length > maxPropertyValueLength) ? tooLong : undefined;
  }
  return 'Must be text, or a list of text for Functions.';
}

/** Metadata entries: the count and the keys here; the values need the type (see valueProblem). */
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
        key === 'description' ? 'Set the description in its own field.' : keyProblem(key);
      if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem, path: [key] });
    }
  });

const newElementSchema = z.strictObject({
  type: typeSchema,
  name: nameSchema,
  description: descriptionSchema.optional(),
  metadata: metadataSchema.optional(),
});

// Lengths are checked in the plan, on changed values only: an imported value may be longer and
// is sent back unchanged by the form.
const updateElementSchema = z.strictObject({
  version: versionSchema,
  name: z.string({ error: 'Enter a name.' }).trim().optional(),
  type: typeSchema.optional(),
  description: z.string({ error: 'Must be text.' }).nullable().optional(),
  metadata: metadataSchema.optional(),
});

const parse = <T>(schema: z.ZodType<T>, input: unknown): T =>
  parseRequest(schema, input, 'an element');

// The model.

/** The node and version of an element, or ElementNotFoundError. */
function currentElement(
  model: EditableModel,
  elementId: string,
): { node: JgfNode; version: number } {
  const nodes = model.document.graph.nodes ?? {};
  const version = model.versionOf(elementId);
  if (!Object.hasOwn(nodes, elementId) || version === undefined) {
    throw new ElementNotFoundError('element');
  }
  return { node: nodes[elementId] as JgfNode, version };
}

/** The document with `node` in place of the element (or added last). Order is kept. */
function withNode(document: JgfDocument, elementId: string, node: JgfNode): JgfDocument {
  const nodes = document.graph.nodes ?? {};
  const list = Object.entries(nodes);
  const updated = Object.hasOwn(nodes, elementId)
    ? list.map(([id, other]): [string, JgfNode] => [id, id === elementId ? node : other])
    : [...list, [elementId, node] as [string, JgfNode]];
  return { graph: { ...document.graph, nodes: Object.fromEntries(updated) } };
}

function warningsFor(validation: JgfValidationResult, elementId: string): ValidationIssue[] {
  const id = issueId(elementId);
  return validation.warnings.filter((issue) => issue.nodeId === id);
}

/** A validation field of the element as the request names it. */
function requestField(field: string): string {
  if (field === 'label') return 'name';
  if (field === `metadata.${nodeTypeKey}`) return 'type';
  if (field === 'metadata.description') return 'description';
  return field;
}

/**
 * Why a metadata value can't be stored for a `type` element, or undefined. A value equal to the
 * stored one is always fine (nothing changes). Standard properties: text, or a list of text (the
 * validation checks which). Custom metadata: text.
 */
function valueProblem(
  type: NodeType,
  key: string,
  value: unknown,
  current: Entries,
): string | undefined {
  if (Object.hasOwn(current, key) && sameValue(current[key], value)) return undefined;
  if (isStandardPropertyOf(type, key)) return propertyValueProblem(value);
  if (typeof value !== 'string') return 'Must be text.';
  return value.length > maxPropertyValueLength ? tooLong : undefined;
}

/** Refuses a change that gives the model an error, naming the fields of this element. */
function refuseErrors(validation: JgfValidationResult, elementId: string): void {
  refuse(validation, { kind: 'node', id: elementId }, requestField);
}

export class ElementService {
  readonly #store: ModelStore;

  constructor(store: ModelStore) {
    this.#store = store;
  }

  /** Whether elements can be edited (the store is PostgreSQL). */
  get editable(): boolean {
    return this.#store.elements !== undefined;
  }

  #elements(): ElementStore {
    const elements = this.#store.elements;
    if (elements === undefined) throw new EditingUnavailableError();
    return elements;
  }

  /** One element with its version, for the editing form. */
  async getElement(modelId: string, elementId: string): Promise<ElementChangeResult> {
    const model = await this.#elements().read(modelId);
    if (model === undefined) throw new ElementNotFoundError('model');
    const { node, version } = currentElement(model, elementId);
    return {
      element: { id: elementId, version, node },
      warnings: warningsFor(model.validation, elementId),
    };
  }

  async addElement(
    modelId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<ElementChangeResult> {
    const elements = this.#elements();
    const request = parse(newElementSchema, input);
    const { type } = request;
    const fields = ['name', 'type'];
    const metadata: Entries = { [nodeTypeKey]: type };
    const issues: ElementFieldIssue[] = [];
    if (request.description !== undefined) {
      metadata.description = request.description;
      fields.push('description');
    }
    for (const [key, value] of Object.entries(request.metadata ?? {})) {
      const problem = valueProblem(type, key, value, {});
      if (problem !== undefined) issues.push({ field: `metadata.${key}`, message: problem });
      metadata[key] = value;
      fields.push(`metadata.${key}`);
    }
    if (issues.length > 0) throw new ElementRejectedError(issues);

    const id = randomUUID();
    const node: JgfNode = { label: request.name, metadata };
    let warnings: ValidationIssue[] = [];
    const applied = await elements.change(modelId, (model) => {
      const document = withNode(model.document, id, node);
      const validation = validateJgf(document);
      refuseErrors(validation, id);
      warnings = warningsFor(validation, id);
      return plan({ kind: 'put', elementId: id, node }, document, 'element-added', actor, fields);
    });
    if (applied === undefined) throw new ElementNotFoundError('model');
    return { element: { id, version: applied.version ?? 1, node }, warnings };
  }

  async updateElement(
    modelId: string,
    elementId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<ElementChangeResult> {
    const elements = this.#elements();
    const request = parse(updateElementSchema, input);
    let node: JgfNode | undefined;
    let warnings: ValidationIssue[] = [];
    try {
      const applied = await elements.change(modelId, (model) => {
        const current = currentElement(model, elementId);
        if (current.version !== request.version) throw new ElementConflictError(current.version);
        const metadata: Entries = isEntries(current.node.metadata)
          ? { ...current.node.metadata }
          : {};
        const stored = { ...metadata };
        const oldType = isNodeType(metadata[nodeTypeKey]) ? metadata[nodeTypeKey] : undefined;
        // A valid model always has a type; the fallback only keeps TypeScript content.
        const type = request.type ?? oldType ?? 'Other';
        const changed: string[] = [];
        const issues: ElementFieldIssue[] = [];
        let label = current.node.label;
        if (request.name !== undefined && request.name !== label) {
          label = request.name;
          changed.push('name');
          if (label.length > maxElementNameLength) {
            issues.push({
              field: 'name',
              message: `Must be at most ${maxElementNameLength} characters.`,
            });
          }
        }
        // Required after every change, even for an imported element that had no name.
        if (label === undefined || label.trim() === '') {
          issues.push({ field: 'name', message: 'Enter a name.' });
        }
        // Standard properties the new type doesn't have stay as they are: custom metadata now.
        if (request.type !== undefined) apply(metadata, nodeTypeKey, request.type, 'type', changed);
        if (request.description !== undefined) {
          const { description } = request;
          if (
            description !== null &&
            description.length > maxElementDescriptionLength &&
            !sameValue(stored.description, description)
          ) {
            issues.push({
              field: 'description',
              message: `Must be at most ${maxElementDescriptionLength} characters.`,
            });
          }
          apply(metadata, 'description', description, 'description', changed);
        }
        for (const [key, value] of Object.entries(request.metadata ?? {})) {
          const problem = value === null ? undefined : valueProblem(type, key, value, stored);
          if (problem !== undefined) issues.push({ field: `metadata.${key}`, message: problem });
          apply(metadata, key, value, `metadata.${key}`, changed);
        }
        if (issues.length > 0) throw new ElementRejectedError(issues);
        if (changed.length === 0) {
          throw new Unchanged({
            element: { id: elementId, version: current.version, node: current.node },
            warnings: warningsFor(model.validation, elementId),
          });
        }

        // A valid node has no other fields (JGF v2).
        node = label === undefined ? { metadata } : { label, metadata };
        const document = withNode(model.document, elementId, node);
        const validation = validateJgf(document);
        refuseErrors(validation, elementId);
        warnings = warningsFor(validation, elementId);
        return plan({ kind: 'put', elementId, node }, document, 'element-updated', actor, changed);
      });
      if (applied === undefined) throw new ElementNotFoundError('model');
      if (node === undefined || applied.version === undefined)
        throw new Error('no element written');
      return { element: { id: elementId, version: applied.version, node }, warnings };
    } catch (error) {
      if (error instanceof Unchanged) return error.result as ElementChangeResult;
      throw error;
    }
  }

  /**
   * Deletes the element with every relationship from or to it. A container's Contains
   * relationships go with it; the elements it contained stay in the model, no longer nested.
   */
  async deleteElement(
    modelId: string,
    elementId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<DeletedElementResult> {
    const elements = this.#elements();
    const { version } = parse(deleteSchema, input);
    let unnested: string[] = [];
    const applied = await elements.change(modelId, (model) => {
      const current = currentElement(model, elementId);
      if (current.version !== version) throw new ElementConflictError(current.version);
      const { graph } = model.document;
      const nodes = Object.entries(graph.nodes ?? {}).filter(([id]) => id !== elementId);
      const document: JgfDocument = {
        graph: {
          ...graph,
          nodes: Object.fromEntries(nodes),
          ...(graph.edges === undefined
            ? {}
            : {
                edges: graph.edges.filter(
                  (edge) => edge.source !== elementId && edge.target !== elementId,
                ),
              }),
        },
      };
      refuseErrors(validateJgf(document), elementId);
      // Drawn inside it before, and inside nothing now (another Contains may still nest one).
      const after = buildModelGraph(document);
      unnested = childrenOf(buildModelGraph(model.document), elementId).filter(
        (child) => containerOf(after, child) === undefined,
      );
      return plan({ kind: 'delete', elementId }, document, 'element-deleted', actor, []);
    });
    if (applied === undefined) throw new ElementNotFoundError('model');
    return {
      id: elementId,
      deletedRelationshipCount: applied.deletedRelationships.length,
      deletedRelationshipIds: applied.deletedRelationships.flatMap((edge) =>
        edge.id === null ? [] : [edge.id],
      ),
      unnestedElementIds: unnested,
    };
  }
}

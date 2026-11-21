import { randomUUID } from 'node:crypto';
import {
  buildModelGraph,
  checkStandardProperty,
  childrenOf,
  containerOf,
  elementKeyRole,
  isNodeType,
  isReference,
  isStandardPropertyOf,
  nodeTypeKey,
  nodeTypes,
  referenceProblem,
  standardProperties,
  withoutReferenceTo,
  type DeletedElementResult,
  type ElementChangeResult,
  type ElementFieldIssue,
  type ElementPropertyDefinition,
  type JgfDocument,
  type JgfNode,
  type JgfValidationResult,
  type ModelAuthor,
  type NodeType,
  type StandardPropertyDefinition,
  type StandardPropertyKey,
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
import type { EditableModel, ModelStore } from '../storage/model-store.js';
import {
  apply,
  ConflictError,
  deleteSchema,
  isEntries,
  issueId,
  keyProblem,
  NotFoundError,
  parse as parseRequest,
  plan,
  refuseErrors as refuse,
  RejectedError,
  rejectedMessage,
  reservedKeyProblem,
  sameValue,
  Unchanged,
  versionSchema,
  type Entries,
} from './common.js';

// The names the element routes and tests know.
export {
  ConflictError as ElementConflictError,
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
 * - Metadata takes the type's standard properties, the element properties an Admin defined, and
 *   keys the element holds already (such as a standard property of its type before a type change:
 *   "Was a property"); no new key, for anyone (`metadataProblem`). The definitions are read,
 *   and the ones set share-locked, in the change's transaction, so a property deleted meanwhile is
 *   never set.
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

/**
 * A new value of a property whose odd stored values the validation only warns about (Kind, read as
 * Human) must still be one of its options. The validation refuses the other properties' values.
 */
function readAsChoiceProblem(key: StandardPropertyKey, value: unknown): string | undefined {
  if ((standardProperties[key] as StandardPropertyDefinition).readAs === undefined)
    return undefined;
  const check = checkStandardProperty(key, value);
  if (check.ok) return undefined;
  return `${check.problem.charAt(0).toUpperCase()}${check.problem.slice(1)}.`;
}

/**
 * Metadata entries: the count and the reserved keys here. A key's length and a blank key are
 * checked with the element (`metadataProblem`): a key the element holds can always be set or
 * removed, as an import may once have brought a blank or very long one. The values need the type.
 */
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
        key === 'description' ? 'Set the description in its own field.' : reservedKeyProblem(key);
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
 * Whom a Reference may name: the element's own id (undefined for a new element) and whether an id
 * is an element of the model.
 */
interface ReferenceScope {
  ownId: string | undefined;
  isElement: (id: string) => boolean;
}

/** The model's elements, as a Reference sees them. */
function scopeOf(document: JgfDocument, ownId: string | undefined): ReferenceScope {
  const nodes = document.graph.nodes ?? {};
  return { ownId, isElement: (id) => Object.hasOwn(nodes, id) };
}

/** Why a value can't be set under an element property, by its kind. */
function definedValueProblem(
  definition: ElementPropertyDefinition,
  value: unknown,
  scope: ReferenceScope,
): string | undefined {
  switch (definition.kind) {
    case 'reference':
      return referenceProblem(value, scope.ownId, scope.isElement);
    case 'choice': {
      const options = definition.options ?? [];
      return typeof value === 'string' && options.includes(value)
        ? undefined
        : `Pick one of ${options.join(', ')}.`;
    }
    case 'text':
      if (typeof value !== 'string') return 'Must be text.';
      return value.length > maxPropertyValueLength ? tooLong : undefined;
  }
}

export const notAnElementPropertyMessage = (key: string): string =>
  `“${key}” isn't a property here. An Admin can add it in Admin → Properties.`;

/**
 * Why a metadata entry of a change can't be stored for a `type` element, or undefined. Removing a
 * value (`null`) and a value equal to the stored one are always fine (nothing new is set); a key
 * the element doesn't hold must still be a name a person can type. Otherwise the key must be a
 * standard property of the type (text, or a list of text: the validation checks which), an
 * element property (`definitions`) whose value fits its kind, or a key the element holds already
 * (a standard property of another type, "Was a property": text or a list of text). No other key
 * can be set.
 */
function metadataProblem(
  type: NodeType,
  key: string,
  value: unknown,
  current: Entries,
  scope: ReferenceScope,
  definitions: readonly ElementPropertyDefinition[],
): string | undefined {
  const held = Object.hasOwn(current, key);
  const problem = held ? undefined : keyProblem(key);
  if (problem !== undefined || value === null) return problem;
  if (held && sameValue(current[key], value)) return undefined;
  const role = elementKeyRole(type, key, definitions);
  switch (role.role) {
    case 'standard':
      return propertyValueProblem(value) ?? readAsChoiceProblem(key as StandardPropertyKey, value);
    case 'defined':
      return definedValueProblem(role.definition, value, scope);
    case 'was-property':
      return held
        ? propertyValueProblem(value)
        : `${standardProperties[key as StandardPropertyKey].label} isn't a property of the type ${type}.`;
    case 'custom':
      return held ? propertyValueProblem(value) : notAnElementPropertyMessage(key);
  }
}

/**
 * A type change can't turn a Reference into a standard property of the new type: refused at
 * `type`, naming the field.
 */
function referenceTypeIssues(type: NodeType, metadata: Entries): ElementFieldIssue[] {
  return Object.entries(metadata).flatMap(([key, value]): ElementFieldIssue[] =>
    isStandardPropertyOf(type, key) && isReference(value)
      ? [
          {
            field: 'type',
            message: `“${key}” holds references, which a ${type} can't keep under that name. Remove that field first.`,
          },
        ]
      : [],
  );
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

  /** One element with its version, for the editing form. */
  async getElement(modelId: string, elementId: string): Promise<ElementChangeResult> {
    const model = await this.#store.elements.read(modelId);
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
    const elements = this.#store.elements;
    const request = parse(newElementSchema, input);
    const { type } = request;
    const fields = ['name', 'type'];
    const metadata: Entries = { [nodeTypeKey]: type };
    if (request.description !== undefined) {
      metadata.description = request.description;
      fields.push('description');
    }
    for (const [key, value] of Object.entries(request.metadata ?? {})) {
      metadata[key] = value;
      fields.push(`metadata.${key}`);
    }

    const id = randomUUID();
    const node: JgfNode = { label: request.name, metadata };
    let warnings: ValidationIssue[] = [];
    const metadataKeys = Object.keys(request.metadata ?? {});
    const applied = await elements.change(
      modelId,
      (model) => {
        // Checked with the model: the definitions, and the elements a Reference names.
        const scope = scopeOf(model.document, id);
        const definitions = model.elementProperties;
        const issues = Object.entries(request.metadata ?? {}).flatMap(
          ([key, value]): ElementFieldIssue[] => {
            const problem = metadataProblem(type, key, value, {}, scope, definitions);
            return problem === undefined ? [] : [{ field: `metadata.${key}`, message: problem }];
          },
        );
        if (issues.length > 0) throw new ElementRejectedError(issues);
        const document = withNode(model.document, id, node);
        const validation = validateJgf(document);
        refuseErrors(validation, id);
        warnings = warningsFor(validation, id);
        return plan({ kind: 'put', elementId: id, node }, document, 'element-added', actor, fields);
      },
      { elementPropertyKeys: metadataKeys },
    );
    if (applied === undefined) throw new ElementNotFoundError('model');
    return { element: { id, version: applied.version ?? 1, node }, warnings };
  }

  async updateElement(
    modelId: string,
    elementId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<ElementChangeResult> {
    const elements = this.#store.elements;
    const request = parse(updateElementSchema, input);
    let node: JgfNode | undefined;
    let warnings: ValidationIssue[] = [];
    try {
      const applied = await elements.change(
        modelId,
        (model) => {
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
          if (request.type !== undefined)
            apply(metadata, nodeTypeKey, request.type, 'type', changed);
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
          const scope = scopeOf(model.document, elementId);
          const definitions = model.elementProperties;
          for (const [key, value] of Object.entries(request.metadata ?? {})) {
            const problem = metadataProblem(type, key, value, stored, scope, definitions);
            if (problem !== undefined) issues.push({ field: `metadata.${key}`, message: problem });
            apply(metadata, key, value, `metadata.${key}`, changed);
          }
          if (request.type !== undefined) issues.push(...referenceTypeIssues(type, metadata));
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
          return plan(
            { kind: 'put', elementId, node },
            document,
            'element-updated',
            actor,
            changed,
          );
        },
        { elementPropertyKeys: Object.keys(request.metadata ?? {}) },
      );
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
   * relationships go with it; the elements it contained stay in the model, no longer nested. The
   * element is left out of every Reference to it (a field left with none is removed), in the same
   * change: each element that referred to it gets a new version and an audit row of its own.
   */
  async deleteElement(
    modelId: string,
    elementId: string,
    input: unknown,
    actor: ModelAuthor,
  ): Promise<DeletedElementResult> {
    const elements = this.#store.elements;
    const { version } = parse(deleteSchema, input);
    let unnested: string[] = [];
    let referring: string[] = [];
    const applied = await elements.change(modelId, (model) => {
      const current = currentElement(model, elementId);
      if (current.version !== version) throw new ElementConflictError(current.version);
      const { graph } = model.document;
      const references: { elementId: string; node: JgfNode; fields: string[] }[] = [];
      const nodes = Object.entries(graph.nodes ?? {}).flatMap(([id, node]): [string, JgfNode][] => {
        if (id === elementId) return [];
        const cleaned = withoutReferenceTo(node, elementId);
        if (cleaned === undefined) return [[id, node]];
        references.push({
          elementId: id,
          node: cleaned.node,
          fields: cleaned.keys.map((key) => `metadata.${key}`),
        });
        return [[id, cleaned.node]];
      });
      referring = references.map((reference) => reference.elementId);
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
      return plan(
        { kind: 'delete', elementId, referencesRemoved: references },
        document,
        'element-deleted',
        actor,
        [],
      );
    });
    if (applied === undefined) throw new ElementNotFoundError('model');
    return {
      id: elementId,
      deletedRelationshipCount: applied.deletedRelationships.length,
      deletedRelationshipIds: applied.deletedRelationships.flatMap((edge) =>
        edge.id === null ? [] : [edge.id],
      ),
      unnestedElementIds: unnested,
      referencesRemovedFrom: referring,
    };
  }
}

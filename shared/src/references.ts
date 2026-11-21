/**
 * References from an element to other elements of the same model: a custom metadata value of the
 * type Reference. Pure functions, so the API, the MCP tools and the web app read, check and clean
 * references the same way.
 *
 * A reference is stored with the element, by id, in a shape that says what it is:
 *
 *     { "simplearchitecture:reference": ["<node id>", …] }
 *
 * an object whose one key is `referenceKey`, holding a list. The key is in the app's own
 * namespace (`simplearchitecture:`, which no metadata key may use), so no value a model held before
 * references existed has this shape by chance. Any other value (text, a list, another object, also
 * one with that key beside others) is ordinary custom metadata, as before. Only custom keys hold
 * references: a standard property of the element's type never does.
 */
import { compareElements, type ModelElement, type ModelGraph } from './graph.js';
import type { JgfNode } from './jgf.js';
import { isNodeType, isStandardPropertyOf, nodeTypeKey, type NodeType } from './metamodel.js';
import {
  isReference,
  maxReferences,
  referenceIds,
  referenceKey,
  referenceValue,
} from './reference-value.js';

export {
  isMeantAsReference,
  isReference,
  maxReferences,
  referenceIds,
  referenceKey,
  referenceValue,
  type ReferenceValue,
} from './reference-value.js';

/** Whether a metadata key of an element of `type` can hold a reference: a custom key only. */
export function isReferenceKeyOf(type: NodeType, key: string): boolean {
  return key !== nodeTypeKey && !isStandardPropertyOf(type, key);
}

/** One Reference field of an element: its name and the ids it holds. */
export interface ReferenceField {
  key: string;
  ids: readonly string[];
}

/** An element's Reference fields, sorted by key (as `customMetadata`). */
export function elementReferences(element: ModelElement): ReferenceField[] {
  const fields: ReferenceField[] = [];
  for (const [key, value] of Object.entries(element.metadata)) {
    if (!isReferenceKeyOf(element.type, key)) continue;
    const ids = referenceIds(value);
    if (ids !== undefined) fields.push({ key, ids });
  }
  return fields.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** An element that refers to another one, and the field it does so under. */
export interface ReferringElement {
  element: ModelElement;
  key: string;
}

const referencedByCache = new WeakMap<ModelGraph, ReadonlyMap<string, ReferringElement[]>>();

/** Per referenced element, who refers to it: worked out once per graph. */
function referenceIndex(graph: ModelGraph): ReadonlyMap<string, ReferringElement[]> {
  let index = referencedByCache.get(graph);
  if (index !== undefined) return index;
  const built = new Map<string, ReferringElement[]>();
  for (const element of graph.elements.values()) {
    for (const { key, ids } of elementReferences(element)) {
      for (const id of new Set(ids)) {
        if (id === element.id || !graph.elements.has(id)) continue;
        const list = built.get(id);
        if (list) list.push({ element, key });
        else built.set(id, [{ element, key }]);
      }
    }
  }
  for (const list of built.values()) {
    list.sort(
      (a, b) =>
        compareElements(a.element, b.element) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  }
  index = built;
  referencedByCache.set(graph, index);
  return index;
}

/**
 * The elements that refer to an element ("Referenced by"), each with the field it does so under,
 * by name, then id, then field. An element that refers to it under two fields is listed twice.
 */
export function referencedBy(graph: ModelGraph, elementId: string): readonly ReferringElement[] {
  return referenceIndex(graph).get(elementId) ?? [];
}

// Checking a value sent to be stored. Messages stand alone, under the field.

export const referenceMessages = {
  shape: `Must be a reference: {"${referenceKey}": [element ids]}.`,
  ids: 'Must be a list of element ids.',
  empty: 'Choose at least one element, or remove the field.',
  tooMany: `Must refer to at most ${maxReferences} elements.`,
  repeated: 'Refers to the same element more than once.',
  itself: "An element can't refer to itself.",
  missing: "Refers to an element that isn't in this model.",
} as const;

/**
 * Why a value can't be stored as a reference of element `ownId` (undefined for a new element), or
 * undefined: the shape, text ids, at least one and at most `maxReferences`, each once, not the
 * element itself, and each an element of the model (`isElement`).
 */
export function referenceProblem(
  value: unknown,
  ownId: string | undefined,
  isElement: (id: string) => boolean,
): string | undefined {
  if (!isReference(value)) return referenceMessages.shape;
  const ids = value[referenceKey];
  if (!ids.every((id) => typeof id === 'string')) return referenceMessages.ids;
  if (ids.length === 0) return referenceMessages.empty;
  if (ids.length > maxReferences) return referenceMessages.tooMany;
  if (new Set(ids).size !== ids.length) return referenceMessages.repeated;
  if (ownId !== undefined && ids.includes(ownId)) return referenceMessages.itself;
  return ids.every(isElement) ? undefined : referenceMessages.missing;
}

/** The node's type, when it has a known one. */
function typeOf(node: JgfNode): NodeType | undefined {
  const type = node.metadata?.[nodeTypeKey];
  return isNodeType(type) ? type : undefined;
}

/**
 * The node with `removedId` left out of every Reference field, and the fields that changed (a
 * field left with none is removed); undefined when it refers to `removedId` nowhere.
 */
export function withoutReferenceTo(
  node: JgfNode,
  removedId: string,
): { node: JgfNode; keys: string[] } | undefined {
  const type = typeOf(node);
  const metadata = node.metadata;
  if (type === undefined || metadata === undefined) return undefined;
  const keys: string[] = [];
  const entries = Object.entries(metadata).flatMap(([key, value]): [string, unknown][] => {
    const ids = isReferenceKeyOf(type, key) ? referenceIds(value) : undefined;
    if (ids === undefined || !ids.includes(removedId)) return [[key, value]];
    keys.push(key);
    const kept = ids.filter((id) => id !== removedId);
    return kept.length > 0 ? [[key, referenceValue(kept)]] : [];
  });
  // fromEntries defines own properties, in the order they were.
  return keys.length === 0
    ? undefined
    : { node: { ...node, metadata: Object.fromEntries(entries) }, keys };
}

/**
 * What an import left out of the Reference fields under one key (summed over the model's
 * elements). Only keys with a change are listed.
 */
export interface LeftOutReferences {
  /** The field, as it is stored (after the key rules of the import). */
  key: string;
  /** Elements whose field under this key lost an id or was removed. */
  elements: number;
  /** Ids that aren't elements of the model (or aren't text). */
  notInModel: number;
  /** The element's own id. */
  itself: number;
  /** An id already in the field. */
  repeated: number;
  /** Ids past the `maxReferences`th. */
  overLimit: number;
  /** Fields left with no element, so removed. */
  removed: number;
}

/**
 * The reference rules of an import, for the model's elements (JGF nodes, by id): each Reference
 * field keeps the ids of other elements of the same graph, each once, at most `maxReferences`, in
 * their order; any other id is left out and counted, and a field left with none is removed. Every
 * other value, and the nodes' ids and order, stay exactly as they are.
 */
export function withImportableReferences(nodes: Readonly<Record<string, JgfNode>>): {
  nodes: Record<string, JgfNode>;
  changes: LeftOutReferences[];
} {
  const byKey = new Map<string, LeftOutReferences>();
  const entries = Object.entries(nodes).map(([id, node]): [string, JgfNode] => {
    const type = typeOf(node);
    const metadata = node.metadata;
    if (type === undefined || metadata === undefined) return [id, node];
    const next: [string, unknown][] = [];
    let touched = false;
    for (const [key, value] of Object.entries(metadata)) {
      if (!isReferenceKeyOf(type, key) || !isReference(value)) {
        next.push([key, value]);
        continue;
      }
      const counts = { notInModel: 0, itself: 0, repeated: 0, overLimit: 0 };
      const kept: string[] = [];
      for (const entry of value[referenceKey]) {
        if (typeof entry !== 'string' || !Object.hasOwn(nodes, entry)) counts.notInModel += 1;
        else if (entry === id) counts.itself += 1;
        else if (kept.includes(entry)) counts.repeated += 1;
        else if (kept.length >= maxReferences) counts.overLimit += 1;
        else kept.push(entry);
      }
      if (kept.length > 0 && kept.length === value[referenceKey].length) {
        next.push([key, value]);
        continue;
      }
      touched = true;
      const total = byKey.get(key) ?? {
        key,
        elements: 0,
        notInModel: 0,
        itself: 0,
        repeated: 0,
        overLimit: 0,
        removed: 0,
      };
      total.elements += 1;
      total.notInModel += counts.notInModel;
      total.itself += counts.itself;
      total.repeated += counts.repeated;
      total.overLimit += counts.overLimit;
      if (kept.length === 0) total.removed += 1;
      byKey.set(key, total);
      if (kept.length > 0) next.push([key, referenceValue(kept)]);
    }
    return touched ? [id, { ...node, metadata: Object.fromEntries(next) }] : [id, node];
  });
  const changes = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // fromEntries defines own properties, so no id (not even `__proto__`) is lost.
  return { nodes: changes.length > 0 ? Object.fromEntries(entries) : { ...nodes }, changes };
}

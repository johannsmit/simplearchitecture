/**
 * A viewpoint on the canvas: which relationship properties its lines show. Pure
 * functions, linear in the model size, so the web app and a future MCP server read one the same way.
 */
import { filterValueOf, isFilterableKey } from './filters.js';
import { compareNames, containsType, type ModelGraph, type ModelRelationship } from './graph.js';
import { isRelationTextProperty, relationTextProperties, standardProperties } from './metamodel.js';

/** A property that a viewpoint can show. */
export interface RelationshipViewField {
  /** The metadata key, e.g. `architectureState` or a custom key. */
  key: string;
  /** The standard property's label (e.g. Architecture state), else the key itself. */
  label: string;
}

const stateKey = 'architectureState';

/** The element filter's keys, plus `functions`: only elements have that as a property of their own. */
export const isRelationshipViewKey = (key: string): boolean =>
  key === 'functions' || isFilterableKey(key);

/**
 * A relationship's value for a property as text, or undefined when it doesn't have it. The rules
 * are the element filter's: an empty text, a list or an object counts as not having it. Every
 * relationship has an Architecture state, as none means Current.
 */
export function relationshipValue(
  relationship: ModelRelationship,
  key: string,
): string | undefined {
  return key === stateKey ? relationship.architectureState : filterValueOf(relationship, key);
}

/** The values a line shows for the selected properties, in their order. */
export function relationshipViewValues(
  relationship: ModelRelationship,
  keys: readonly string[],
): string[] {
  return keys.flatMap((key) => relationshipValue(relationship, key) ?? []);
}

/**
 * The properties a viewpoint can show: those found on this model's relationships, plus the standard
 * ones whenever the model has a Relation, sorted by name. Contains isn't part of a viewpoint. A key
 * holding a list or an object on any relationship is left out, as in the element filter, because
 * every value differs.
 */
export function relationshipViewFields(graph: ModelGraph): RelationshipViewField[] {
  const found = new Set<string>();
  const structured = new Set<string>();
  let any = false;
  for (const relationship of graph.relationships) {
    if (relationship.type === containsType) continue;
    any = true;
    for (const [key, value] of Object.entries(relationship.metadata)) {
      if (!isRelationshipViewKey(key) || key === stateKey) continue;
      if (isRelationTextProperty(key)) continue;
      if (typeof value === 'object' && value !== null) structured.add(key);
      else if (relationshipValue(relationship, key) !== undefined) found.add(key);
    }
  }
  const fields = [...found]
    .filter((key) => !structured.has(key))
    .map((key) => ({ key, label: key }));
  if (any) {
    fields.push({ key: stateKey, label: standardProperties[stateKey].label });
    for (const key of relationTextProperties) {
      fields.push({ key, label: standardProperties[key].label });
    }
  }
  return fields.sort((a, b) => compareNames(a.label, b.label) || (a.key < b.key ? -1 : 1));
}

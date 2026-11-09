/**
 * A viewpoint on the canvas: which relationship properties its lines show. Pure
 * functions, linear in the model size, so the web app and a future MCP server read one the same way.
 */
import { filterValueOf, isFilterableKey } from './filters.js';
import { compareNames, containsType, type ModelGraph, type ModelRelationship } from './graph.js';
import {
  isRelationTextProperty,
  relationTextProperties,
  retiredDataKey,
  standardProperties,
} from './metamodel.js';

/** A property that a viewpoint can show. */
export interface RelationshipViewField {
  /** The metadata key, e.g. `architectureState` or a custom key. */
  key: string;
  /** The standard property's label (e.g. Architecture state), else the key itself. */
  label: string;
}

const stateKey = 'architectureState';

/**
 * The Data viewpoint: one choice that shows Request Data and Response Data, each on a line of its
 * own. Its key is the one Data had, so an address or a browser that remembers it keeps working.
 */
export const dataViewKey = retiredDataKey;
const dataViewParts = [
  ['requestData', 'Request'],
  ['responseData', 'Response'],
] as const;
const dataViewKeys = new Set<string>(dataViewParts.map(([key]) => key));

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
  if (key === stateKey) return relationship.architectureState;
  if (key === dataViewKey) return dataViewValue(relationship);
  return filterValueOf(relationship, key);
}

/**
 * The Data viewpoint's value: "Request: …" above "Response: …", on two lines, leaving out a part
 * without a value; undefined when neither has one.
 */
function dataViewValue(relationship: ModelRelationship): string | undefined {
  const lines = dataViewParts.flatMap(([key, prefix]) => {
    const value = filterValueOf(relationship, key)?.replace(/\s+/g, ' ');
    return value === undefined ? [] : [`${prefix}: ${value}`];
  });
  return lines.length === 0 ? undefined : lines.join('\n');
}

/** The values a line shows for the selected properties, in their order. */
export function relationshipViewValues(
  relationship: ModelRelationship,
  keys: readonly string[],
): string[] {
  return keys.flatMap((key) => relationshipValue(relationship, key) ?? []);
}

/**
 * What a line shows for the selected properties: their one-line values joined by " · " on the first
 * line, then Data's lines ("Request: …", "Response: …") each on its own. Empty when the
 * relationship has none of them.
 */
export function relationshipViewText(
  relationship: ModelRelationship,
  keys: readonly string[],
): string {
  const inline: string[] = [];
  const lines: string[] = [];
  for (const key of keys) {
    const value = relationshipValue(relationship, key);
    if (value === undefined) continue;
    if (key === dataViewKey) lines.push(value);
    else inline.push(value);
  }
  return [inline.join(' · '), ...lines].filter((line) => line !== '').join('\n');
}

/**
 * The properties a viewpoint can show: those found on this model's relationships, plus the standard
 * ones whenever the model has a Relation (Request Data and Response Data as one choice, Data),
 * sorted by name. Contains isn't part of a viewpoint. A key
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
      // Leftover Data (kept where Request Data had a value) has no choice: "Data" is the viewpoint.
      if (isRelationTextProperty(key) || key === retiredDataKey) continue;
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
      if (!dataViewKeys.has(key)) fields.push({ key, label: standardProperties[key].label });
    }
    fields.push({ key: dataViewKey, label: 'Data' });
  }
  return fields.sort((a, b) => compareNames(a.label, b.label) || (a.key < b.key ? -1 : 1));
}

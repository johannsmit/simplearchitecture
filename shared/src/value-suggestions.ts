/**
 * The values a metadata property already has in a model, for suggesting while typing.
 * Pure functions, linear in the model size, so the web app and a future MCP server read them the
 * same way. They only read: nothing here changes what is stored or validated.
 */
import { compareText, filterValueOf, isFilterableKey } from './filters.js';
import { normaliseForSearch, type ModelGraph } from './graph.js';
import {
  hasStandardEdgeProperty,
  isStandardPropertyKey,
  isStandardPropertyOf,
  nodeTypes,
  retiredDataKey,
  standardProperties,
} from './metamodel.js';
import { isRelationshipViewKey } from './relationship-views.js';

/** Per metadata key, its values: most used first, then by name. */
export type PropertyValues = ReadonlyMap<string, readonly string[]>;

const isCountryKey = (key: string): boolean =>
  isStandardPropertyKey(key) && standardProperties[key].value.kind === 'country';

/**
 * One value per reading of `filterValueOf`: own keys, text, numbers and true or false, trimmed, with
 * empties, lists and objects skipped value by value. A value with a line break is left out, as a
 * one-line field can't hold it. A country counts as what the field stores: upper case.
 */
function valuesOf(
  items: Iterable<{ metadata: Readonly<Record<string, unknown>> }>,
  isKey: (key: string) => boolean,
  poolOf: (key: string) => string = (key) => key,
): Map<string, readonly string[]> {
  const counts = new Map<string, Map<string, number>>();
  for (const item of items) {
    for (const key of Object.keys(item.metadata)) {
      if (!isKey(key)) continue;
      const read = filterValueOf(item, key);
      if (read === undefined || /[\r\n]/.test(read)) continue;
      const value = isCountryKey(key) ? read.toUpperCase() : read;
      const pool = poolOf(key);
      let values = counts.get(pool);
      if (!values) {
        values = new Map();
        counts.set(pool, values);
      }
      values.set(value, (values.get(value) ?? 0) + 1);
    }
  }
  const result = new Map<string, readonly string[]>();
  for (const [key, values] of counts) {
    const sorted = [...values].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
    result.set(
      key,
      sorted.map(([value]) => value),
    );
  }
  return result;
}

const elementCache = new WeakMap<ModelGraph, PropertyValues>();
const relationshipCache = new WeakMap<ModelGraph, PropertyValues>();

/** What elements hold, worked out once per graph. */
export function elementPropertyValues(graph: ModelGraph): PropertyValues {
  let values = elementCache.get(graph);
  if (values === undefined) {
    values = valuesOf(graph.elements.values(), isFilterableKey);
    elementCache.set(graph, values);
  }
  return values;
}

/**
 * Request Data and Response Data suggest the same values, from both: the same data are often sent
 * one way and returned another.
 */
const dataKeys = new Set<string>(['requestData', 'responseData']);
const dataPool = 'requestData';

/** What relationships hold, apart from elements, worked out once per graph. */
export function relationshipPropertyValues(graph: ModelGraph): PropertyValues {
  let values = relationshipCache.get(graph);
  if (values === undefined) {
    const found = valuesOf(
      graph.relationships,
      (key) => isRelationshipViewKey(key) && key !== 'architectureState',
      (key) => (dataKeys.has(key) ? dataPool : key),
    );
    const data = found.get(dataPool);
    if (data !== undefined) for (const key of dataKeys) found.set(key, data);
    values = found;
    relationshipCache.set(graph, values);
  }
  return values;
}

/**
 * The custom metadata names items use: own keys that `isName` accepts, counted once per item
 * whatever the value, most used first, then by name.
 */
function namesOf(
  items: Iterable<{ metadata: Readonly<Record<string, unknown>> }>,
  isName: (key: string) => boolean,
): string[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const key of Object.keys(item.metadata)) {
      if (isName(key) && !/[\r\n]/.test(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).map(([key]) => key);
}

/** A key an element's form can take as custom metadata: not a standard property of any type. */
const isElementName = (key: string): boolean =>
  isFilterableKey(key) && !nodeTypes.some((type) => isStandardPropertyOf(type, key));

/** A key a relationship's form can take as custom metadata: not one of its own fields, nor Data. */
const isRelationshipName = (key: string): boolean =>
  isRelationshipViewKey(key) &&
  key !== retiredDataKey &&
  !(isStandardPropertyKey(key) && hasStandardEdgeProperty(key));

const elementNameCache = new WeakMap<ModelGraph, readonly string[]>();
const relationshipNameCache = new WeakMap<ModelGraph, readonly string[]>();

/** The custom metadata names elements have, worked out once per graph. */
export function elementMetadataNames(graph: ModelGraph): readonly string[] {
  let names = elementNameCache.get(graph);
  if (names === undefined) {
    names = namesOf(graph.elements.values(), isElementName);
    elementNameCache.set(graph, names);
  }
  return names;
}

/** The custom metadata names relationships have, apart from elements, worked out once per graph. */
export function relationshipMetadataNames(graph: ModelGraph): readonly string[] {
  let names = relationshipNameCache.get(graph);
  if (names === undefined) {
    names = namesOf(graph.relationships, isRelationshipName);
    relationshipNameCache.set(graph, names);
  }
  return names;
}

/**
 * What to offer for what the field holds, in the same order. The value itself is left out, compared
 * exactly. Before any change to the text, or with none, every other value; after a change, those
 * containing the text, ignoring case and accents.
 */
export function suggestedValues(
  values: readonly string[],
  text: string,
  narrow: boolean,
): string[] {
  const others = values.filter((value) => value !== text);
  const needle = narrow ? normaliseForSearch(text.trim()) : '';
  if (needle === '') return others;
  return others.filter((value) => normaliseForSearch(value).includes(needle));
}

/**
 * The values a metadata property already has in a model, for suggesting while typing.
 * Pure functions, linear in the model size, so the web app and a future MCP server read them the
 * same way. They only read: nothing here changes what is stored or validated.
 */
import { compareText, filterValueOf, isFilterableKey } from './filters.js';
import { normaliseForSearch, type ModelGraph } from './graph.js';
import { informationFlowKey, isStandardPropertyKey, standardProperties } from './metamodel.js';
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
): PropertyValues {
  const counts = new Map<string, Map<string, number>>();
  for (const item of items) {
    for (const key of Object.keys(item.metadata)) {
      if (!isKey(key)) continue;
      const read = filterValueOf(item, key);
      if (read === undefined || /[\r\n]/.test(read)) continue;
      const value = isCountryKey(key) ? read.toUpperCase() : read;
      let values = counts.get(key);
      if (!values) {
        values = new Map();
        counts.set(key, values);
      }
      values.set(value, (values.get(value) ?? 0) + 1);
    }
  }
  const result = new Map<string, string[]>();
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

/** What relationships hold, apart from elements, worked out once per graph. */
export function relationshipPropertyValues(graph: ModelGraph): PropertyValues {
  let values = relationshipCache.get(graph);
  if (values === undefined) {
    values = valuesOf(
      graph.relationships,
      (key) =>
        isRelationshipViewKey(key) && key !== 'architectureState' && key !== informationFlowKey,
    );
    relationshipCache.set(graph, values);
  }
  return values;
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

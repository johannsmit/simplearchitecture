/**
 * Filtering elements on their metadata: which fields and values a model has, and which elements
 * match a set of filters. Pure functions, linear in the model size, so the web app's element list
 * and a future MCP server filter the same way.
 */
import { compareNames, normaliseForSearch, type ModelElement, type ModelGraph } from './graph.js';
import {
  isStandardPropertyOf,
  nodeTypeKey,
  nodeTypes,
  standardProperties,
  type StandardPropertyKey,
} from './metamodel.js';

/** A standard property of some element type; a key standard on edges only is custom here. */
const isElementStandardKey = (key: string): key is StandardPropertyKey =>
  nodeTypes.some((type) => isStandardPropertyOf(type, key));

/** One value of a field, with the number of elements that have it. */
export interface FilterValueCount {
  value: string;
  count: number;
}

/** A metadata field that the element list can be filtered on. */
export interface FilterField {
  /** The metadata key, e.g. `architectureState` or a custom key. */
  key: string;
  /** The standard property's label (e.g. Architecture state), else the key itself. */
  label: string;
  /** True for a metamodel standard property, false for custom metadata. */
  standard: boolean;
  /**
   * The values found in the model, counted over the whole model. Choice properties in metamodel
   * order (then other values); other fields by count, high to low, then by name.
   */
  values: FilterValueCount[];
  /** Elements without a value for this field (missing, empty, or not a single value). */
  notSetCount: number;
}

/**
 * Active filters: metadata key → accepted values. `null` stands for "(not set)". A field with no
 * values doesn't filter. Values of one field combine with OR, fields with AND.
 */
export type ElementFilters = Readonly<Record<string, readonly (string | null)[]>>;

/**
 * The values picked for a field. Own keys only: a custom key such as "constructor" must never
 * read an inherited member of the object.
 */
export function pickedValues(filters: ElementFilters, key: string): readonly (string | null)[] {
  return Object.hasOwn(filters, key) ? (filters[key] ?? []) : [];
}

/** Keys that are never filter fields: shown elsewhere, or internal. */
const excludedKeys: ReadonlySet<string> = new Set<string>([
  nodeTypeKey,
  'description',
  'functions',
  'archimateType',
]);
/** Keys the server or app keeps for itself, e.g. `simplearchitecture:stored`. */
const internalPrefix = 'simplearchitecture:';

/** Whether a metadata key can be a filter field. */
export function isFilterableKey(key: string): boolean {
  return !excludedKeys.has(key) && !key.startsWith(internalPrefix);
}

/**
 * The value of a field on an element as filter text, or undefined when it is not set. Text,
 * numbers and true/false count; an empty text, a list or an object is "not set".
 */
export function filterValueOf(
  element: Pick<ModelElement, 'metadata'>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(element.metadata, key)) return undefined;
  const value = element.metadata[key];
  if (typeof value === 'string') {
    const text = value.trim();
    return text === '' ? undefined : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

const standardOrder = Object.keys(standardProperties);

/**
 * The fields the model's elements can be filtered on, with each value's count and a "(not set)"
 * count. Standard properties (except description and functions) come first in metamodel order,
 * then custom keys by name. A key is a field when at least one element has a value for it. A
 * custom key that holds a list or an object on any element is left out (every value differs).
 */
export function filterFields(graph: ModelGraph): FilterField[] {
  const counts = new Map<string, Map<string, number>>();
  const structured = new Set<string>();
  let total = 0;
  for (const element of graph.elements.values()) {
    total += 1;
    for (const key of Object.keys(element.metadata)) {
      if (!isFilterableKey(key)) continue;
      const raw = element.metadata[key];
      if (typeof raw === 'object' && raw !== null && !isElementStandardKey(key)) {
        structured.add(key);
        continue;
      }
      const value = filterValueOf(element, key);
      if (value === undefined) continue;
      let values = counts.get(key);
      if (!values) {
        values = new Map();
        counts.set(key, values);
      }
      values.set(value, (values.get(value) ?? 0) + 1);
    }
  }

  const fields: FilterField[] = [];
  for (const [key, values] of counts) {
    if (structured.has(key)) continue;
    const standard = isElementStandardKey(key);
    const rule = standard ? standardProperties[key].value : undefined;
    const options: readonly string[] = rule?.kind === 'choice' ? rule.options : [];
    const list = [...values].map(([value, count]) => ({ value, count }));
    list.sort((a, b) => {
      const ai = options.indexOf(a.value);
      const bi = options.indexOf(b.value);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
      return b.count - a.count || compareText(a.value, b.value);
    });
    const withValue = list.reduce((sum, entry) => sum + entry.count, 0);
    fields.push({
      key,
      label: standard ? standardProperties[key].label : key,
      standard,
      values: list,
      notSetCount: total - withValue,
    });
  }
  return fields.sort((a, b) => {
    if (a.standard !== b.standard) return a.standard ? -1 : 1;
    if (a.standard) return standardOrder.indexOf(a.key) - standardOrder.indexOf(b.key);
    return compareText(a.key, b.key);
  });
}

export function compareText(a: string, b: string): number {
  return compareNames(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * A field's values (in the field's own order) counted over the elements that match the search
 * and every other field's filter, but not this field's own: what each value would add. One pass
 * over the elements.
 */
export function fieldValueCounts(
  graph: ModelGraph,
  field: Pick<FilterField, 'key' | 'values'>,
  options: { query?: string; filters?: ElementFilters },
): { values: FilterValueCount[]; notSetCount: number } {
  const others: ElementFilters = Object.fromEntries(
    Object.entries(options.filters ?? {}).filter(([key]) => key !== field.key),
  );
  const counts = new Map<string, number>(field.values.map(({ value }) => [value, 0]));
  let notSetCount = 0;
  for (const element of findElements(graph, { ...options, filters: others })) {
    const value = filterValueOf(element, field.key);
    if (value === undefined) notSetCount += 1;
    else counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return { values: [...counts].map(([value, count]) => ({ value, count })), notSetCount };
}

/** The active filters, ready for matching: fields with at least one value. */
function compile(filters: ElementFilters): [string, ReadonlySet<string | null>][] {
  return Object.entries(filters)
    .filter(([, values]) => values.length > 0)
    .map(([key, values]) => [key, new Set(values)]);
}

function matchesCompiled(
  element: ModelElement,
  compiled: [string, ReadonlySet<string | null>][],
): boolean {
  return compiled.every(([key, accepted]) => accepted.has(filterValueOf(element, key) ?? null));
}

/** Whether an element matches the filters: OR within a field, AND across fields. */
export function matchesFilters(element: ModelElement, filters: ElementFilters): boolean {
  return matchesCompiled(element, compile(filters));
}

/** The elements that match the filters (all of them when no filter is active). */
export function filterElements(graph: ModelGraph, filters: ElementFilters): ModelElement[] {
  return findElements(graph, { filters });
}

/**
 * The elements whose name contains `query` (as `searchElements`) AND that match `filters` (as
 * `filterElements`), in one pass.
 */
export function findElements(
  graph: ModelGraph,
  options: { query?: string; filters?: ElementFilters },
): ModelElement[] {
  const needle = normaliseForSearch((options.query ?? '').trim());
  const compiled = compile(options.filters ?? {});
  const result: ModelElement[] = [];
  for (const element of graph.elements.values()) {
    if (needle !== '' && !normaliseForSearch(element.name).includes(needle)) continue;
    if (compiled.length > 0 && !matchesCompiled(element, compiled)) continue;
    result.push(element);
  }
  return result;
}

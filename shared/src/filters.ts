/**
 * Filtering elements on their metadata: which fields and values a model has, and which elements
 * match a set of filters. Pure functions, linear in the model size, so the web app's element list
 * and a future MCP server filter the same way.
 */
import { elementDefinitionOf, type ElementPropertyDefinition } from './element-properties.js';
import { compareNames, normaliseForSearch, type ModelElement, type ModelGraph } from './graph.js';
import {
  isStandardPropertyOf,
  nodeTypeKey,
  nodeTypes,
  standardProperties,
  type StandardPropertyDefinition,
  type StandardPropertyKey,
} from './metamodel.js';
import { isReference } from './reference-value.js';

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
  /**
   * The standard property's label (e.g. Architecture state), an element property's name, else the
   * key itself.
   */
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

/** What a missing value of an element property reads as (Kind: Human), if anything. */
function readAsOf(key: string): string | undefined {
  if (!isElementStandardKey(key)) return undefined;
  return (standardProperties[key] as StandardPropertyDefinition).readAs;
}

/**
 * Whether an element counts for a field: always, except for a property read as an option when not
 * set (Kind), which counts only on the types that have it (Stakeholder).
 */
function countsFor(element: ModelElement, key: string, readAs: string | undefined): boolean {
  return readAs === undefined || isStandardPropertyOf(element.type, key);
}

/** An element's value of a field as the filter reads it: Kind not set (or not text) is Human. */
function elementFilterValue(
  element: ModelElement,
  key: string,
  readAs: string | undefined,
): string | undefined {
  return filterValueOf(element, key) ?? readAs;
}

/**
 * The fields the model's elements can be filtered on, with each value's count and a "(not set)"
 * count. Standard properties (except description and functions) come first in metamodel order,
 * then custom keys by name. A key is a field when at least one element has a value for it. A
 * custom key that holds a list or an object on any element is left out (every value differs),
 * except a Reference, which counts as not set: a key held only as a Reference is never a field.
 *
 * Element properties (`graph.elementProperties`) are fields by their names, in name order with the
 * other custom keys, whatever their key (`archimateType` too): text and choice ones only (a choice's
 * values in its options' order; a value of another kind counts as not set), never a Reference
 * property.
 */
export function filterFields(graph: ModelGraph): FilterField[] {
  const definitions = graph.elementProperties;
  const counts = new Map<string, Map<string, number>>();
  const structured = new Set<string>();
  let total = 0;
  // Per field read as an option when not set (Kind): the elements of the types that have it.
  const readAsTotals = new Map<string, number>();
  for (const element of graph.elements.values()) {
    total += 1;
    for (const key of Object.keys(element.metadata)) {
      const definition = elementDefinitionOf(definitions, key);
      // An element property is a field whatever its key (`archimateType` too).
      if (!isFilterableKey(key) && definition === undefined) continue;
      if (!countsFor(element, key, readAsOf(key))) continue;
      if (definition?.kind === 'reference') continue;
      const raw = element.metadata[key];
      // A Reference is never a filter value; the key's text values on other elements still are.
      if (isReference(raw) && !isStandardPropertyOf(element.type, key)) continue;
      if (typeof raw === 'object' && raw !== null && !isElementStandardKey(key)) {
        // Under an element property, a value of another kind is only not set.
        if (definition === undefined) structured.add(key);
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

  // A field read as an option when not set counts every element it applies to: those without a
  // value (or with a list or object) count under that option.
  for (const [key, values] of counts) {
    const readAs = readAsOf(key);
    if (readAs === undefined) continue;
    let applicable = 0;
    for (const element of graph.elements.values()) {
      if (!countsFor(element, key, readAs)) continue;
      applicable += 1;
      if (filterValueOf(element, key) === undefined) {
        values.set(readAs, (values.get(readAs) ?? 0) + 1);
      }
    }
    readAsTotals.set(key, applicable);
  }

  const fields: FilterField[] = [];
  for (const [key, values] of counts) {
    if (structured.has(key)) continue;
    const standard = isElementStandardKey(key);
    const definition = standard ? undefined : elementDefinitionOf(definitions, key);
    const options = choiceOptions(key, definition);
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
      label: standard ? standardProperties[key].label : (definition?.name ?? key),
      standard,
      values: list,
      notSetCount: (readAsTotals.get(key) ?? total) - withValue,
    });
  }
  return fields.sort((a, b) => {
    if (a.standard !== b.standard) return a.standard ? -1 : 1;
    if (a.standard) return standardOrder.indexOf(a.key) - standardOrder.indexOf(b.key);
    return compareText(a.label, b.label) || compareText(a.key, b.key);
  });
}

/** The options of a choice field, in order: a standard property's, or an element property's. */
function choiceOptions(
  key: string,
  definition: ElementPropertyDefinition | undefined,
): readonly string[] {
  if (isElementStandardKey(key)) {
    const rule = standardProperties[key].value;
    return rule.kind === 'choice' ? rule.options : [];
  }
  return definition?.kind === 'choice' ? (definition.options ?? []) : [];
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
  const readAs = readAsOf(field.key);
  for (const element of findElements(graph, { ...options, filters: others })) {
    if (!countsFor(element, field.key, readAs)) continue;
    const value = elementFilterValue(element, field.key, readAs);
    if (value === undefined) notSetCount += 1;
    else counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return { values: [...counts].map(([value, count]) => ({ value, count })), notSetCount };
}

type CompiledFilter = [
  key: string,
  accepted: ReadonlySet<string | null>,
  readAs: string | undefined,
];

/** The active filters, ready for matching: fields with at least one value. */
function compile(filters: ElementFilters): CompiledFilter[] {
  return Object.entries(filters)
    .filter(([, values]) => values.length > 0)
    .map(([key, values]) => [key, new Set(values), readAsOf(key)]);
}

/** A Kind filter matches Stakeholders only, one without Kind as Human. */
function matchesCompiled(element: ModelElement, compiled: CompiledFilter[]): boolean {
  return compiled.every(
    ([key, accepted, readAs]) =>
      countsFor(element, key, readAs) &&
      accepted.has(elementFilterValue(element, key, readAs) ?? null),
  );
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

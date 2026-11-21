/**
 * Grouping the canvas's cards by one element property ("Group by"): which properties a model
 * offers, an element's value for one, the order of the values, and the rules a view's stored
 * setting must meet. Pure, so the web app and the API agree.
 *
 * The choices are the element list Filter's fields (`filterFields`) with Type first, over the whole
 * model. An element's group is its value as the Filter reads it: trimmed, case kept, empty is not
 * set, a Stakeholder without Kind is Human, and an element whose type lacks a standard property
 * has no value for it.
 */
import {
  elementDefinitionOf,
  isDefinableElementKey,
  type ElementPropertyDefinition,
} from './element-properties.js';
import { compareText, filterFields, filterValueOf, isFilterableKey } from './filters.js';
import type { ModelElement, ModelGraph } from './graph.js';
import {
  isStandardPropertyKey,
  isStandardPropertyOf,
  nodeTypeKey,
  nodeTypes,
  standardProperties,
  type StandardPropertyDefinition,
  type StandardPropertyKey,
} from './metamodel.js';

/** The key that groups by element type (in the address: `?group=type`). */
export const typeGroupKey = nodeTypeKey;

/** The longest key a view stores or the address carries, as for a viewpoint's properties. */
export const maxGroupByKeyLength = 100;

/**
 * A view stores, with each card's position, the value of the group it was drawn in, cut to this
 * many characters, so a card whose value changed since can be told apart.
 */
export const maxViewGroupValueLength = 200;

/** One property the canvas can be grouped by. */
export interface GroupByChoice {
  key: string;
  /** "Type", a standard property's label, an element property's name, or the custom key itself. */
  label: string;
  /** Type and the standard properties; false for custom metadata. */
  standard: boolean;
}

const isElementStandardKey = (key: string): key is StandardPropertyKey =>
  isStandardPropertyKey(key) && nodeTypes.some((type) => isStandardPropertyOf(type, key));

const definitionOf = (key: StandardPropertyKey): StandardPropertyDefinition =>
  standardProperties[key];

/**
 * The label of a Group by key: "Type", a standard property's label, the name of an element
 * property (of `definitions`), or the key.
 */
export function groupByLabel(
  key: string,
  definitions: readonly ElementPropertyDefinition[] = [],
): string {
  if (key === typeGroupKey) return 'Type';
  if (isElementStandardKey(key)) return definitionOf(key).label;
  return elementDefinitionOf(definitions, key)?.name ?? key;
}

/**
 * The properties the model's elements can be grouped by: Type first, then the Filter's fields
 * (standard properties some element has a value for, in metamodel order, then text and choice
 * element properties and single-value custom keys A to Z). Description, Functions,
 * `archimateType`, Reference properties and keys holding a list never show.
 */
export function groupByChoices(graph: ModelGraph): GroupByChoice[] {
  return [
    { key: typeGroupKey, label: 'Type', standard: true },
    ...filterFields(graph).map(({ key, label, standard }) => ({ key, label, standard })),
  ];
}

/**
 * Whether a key can be a Group by setting at all: Type, or a key the Filter could offer (a key an
 * element property can have, `archimateType` too), of at most `maxGroupByKeyLength` characters,
 * and never `__proto__`. Whether the model has it is another question (`groupByChoices`).
 */
export function isGroupByKey(key: string): boolean {
  if (key === typeGroupKey) return true;
  return (
    key.trim() !== '' &&
    key.length <= maxGroupByKeyLength &&
    key !== '__proto__' &&
    (isFilterableKey(key) || isDefinableElementKey(key))
  );
}

/**
 * An element's value for a Group by key, or undefined when it has none (its card goes in Not set).
 */
export function elementGroupValue(element: ModelElement, key: string): string | undefined {
  if (key === typeGroupKey) return element.type;
  if (isElementStandardKey(key)) {
    if (!isStandardPropertyOf(element.type, key)) return undefined;
    return filterValueOf(element, key) ?? definitionOf(key).readAs;
  }
  return filterValueOf(element, key);
}

/**
 * The order of a key's groups where the layout leaves a choice: Type in the metamodel's type
 * order, a choice property's options in their order (the metamodel's, or an element property's of
 * `definitions`; then other values), other values A to Z; Not set (undefined) last.
 */
export function compareGroupValues(
  key: string,
  definitions: readonly ElementPropertyDefinition[] = [],
): (a: string | undefined, b: string | undefined) => number {
  const definition = isElementStandardKey(key) ? definitionOf(key) : undefined;
  const defined = definition === undefined ? elementDefinitionOf(definitions, key) : undefined;
  const options: readonly string[] =
    key === typeGroupKey
      ? nodeTypes
      : definition?.value.kind === 'choice'
        ? definition.value.options
        : defined?.kind === 'choice'
          ? (defined.options ?? [])
          : [];
  const rank = (value: string) => {
    const index = options.indexOf(value);
    return index === -1 ? Infinity : index;
  };
  return (a, b) => {
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
    return rank(a) - rank(b) || compareText(a, b);
  };
}

/**
 * A group's value as a view stores it with a card: cut to `maxViewGroupValueLength` characters
 * (whole characters, never half a surrogate pair); null for Not set.
 */
export function storedGroupValue(value: string | undefined): string | null {
  if (value === undefined) return null;
  const characters = Array.from(value);
  return characters.length <= maxViewGroupValueLength
    ? value
    : characters.slice(0, maxViewGroupValueLength).join('');
}

/**
 * Properties defined by an Admin, for elements (every element type). A definition names a metadata
 * key and says how an element's form shows it: free text, a choice from a list, or a Reference to
 * other elements of the same model. Values live in the elements' metadata under the key, so JGF
 * files and stored models don't change, and a definition never makes a model invalid: a value
 * outside a choice list, or a value of another kind ("not this kind"), is read as it is stored.
 *
 * The rules of names, keys and options are those of relationship properties
 * (relationship-properties.ts), against the element types' own fields instead of a relationship's.
 * Pure functions, so the API (its checks, the upgrade and the import) and the web app apply the
 * same rules.
 */
import type { ApiError } from './api.js';
import { isPrototypeKey, prototypeKeyMessage, type ElementFieldIssue } from './elements.js';
import { isImportableKey, maxPropertyKeyLength } from './imported-keys.js';
import {
  isStandardPropertyOf,
  nodeTypeDefinitions,
  nodeTypeKey,
  nodeTypes,
  standardProperties,
  type NodeType,
  type StandardPropertyKey,
} from './metamodel.js';
import { isReference } from './reference-value.js';
import {
  maxPropertyNameLength,
  propertyNameKey,
  sortDefinitions,
  type PropertyValueCount,
} from './relationship-properties.js';

export const elementPropertyKinds = ['text', 'choice', 'reference'] as const;
export type ElementPropertyKind = (typeof elementPropertyKinds)[number];

/** One defined element property, as the API lists it. */
export interface ElementPropertyDefinition {
  /** The metadata key elements store its values under, e.g. `costCentre`. Its identity. */
  key: string;
  /** What people see, e.g. "Cost centre". */
  name: string;
  kind: ElementPropertyKind;
  /** A choice's options, in the order the form lists them. Absent for text and reference. */
  options?: string[];
  /**
   * Added from the custom metadata in models (the upgrade or an import), and not saved by an Admin
   * since: the Admin page asks them to check its name and kind.
   */
  fromModels: boolean;
  /** Starts at 1 and goes up by one with every change, for the next change's conflict check. */
  version: number;
}

/** Body of `POST /api/properties?for=element` (Admin). */
export interface NewElementPropertyRequest {
  name: string;
  key: string;
  kind: ElementPropertyKind;
  /** Choice only. */
  options?: string[];
}

/**
 * Body of `PATCH /api/properties?for=element&key=…` (Admin). Only the fields sent change. The key
 * can change only while no element holds a value under it. A change away from choice drops the
 * options. Values in models never change: one of another kind then reads as "not this kind".
 */
export interface UpdateElementPropertyRequest {
  version: number;
  name?: string;
  key?: string;
  kind?: ElementPropertyKind;
  options?: string[];
}

/** Response body (200 or 201) of a create or change of an element property. */
export interface ElementPropertyResult {
  property: ElementPropertyDefinition;
}

/** Response body (422) when a create or change is refused: by field (`name`, `key`, `options.2` …). */
export interface ElementPropertyRejected extends ApiError {
  fields: ElementFieldIssue[];
}

/** How a defined element property's key is used in all stored models (Admin). */
export interface ElementPropertyUsage {
  key: string;
  /** Elements holding a value under the key, in every model: what a delete removes. */
  elements: number;
  /** Models with at least one such element. */
  models: number;
  /**
   * The elements' values by what they hold, for a kind change: `text` (text, a number or true or
   * false), `reference` (a Reference) and `other` (a list, another object, null).
   */
  shapes: { text: number; reference: number; other: number };
  /** The most used text values (up to `maxUsageValues`), most used first. */
  values: PropertyValueCount[];
}

/** Response body (200) of `DELETE /api/properties?for=element&key=…` (Admin): what was deleted. */
export interface DeletedElementPropertyResult {
  key: string;
  /** Element values deleted (one per element that held one). */
  values: number;
  /** Models changed. */
  models: number;
}

/** An element property added to the list by an import, with the number of values it brought. */
export interface AddedElementProperty {
  key: string;
  name: string;
  kind: ElementPropertyKind;
  values: number;
}

/** The keys some element type has a field of its own for: never an element property's. */
export const elementStandardKeys: readonly StandardPropertyKey[] = [
  ...new Set(nodeTypes.flatMap((type) => nodeTypeDefinitions[type].properties)),
];

/** Whether a key is a standard property of any element type. */
export function isElementStandardKey(key: string): key is StandardPropertyKey {
  return (elementStandardKeys as readonly string[]).includes(key);
}

const internalPrefix = 'simplearchitecture:';

/** A key that is never an element property: the type, a prototype's name, what the server keeps. */
export function isReservedElementKey(key: string): boolean {
  return key === nodeTypeKey || isPrototypeKey(key) || key.startsWith(internalPrefix);
}

/**
 * Whether a key found on an element in a model becomes an element property (the upgrade and
 * imports): anything but a standard property of any element type and a reserved key. Taken exactly
 * as stored.
 */
export function isDefinableElementKey(key: string): boolean {
  return key !== '' && !isElementStandardKey(key) && !isReservedElementKey(key);
}

/** The labels of the element types' own fields: no element property can be called so. */
const standardNames: readonly string[] = elementStandardKeys.map(
  (key) => standardProperties[key].label,
);
/** Other words the element form and details panel use for their fields. */
const formNames: readonly string[] = ['Name', 'Type', 'Referenced by'];

const hasLineBreak = (text: string): boolean => /[\r\n]/.test(text);

type Others = readonly Pick<ElementPropertyDefinition, 'key' | 'name'>[];

/** Why a name can't be used for an element property, or undefined. `others`: every other one. */
export function elementPropertyNameProblem(name: string, others: Others): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return 'Enter a name.';
  if (trimmed.length > maxPropertyNameLength) {
    return `Use ${maxPropertyNameLength} characters or fewer.`;
  }
  if (hasLineBreak(trimmed)) return 'Keep the name on one line.';
  if (/[{}]/.test(trimmed)) return "Names can't hold { or }.";
  const key = propertyNameKey(trimmed);
  const standard = standardNames.find((other) => propertyNameKey(other) === key);
  if (standard !== undefined) return `“${standard}” is a standard property of an element type.`;
  const used = formNames.find((other) => propertyNameKey(other) === key);
  if (used !== undefined) return `“${used}” is used on the element form already.`;
  const same = others.find((other) => propertyNameKey(other.name) === key);
  if (same !== undefined) return `There's already an element property called “${same.name}”.`;
  if (others.some((other) => other.key.toLowerCase() === trimmed.toLowerCase())) {
    return `“${trimmed}” is another element property's key.`;
  }
  return undefined;
}

/** Why a key an Admin types can't be used for an element property, or undefined. */
export function elementPropertyKeyProblem(key: string, others: Others): string | undefined {
  const trimmed = key.trim();
  if (trimmed === '') return 'Enter a key.';
  if (trimmed.length > maxPropertyKeyLength) {
    return `Use ${maxPropertyKeyLength} characters or fewer.`;
  }
  if (hasLineBreak(trimmed)) return 'Keep the key on one line.';
  if (isElementStandardKey(trimmed)) {
    return `“${trimmed}” is the key of an element type's standard property.`;
  }
  if (isPrototypeKey(trimmed)) return prototypeKeyMessage;
  if (isReservedElementKey(trimmed)) return 'This key is reserved. Use another one.';
  const same = others.find((other) => other.key.toLowerCase() === trimmed.toLowerCase());
  if (same !== undefined) return `There's already an element property with the key “${same.key}”.`;
  return undefined;
}

/**
 * The name an element property found in models gets (the upgrade, an import): its key, cut to 60
 * characters, without braces or line breaks, with " (2)", " (3)" … until no other element property
 * (`taken`) or standard field has it. A key with nothing left is called "Property".
 */
export function elementNameFromKey(key: string, taken: Others): string {
  const cleaned = key
    .replace(/[{}]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned === '' ? 'Property' : cleaned;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` (${String(n)})`;
    const candidate = `${base.slice(0, maxPropertyNameLength - suffix.length).trim()}${suffix}`;
    if (elementPropertyNameProblem(candidate, taken) === undefined) return candidate;
  }
}

/** The element properties in name order (then key): the Admin page's and the form's order. */
export function sortElementDefinitions<T extends Pick<ElementPropertyDefinition, 'name' | 'key'>>(
  definitions: readonly T[],
): T[] {
  return sortDefinitions(definitions);
}

/** The element property with this key (exact), if any. */
export function elementDefinitionOf(
  definitions: readonly ElementPropertyDefinition[],
  key: string,
): ElementPropertyDefinition | undefined {
  return definitions.find((definition) => definition.key === key);
}

/**
 * The one lookup for a metadata key on an element of a type:
 * - `standard`: a field of the type's own;
 * - `defined`: an element property (every type has every one);
 * - `was-property`: a standard property of another type, kept from before a type change (shown
 *   with a "Was a property" tag; it can only be removed);
 * - `custom`: any other key (not an element property, e.g. one kept by the server).
 */
export type ElementKeyRole =
  | { role: 'standard' }
  | { role: 'defined'; definition: ElementPropertyDefinition }
  | { role: 'was-property' }
  | { role: 'custom' };

export function elementKeyRole(
  type: NodeType,
  key: string,
  definitions: readonly ElementPropertyDefinition[],
): ElementKeyRole {
  if (isStandardPropertyOf(type, key)) return { role: 'standard' };
  const definition = elementDefinitionOf(definitions, key);
  if (definition !== undefined) return { role: 'defined', definition };
  return isElementStandardKey(key) ? { role: 'was-property' } : { role: 'custom' };
}

/**
 * How a stored value reads under its element property: `fits`; `not-listed` (a choice's text
 * outside its options); or `not-this-kind` (a Reference under a text or choice property, a list or
 * object under them, or anything but a Reference under a Reference property). Shown as stored.
 */
export type ElementValueFit = 'fits' | 'not-listed' | 'not-this-kind';

export function elementValueFit(
  definition: Pick<ElementPropertyDefinition, 'kind' | 'options'>,
  value: unknown,
): ElementValueFit {
  if (definition.kind === 'reference') return isReference(value) ? 'fits' : 'not-this-kind';
  const plain =
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  if (!plain) return 'not-this-kind';
  if (definition.kind === 'text') return 'fits';
  return typeof value === 'string' && (definition.options ?? []).includes(value)
    ? 'fits'
    : 'not-listed';
}

/** A key found on elements in a model, with how many hold it and whether each holds a Reference. */
export interface FoundElementKey {
  key: string;
  values: number;
  /** Every value under the key is a Reference: the key becomes a Reference property. */
  references: boolean;
}

/**
 * The definable keys on the elements (JGF nodes) of a model that `isDefined` doesn't know, each
 * with how many elements hold it and whether every value is a Reference, sorted by key. A key an
 * import wouldn't keep as it is (blank or too long) is never one: an import shortens or leaves it
 * out first (`withImportableElementKeys`).
 */
export function newElementKeys(
  nodes: Iterable<{ metadata?: unknown }>,
  isDefined: (key: string) => boolean,
): FoundElementKey[] {
  const found = new Map<string, { values: number; references: boolean }>();
  for (const node of nodes) {
    const metadata = node.metadata;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) continue;
    for (const [key, value] of Object.entries(metadata)) {
      if (!isDefinableElementKey(key) || !isImportableKey(key)) continue;
      if (isDefined(key)) continue;
      const entry = found.get(key) ?? { values: 0, references: true };
      entry.values += 1;
      entry.references &&= isReference(value);
      found.set(key, entry);
    }
  }
  return [...found]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, { values, references }]) => ({ key, values, references }));
}

/**
 * Definitions (from models) for keys found in models: Reference when every value is one, text
 * otherwise, named from their keys against the existing element properties and each other, in the
 * order given.
 */
export function elementDefinitionsForKeys(
  keys: readonly Pick<FoundElementKey, 'key' | 'references'>[],
  existing: Others,
): Omit<ElementPropertyDefinition, 'version'>[] {
  const taken: Pick<ElementPropertyDefinition, 'key' | 'name'>[] = [...existing];
  return keys.map(({ key, references }) => {
    const name = elementNameFromKey(key, taken);
    taken.push({ key, name });
    return { key, name, kind: references ? 'reference' : 'text', fromModels: true };
  });
}

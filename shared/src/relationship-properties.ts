/**
 * Properties defined by an Admin, for relationships (Relation only). A definition names a metadata
 * key and says how a Relation's form shows it: free text, or a choice from a list. Values live in
 * the relationships' metadata under the key, so JGF files and stored models don't change, and a
 * definition never makes a model invalid: a value outside a choice list, or a list under a text
 * key, is read as it is stored.
 *
 * Pure functions, so the API (its checks, the upgrade and the import) and the web app (the Admin
 * dialog and the relationship form) apply the same rules.
 */
import type { ApiError } from './api.js';
import { isPrototypeKey, prototypeKeyMessage, type ElementFieldIssue } from './elements.js';
import { compareNames } from './graph.js';
import {
  isImportableKey,
  maxPropertyKeyLength,
  withImportableKeys,
  type ChangedPropertyKey,
} from './imported-keys.js';
import {
  relationProperties,
  retiredDataKey,
  standardProperties,
  type EdgeType,
} from './metamodel.js';

export const definedPropertyKinds = ['text', 'choice'] as const;
export type DefinedPropertyKind = (typeof definedPropertyKinds)[number];

/** One defined property, as the API lists it. */
export interface RelationshipPropertyDefinition {
  /** The metadata key models store its values under, e.g. `costCentre`. Its identity. */
  key: string;
  /** What people see, e.g. "Cost centre". Used in labels as `{Cost centre}`. */
  name: string;
  kind: DefinedPropertyKind;
  /** A choice's options, in the order the form lists them. Absent for text. */
  options?: string[];
  /**
   * Added from the custom metadata in models (the upgrade or an import), and not saved by an Admin
   * since: the Admin page asks them to check its name and kind.
   */
  fromModels: boolean;
  /** Starts at 1 and goes up by one with every change, for the next change's conflict check. */
  version: number;
}

/** Response body of `GET /api/properties` (everyone with a role): sorted by name. */
export interface RelationshipPropertyListResponse {
  properties: RelationshipPropertyDefinition[];
}

/** Body of `POST /api/properties` (Admin). */
export interface NewRelationshipPropertyRequest {
  name: string;
  key: string;
  kind: DefinedPropertyKind;
  /** Choice only. */
  options?: string[];
}

/**
 * Body of `PATCH /api/properties/:key` (Admin). Only the fields sent change. The key can change
 * only while no relationship holds a value under it. Choice → text drops the options. Values in
 * models never change.
 */
export interface UpdateRelationshipPropertyRequest {
  version: number;
  name?: string;
  key?: string;
  kind?: DefinedPropertyKind;
  options?: string[];
}

/** Response body (200 or 201) of a create or change. */
export interface RelationshipPropertyResult {
  property: RelationshipPropertyDefinition;
}

/** Response body (422) when a create or change is refused: by field (`name`, `key`, `options.2` …). */
export interface RelationshipPropertyRejected extends ApiError {
  fields: ElementFieldIssue[];
}

/** One value held under a key, with how many relationships hold it. */
export interface PropertyValueCount {
  value: string;
  count: number;
}

/** How a defined property's key is used in all stored models (Admin). */
export interface RelationshipPropertyUsage {
  key: string;
  /** Relationships holding a value under the key: on Relations, and kept on Contains. */
  relations: number;
  contains: number;
  /** Models with at least one such relationship. */
  models: number;
  /** The most used text values (up to `maxUsageValues`), most used first. */
  values: PropertyValueCount[];
  /** Relationship labels in the models that use the property's name as `{Name}`. */
  labels: number;
}

/** Response body of `GET /api/properties/usage` (Admin). */
export interface RelationshipPropertyUsageResponse {
  usage: RelationshipPropertyUsage[];
}

/** Response body (200) of `DELETE /api/properties/:key` (Admin): what was deleted. */
export interface DeletedRelationshipPropertyResult {
  key: string;
  /** Relationship values deleted. */
  values: number;
  /** Models changed. */
  models: number;
}

/** A property added to the list by an import, with the number of values the model brought. */
export interface AddedRelationshipProperty {
  key: string;
  name: string;
  values: number;
}

export const maxPropertyNameLength = 60;
/** The longest key an Admin can type, as for any metadata key. */
export { maxPropertyKeyLength };
export const maxPropertyOptionLength = 100;
export const minPropertyOptions = 2;
export const maxPropertyOptions = 50;
/** The most values the usage lists per property. */
export const maxUsageValues = 50;

export const propertyConflictMessage =
  'Someone else changed this property since you opened it. Close and open it again to see the changes.';
export const propertyKeyInUseMessage = "The key can't change: values use it now.";
export const propertyDeletedMessage = 'Someone else deleted this property.';

/** Keys a relationship has fields of its own for (on Relation or Contains): never defined. */
export const relationshipStandardKeys: readonly string[] = [
  'description',
  'architectureState',
  ...relationProperties,
];

/** Keys that are never properties: the type, a prototype's name, and what the server keeps. */
const reservedKeys = new Set(['type', '__proto__']);
const internalPrefix = 'simplearchitecture:';
/** Retired properties, converted when a model is read. */
const retiredKeys = new Set([retiredDataKey, 'informationFlow']);

/** The labels of a relationship's own fields: no property can be called so. */
const standardNames: readonly string[] = relationshipStandardKeys.map(
  (key) => standardProperties[key as keyof typeof standardProperties].label,
);
/** Other words the relationship form and panel use for their fields. */
const formNames: readonly string[] = ['Name', 'Type', 'Direction', 'Label', 'Data'];

/** How names are compared: ignoring case, and runs of spaces count as one (as in labels). */
export const propertyNameKey = (name: string): string =>
  name.trim().replace(/\s+/g, ' ').toLowerCase();

const hasLineBreak = (text: string): boolean => /[\r\n]/.test(text);

export function isRelationshipStandardKey(key: string): boolean {
  return relationshipStandardKeys.includes(key);
}

/** A key that is reserved or retired: never a property, never custom metadata the form adds. */
export function isReservedRelationshipKey(key: string): boolean {
  return reservedKeys.has(key) || retiredKeys.has(key) || key.startsWith(internalPrefix);
}

/**
 * Whether a key found on a relationship in a model becomes a property (the upgrade and imports):
 * anything but a standard, reserved or retired key. Taken exactly as stored.
 */
export function isDefinableRelationshipKey(key: string): boolean {
  return key !== '' && !isRelationshipStandardKey(key) && !isReservedRelationshipKey(key);
}

/** By name, then by key, so the order is stable: the Admin page's and the form's order. */
export function compareDefinitions(
  a: Pick<RelationshipPropertyDefinition, 'name' | 'key'>,
  b: Pick<RelationshipPropertyDefinition, 'name' | 'key'>,
): number {
  return compareNames(a.name, b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export function sortDefinitions<T extends Pick<RelationshipPropertyDefinition, 'name' | 'key'>>(
  definitions: readonly T[],
): T[] {
  return [...definitions].sort(compareDefinitions);
}

/** The properties a relationship of this type shows, in name order: Relation only. */
export function definedPropertiesOf(
  type: EdgeType,
  definitions: readonly RelationshipPropertyDefinition[],
): RelationshipPropertyDefinition[] {
  return type === 'Relation' ? sortDefinitions(definitions) : [];
}

/** The definition with this key (exact), if any. */
export function definitionOf(
  definitions: readonly RelationshipPropertyDefinition[],
  key: string,
): RelationshipPropertyDefinition | undefined {
  return definitions.find((definition) => definition.key === key);
}

/**
 * The one lookup for a key on a relationship of a type: a field of its own (`standard`, also on a
 * Contains for a Relation's keys: those are kept there as custom metadata, but never set), a
 * `defined` property of a Relation, or `custom` metadata.
 */
export type RelationshipKeyRole =
  | { role: 'standard' }
  | { role: 'defined'; definition: RelationshipPropertyDefinition }
  | { role: 'custom' };

export function relationshipKeyRole(
  type: EdgeType,
  key: string,
  definitions: readonly RelationshipPropertyDefinition[],
): RelationshipKeyRole {
  if (key === 'description' || key === 'architectureState') return { role: 'standard' };
  if ((relationProperties as readonly string[]).includes(key)) {
    return type === 'Relation' ? { role: 'standard' } : { role: 'custom' };
  }
  const definition = type === 'Relation' ? definitionOf(definitions, key) : undefined;
  return definition === undefined ? { role: 'custom' } : { role: 'defined', definition };
}

/** Whether a stored value is one of a choice's options (exact). A text property takes any text. */
export function isListedValue(definition: RelationshipPropertyDefinition, value: unknown): boolean {
  if (definition.kind !== 'choice') return true;
  return typeof value === 'string' && (definition.options ?? []).includes(value);
}

/** "Cost centre" → `costCentre`: what the dialog's key follows until the Admin types in it. */
export function keyFromName(name: string): string {
  const words = name
    .normalize('NFC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('')
    .slice(0, maxPropertyKeyLength);
}

type Others = readonly Pick<RelationshipPropertyDefinition, 'key' | 'name'>[];

/** Why a name can't be used, or undefined. `others`: every other property (not this one). */
export function propertyNameProblem(name: string, others: Others): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') return 'Enter a name.';
  if (trimmed.length > maxPropertyNameLength) {
    return `Use ${maxPropertyNameLength} characters or fewer.`;
  }
  if (hasLineBreak(trimmed)) return 'Keep the name on one line.';
  if (/[{}]/.test(trimmed)) return "Names can't hold { or }.";
  const key = propertyNameKey(trimmed);
  const standard = standardNames.find((other) => propertyNameKey(other) === key);
  if (standard !== undefined) return `“${standard}” is a standard property.`;
  const used = formNames.find((other) => propertyNameKey(other) === key);
  if (used !== undefined) return `“${used}” is used on the relationship form already.`;
  const same = others.find((other) => propertyNameKey(other.name) === key);
  if (same !== undefined) return `There's already a property called “${same.name}”.`;
  if (others.some((other) => other.key.toLowerCase() === trimmed.toLowerCase())) {
    return `“${trimmed}” is another property's key.`;
  }
  return undefined;
}

/** Why a key an Admin types can't be used, or undefined. Unique ignoring case. */
export function propertyKeyProblem(key: string, others: Others): string | undefined {
  const trimmed = key.trim();
  if (trimmed === '') return 'Enter a key.';
  if (trimmed.length > maxPropertyKeyLength) {
    return `Use ${maxPropertyKeyLength} characters or fewer.`;
  }
  if (hasLineBreak(trimmed)) return 'Keep the key on one line.';
  if (isRelationshipStandardKey(trimmed)) return `“${trimmed}” is a standard property's key.`;
  if (isPrototypeKey(trimmed)) return prototypeKeyMessage;
  if (isReservedRelationshipKey(trimmed)) return 'This key is reserved. Use another one.';
  const same = others.find((other) => other.key.toLowerCase() === trimmed.toLowerCase());
  if (same !== undefined) return `There's already a property with the key “${same.key}”.`;
  return undefined;
}

/**
 * The problems of a choice's options, by field: `options` for the list, `options.N` for one
 * option. Each trimmed, 1 to 100 characters on one line, none twice ignoring case, 2 to 50.
 */
export function propertyOptionsProblems(options: readonly string[]): ElementFieldIssue[] {
  const issues: ElementFieldIssue[] = [];
  const seen = new Set<string>();
  options.forEach((option, index) => {
    const field = `options.${String(index)}`;
    const trimmed = option.trim();
    if (trimmed === '') {
      issues.push({ field, message: 'Enter the option, or remove it.' });
    } else if (trimmed.length > maxPropertyOptionLength) {
      issues.push({ field, message: `Use ${maxPropertyOptionLength} characters or fewer.` });
    } else if (hasLineBreak(trimmed)) {
      issues.push({ field, message: 'Keep the option on one line.' });
    } else if (seen.has(trimmed.toLowerCase())) {
      issues.push({ field, message: `${trimmed} is in the list twice.` });
    }
    seen.add(trimmed.toLowerCase());
  });
  if (options.length < minPropertyOptions) {
    issues.push({ field: 'options', message: `Add at least ${minPropertyOptions} options.` });
  } else if (options.length > maxPropertyOptions) {
    issues.push({ field: 'options', message: `Use ${maxPropertyOptions} options or fewer.` });
  }
  return issues;
}

/**
 * The name a property found in models gets (the upgrade, an import): its key, cut to 60
 * characters, without braces or line breaks, and with " (2)", " (3)" … until no other property
 * (`taken`) has it. A key with nothing left is called "Property".
 */
export function nameFromKey(key: string, taken: Others): string {
  const cleaned = key
    .replace(/[{}]/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = cleaned === '' ? 'Property' : cleaned;
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` (${String(n)})`;
    const candidate = `${base.slice(0, maxPropertyNameLength - suffix.length).trim()}${suffix}`;
    if (propertyNameProblem(candidate, taken) === undefined) return candidate;
  }
}

/** A key found on relationships in a model, with the number of relationships holding it. */
export interface FoundRelationshipKey {
  key: string;
  values: number;
}

/**
 * The definable keys on the relationships (JGF edges) of a model that `isDefined` doesn't know,
 * each with how many relationships hold it, sorted by key. Any relationship counts, Contains too.
 * A key an import wouldn't keep as it is (`isImportableRelationshipKey`) is never one: an import
 * shortens or leaves it out first (`withImportableRelationshipKeys`).
 */
export function newRelationshipKeys(
  edges: readonly { metadata?: unknown }[],
  isDefined: (key: string) => boolean,
): FoundRelationshipKey[] {
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const metadata = edge.metadata;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) continue;
    for (const key of Object.keys(metadata)) {
      if (!isDefinableRelationshipKey(key) || !isImportableRelationshipKey(key)) continue;
      if (isDefined(key)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, values]) => ({ key, values }));
}

/**
 * Text definitions (from models) for keys found in models, named from their keys against the
 * existing properties and each other, in the order given.
 */
export function definitionsForKeys(
  keys: readonly string[],
  existing: Others,
): Omit<RelationshipPropertyDefinition, 'version'>[] {
  const taken: Pick<RelationshipPropertyDefinition, 'key' | 'name'>[] = [...existing];
  return keys.map((key) => {
    // A name made from a key may equal its own key: only the others count.
    const name = nameFromKey(key, taken);
    taken.push({ key, name });
    return { key, name, kind: 'text' as const, fromModels: true };
  });
}

/**
 * Whether an import keeps a key on a relationship as it is: not blank (empty, or only spaces) and
 * at most `maxPropertyKeyLength` characters, like a key an Admin types.
 */
export const isImportableRelationshipKey = isImportableKey;

/**
 * A key on a model's relationships that an import changed, as no property can have it: a key over
 * `maxPropertyKeyLength` characters is shortened, and a blank one is left out with its values.
 */
export type ChangedRelationshipKey = ChangedPropertyKey;

/**
 * The key rules of an import, for the relationships (JGF edges) of a model about to be stored, so
 * no property gets a blank or overlong key (`withImportableKeys`). A shortened key never becomes
 * one that can't be a property (such as `description`). A shortened key that is a property already
 * (an earlier import of the same file, say) holds that property's values, as any key does.
 */
export function withImportableRelationshipKeys<E extends { metadata?: unknown }>(
  edges: readonly E[],
): { edges: E[]; changes: ChangedRelationshipKey[] } {
  const { items, changes } = withImportableKeys(edges, isDefinableRelationshipKey);
  return { edges: items, changes };
}

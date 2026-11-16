/**
 * The key rules of an import, for the metadata of a model's elements and relationships: no key an
 * import stores is blank or longer than a key a person can type, so every one can be changed and
 * removed later. Pure functions, used by the API on every import.
 */
import { isPrototypeKey } from './elements.js';
import type { JgfNode } from './jgf.js';
import { isStandardPropertyKey, nodeTypeKey } from './metamodel.js';
import { storedModelKey } from './models.js';

/** The longest metadata key a person can type (a property's key, an element's custom name). */
export const maxPropertyKeyLength = 100;

/** What the server keeps for itself in metadata, e.g. `simplearchitecture:stored`. */
const internalPrefix = storedModelKey.slice(0, storedModelKey.indexOf(':') + 1);

/**
 * Whether an import keeps a metadata key as it is: not blank (empty, or only spaces) and at most
 * `maxPropertyKeyLength` characters.
 */
export function isImportableKey(key: string): boolean {
  return key.trim() !== '' && key.length <= maxPropertyKeyLength;
}

/**
 * A metadata key in a model that an import changed: a key over `maxPropertyKeyLength` characters
 * is shortened, and a blank one is left out with its values.
 */
export interface ChangedPropertyKey {
  /** The key in the file, cut to `maxPropertyKeyLength` characters (with "…") when longer. */
  key: string;
  /** The key its values are stored under now; absent when they were left out (a blank key). */
  storedAs?: string;
  /** Elements or relationships that held a value under it. */
  values: number;
}

const cutKey = (key: string): string =>
  key.length > maxPropertyKeyLength ? `${key.slice(0, maxPropertyKeyLength)}…` : key;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The key rules for one kind of item (elements or relationships) of a model about to be stored.
 * A blank key is left out with its values. A key over `maxPropertyKeyLength` characters is trimmed
 * and cut to that length; when that is a key the items use already, or one `isFree` refuses (a
 * standard or reserved key), it gets " (2)", " (3)" … within the length. Every other key stays
 * exactly as it is. Returns the items, each changed one a copy, and the changes sorted by key.
 */
export function withImportableKeys<E extends { metadata?: unknown }>(
  items: readonly E[],
  isFree: (key: string) => boolean,
): { items: E[]; changes: ChangedPropertyKey[] } {
  const kept = new Set<string>();
  const odd = new Map<string, number>();
  for (const item of items) {
    if (!isRecord(item.metadata)) continue;
    for (const key of Object.keys(item.metadata)) {
      if (isImportableKey(key)) kept.add(key);
      else odd.set(key, (odd.get(key) ?? 0) + 1);
    }
  }
  if (odd.size === 0) return { items: [...items], changes: [] };

  const renamed = new Map<string, string>();
  const changes: ChangedPropertyKey[] = [];
  for (const key of [...odd.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const values = odd.get(key) ?? 0;
    if (key.trim() === '') {
      changes.push({ key: cutKey(key), values });
      continue;
    }
    const base = key.trim().slice(0, maxPropertyKeyLength).trimEnd();
    let storedAs = base;
    for (let n = 2; kept.has(storedAs) || !isFree(storedAs); n++) {
      const suffix = ` (${String(n)})`;
      storedAs = `${base.slice(0, maxPropertyKeyLength - suffix.length).trimEnd()}${suffix}`;
    }
    kept.add(storedAs);
    renamed.set(key, storedAs);
    changes.push({ key: cutKey(key), storedAs, values });
  }

  const changedItems = items.map((item) => {
    if (!isRecord(item.metadata)) return item;
    const entries = Object.entries(item.metadata);
    if (entries.every(([key]) => !odd.has(key))) return item;
    // fromEntries defines own properties, in the order they were.
    const next = Object.fromEntries(
      entries.flatMap(([key, value]): [string, unknown][] => {
        if (!odd.has(key)) return [[key, value]];
        const storedAs = renamed.get(key);
        return storedAs === undefined ? [] : [[storedAs, value]];
      }),
    );
    return { ...item, metadata: next };
  });
  return { items: changedItems, changes };
}

/**
 * Whether a shortened key may hold an element's custom metadata: not the type, a standard
 * property of any element type (a type change would make it one), `__proto__` or what the server
 * keeps.
 */
function isFreeElementKey(key: string): boolean {
  return (
    key !== nodeTypeKey &&
    !isPrototypeKey(key) &&
    !isStandardPropertyKey(key) &&
    !key.startsWith(internalPrefix)
  );
}

/**
 * The key rules of an import for a model's elements (JGF nodes, by id), as for its relationships
 * (`withImportableRelationshipKeys`): a blank custom name is left out with its value, and one over
 * `maxPropertyKeyLength` characters is shortened, with " (2)" … when another element's name, a
 * standard property or a reserved key has it. The ids and their order stay.
 */
export function withImportableElementKeys(nodes: Readonly<Record<string, JgfNode>>): {
  nodes: Record<string, JgfNode>;
  changes: ChangedPropertyKey[];
} {
  const entries = Object.entries(nodes);
  const { items, changes } = withImportableKeys(
    entries.map(([, node]) => node),
    isFreeElementKey,
  );
  if (changes.length === 0) return { nodes: { ...nodes }, changes };
  // fromEntries defines own properties, so no id (not even `__proto__`) is lost.
  return {
    nodes: Object.fromEntries(entries.map(([id], index) => [id, items[index] as JgfNode])),
    changes,
  };
}

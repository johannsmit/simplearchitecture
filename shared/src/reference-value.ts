/**
 * The shape of a Reference value (see references.ts), on its own so the graph helpers can read it
 * without depending on the rest.
 */

/** The one key of a reference value. */
export const referenceKey = 'simplearchitecture:reference';

/** The most elements one Reference field may hold. */
export const maxReferences = 200;

/** A Reference value: the referenced elements' ids, each once, in the order they were added. */
export interface ReferenceValue {
  readonly 'simplearchitecture:reference': readonly string[];
}

/** The value that references these elements. */
export function referenceValue(ids: readonly string[]): ReferenceValue {
  return { [referenceKey]: [...ids] };
}

/** Whether a value is marked as a reference: an object with `referenceKey` as its one key. */
function isMarked(value: unknown): value is { [referenceKey]: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === referenceKey;
}

/** Whether a value has the reference shape: marked, and holding a list (of anything). */
export function isReference(value: unknown): value is { [referenceKey]: unknown[] } {
  return isMarked(value) && Array.isArray(value[referenceKey]);
}

/**
 * The ids a reference value holds (its text entries, as stored), or undefined when the value
 * isn't a reference.
 */
export function referenceIds(value: unknown): readonly string[] | undefined {
  if (!isReference(value)) return undefined;
  return value[referenceKey].filter((id): id is string => typeof id === 'string');
}

/** Whether a value sent for a custom key is meant as a reference: an object with `referenceKey`. */
export function isMeantAsReference(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.hasOwn(value, referenceKey)
  );
}

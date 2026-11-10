/**
 * Request Data and Response Data: each holds zero or more text values, stored as a JSON list in the
 * order they were added. Pure functions, so the API, the web app and the MCP tools read and compare
 * values the same way.
 */

/** Most values one field may hold, and the longest value, in a change (the API checks both). */
export const maxDataValues = 50;
export const maxDataValueLength = 200;

/** One entry as a value: trimmed text, or a number or true or false as text; else none. */
function entryText(entry: unknown): string | undefined {
  if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry);
  if (typeof entry !== 'string') return undefined;
  const text = entry.trim();
  return text === '' ? undefined : text;
}

/**
 * The values a stored Request Data or Response Data holds, for showing, filling in and suggesting:
 * a list's entries in their order, trimmed, skipping blanks and anything that isn't text; a single
 * text (as stored before these were lists) as one value. Any other shape holds none. Never changes
 * what is stored.
 */
export function dataValuesOf(value: unknown): string[] {
  const entries: readonly unknown[] = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    const text = entryText(entry);
    return text === undefined ? [] : [text];
  });
}

/** How values are compared: ignoring case and white space at the ends. */
export const dataValueKey = (value: string): string => value.trim().toLowerCase();

/** Whether two values count as the same one (ignoring case). */
export function sameDataValue(a: string, b: string): boolean {
  return dataValueKey(a) === dataValueKey(b);
}

/**
 * The values with `value` (trimmed) added last; the same list when it is blank or already there,
 * ignoring case.
 */
export function withDataValue(values: readonly string[], value: string): readonly string[] {
  const text = value.trim();
  if (text === '' || values.some((other) => sameDataValue(other, text))) return values;
  return [...values, text];
}

/** The first value that comes again later in the list, ignoring case; undefined when none does. */
export function repeatedDataValue(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    const key = dataValueKey(value);
    if (seen.has(key)) return value;
    seen.add(key);
  }
  return undefined;
}

/**
 * The values as one line of text: joined by ", ", each on one line. Undefined when there are none.
 */
export function dataValuesText(values: readonly string[]): string | undefined {
  const parts = values.map((value) => value.replace(/\s+/g, ' ').trim()).filter((v) => v !== '');
  return parts.length === 0 ? undefined : parts.join(', ');
}

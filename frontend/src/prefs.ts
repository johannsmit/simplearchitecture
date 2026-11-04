/**
 * UI preferences remembered in this browser (theme, depth, panel widths and the like). Only
 * preferences live here: never tokens, user data or model content. Storage can be blocked
 * (private mode, policy), so every access is guarded and a default applies.
 */
const prefix = 'sa-';

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(prefix + key);
  } catch {
    return null;
  }
}

/** Saves a preference, or forgets it when `value` is null. */
export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(prefix + key);
    else localStorage.setItem(prefix + key, value);
  } catch {
    // Not remembered; the choice still applies until the page is left.
  }
}

export function readBooleanPref(key: string, fallback: boolean): boolean {
  const value = readPref(key);
  return value === 'true' ? true : value === 'false' ? false : fallback;
}

/** A whole number within [min, max], or the fallback. */
export function readNumberPref(key: string, min: number, max: number, fallback: number): number {
  const value = Number(readPref(key));
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

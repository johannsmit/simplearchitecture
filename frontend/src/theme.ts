import { readPref, writePref } from './prefs';

export const themeChoices = ['light', 'dark'] as const;
export type ThemeChoice = (typeof themeChoices)[number];

// public/theme-init.js reads the same key ("sa-" + "theme") before first paint.
const themeKey = 'theme';

/** The current choice: Dark if theme-init.js applied it or it is saved, else Light. */
export function currentTheme(): ThemeChoice {
  const value = document.documentElement.getAttribute('data-theme') ?? readPref(themeKey);
  return value === 'dark' ? 'dark' : 'light';
}

/** Applies a choice at once and remembers it. Light is the default, so nothing is stored for it. */
export function applyTheme(choice: ThemeChoice): void {
  if (choice === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  writePref(themeKey, choice === 'dark' ? 'dark' : null);
}

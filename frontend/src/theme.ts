import { useSyncExternalStore } from 'react';
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

/** Re-renders on every theme change (the Theme menu or anything else setting `data-theme`). */
function subscribeTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    observer.disconnect();
  };
}

const shownTheme = (): ThemeChoice =>
  document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';

/** The theme shown now; follows a switch at once, without a reload. */
export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribeTheme, shownTheme, () => 'light');
}

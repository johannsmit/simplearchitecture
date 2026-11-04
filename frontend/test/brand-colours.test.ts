import {
  brandTokens,
  contrastRatio,
  formatRatio,
  hexToOklch,
  neutralBrandTokens,
  oklchToHex,
  type BrandTheme,
} from '@simplearchitecture/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The brand colours worked out per theme. The
 * fixed pairs below are the spec's, including black/white and mid grey, in both themes.
 */

const themes: BrandTheme[] = ['light', 'dark'];

// The text colours the tints must carry (tokens.css).
const text = { light: '#161b26', dark: '#e7eaf0' };
const textMuted = { light: '#596274', dark: '#9aa3b4' };

const pairs: [string, string][] = [
  ['#1d6b5f', '#e0892b'],
  ['#f2c200', '#1b2a4a'],
  ['#000000', '#ffffff'],
  ['#ffffff', '#000000'],
  ['#ff0000', '#00ff00'],
  ['#808080', '#808080'],
];

describe('brand colours', () => {
  describe.each(pairs)('primary %s, secondary %s', (primary, secondary) => {
    const tokens = brandTokens({ primary, secondary });

    it.each(themes)('%s theme: every target is met', (theme) => {
      const values = tokens[theme];
      const neutral = neutralBrandTokens[theme];
      const backgrounds = [...neutral.backgrounds, values.accentSoft, values.selectSoft];
      for (const background of backgrounds) {
        expect(contrastRatio(values.accent, background), background).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(values.onAccent, values.accent)).toBeGreaterThanOrEqual(4.5);
      expect(values.brandLine).not.toBeNull();
      expect(contrastRatio(values.brandLine ?? '', neutral.surface)).toBeGreaterThanOrEqual(3);
      for (const tint of [values.selectSoft, values.accentSoft]) {
        expect(contrastRatio(text[theme], tint)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(textMuted[theme], tint)).toBeGreaterThanOrEqual(4.5);
      }
      for (const value of Object.values(values)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    });

    it.each(themes)('%s theme: a colour that meets its target is used as entered', (theme) => {
      const values = tokens[theme];
      const report = tokens.report[theme];
      const neutral = neutralBrandTokens[theme];
      const backgrounds = [...neutral.backgrounds, values.accentSoft, values.selectSoft];
      const accentPasses = backgrounds.every((bg) => contrastRatio(primary, bg) >= 4.5);
      expect(values.accent === primary).toBe(accentPasses);
      expect(report.accent.adjusted).toBe(!accentPasses);
      expect(report.accent.entered).toBe(primary);
      const linePasses = contrastRatio(secondary, neutral.surface) >= 3;
      expect(values.brandLine === secondary).toBe(linePasses);
      expect(report.brandLine.adjusted).toBe(!linePasses);
      // The report's ratios are the final ones.
      expect(report.accent.ratio).toBe(
        Math.min(...backgrounds.map((bg) => contrastRatio(values.accent, bg))),
      );
      expect(report.onAccent.ratio).toBe(contrastRatio(values.onAccent, values.accent));
    });
  });

  it('works out the sample brand as in the mockup: dark primary lifted in dark, line darkened in light', () => {
    const tokens = brandTokens({ primary: '#1d6b5f', secondary: '#e0892b' });
    expect(tokens.light.accent).toBe('#1d6b5f');
    expect(tokens.report.dark.accent.adjusted).toBe(true);
    expect(hexToOklch(tokens.dark.accent).l).toBeGreaterThan(hexToOklch('#1d6b5f').l);
    expect(tokens.dark.brandLine).toBe('#e0892b');
    expect(tokens.report.light.brandLine.adjusted).toBe(true);
    expect(hexToOklch(tokens.light.brandLine ?? '').l).toBeLessThan(hexToOklch('#e0892b').l);
  });

  it('black and white: black passes in light and is lifted in dark, white the other way round', () => {
    const tokens = brandTokens({ primary: '#000000', secondary: null });
    expect(tokens.light.accent).toBe('#000000');
    expect(tokens.report.dark.accent.adjusted).toBe(true);
    const white = brandTokens({ primary: '#ffffff', secondary: null });
    expect(white.dark.accent).toBe('#ffffff');
    expect(white.report.light.accent.adjusted).toBe(true);
    // Grey tints stay grey.
    expect(tokens.light.accentSoft).toMatch(/^#([0-9a-f]{2})\1\1$/);
    expect(tokens.dark.accentSoft).toMatch(/^#([0-9a-f]{2})\1\1$/);
  });

  it('keeps the text on the tints readable for every hue', () => {
    for (let hue = 0; hue < 360; hue += 15) {
      const vivid = oklchToHex({ l: 0.6, c: 0.3, h: hue });
      const tokens = brandTokens({ primary: vivid, secondary: vivid });
      for (const theme of themes) {
        for (const tint of [tokens[theme].accentSoft, tokens[theme].selectSoft]) {
          expect(contrastRatio(textMuted[theme], tint), `${vivid} ${theme}`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
        expect(tokens.report[theme].accent.ratio ?? 0).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('only one colour set: the other tokens stay neutral', () => {
    const primaryOnly = brandTokens({ primary: '#1d6b5f', secondary: null });
    for (const theme of themes) {
      expect(primaryOnly[theme].brandLine).toBeNull();
      expect(primaryOnly[theme].selectSoft).toBe(primaryOnly[theme].accentSoft);
      expect(primaryOnly.report[theme].brandLine.value).toBeNull();
    }
    const secondaryOnly = brandTokens({ primary: null, secondary: '#1b2a4a' });
    for (const theme of themes) {
      expect(secondaryOnly[theme].accent).toBe(neutralBrandTokens[theme].accent);
      expect(secondaryOnly[theme].accentSoft).toBe(neutralBrandTokens[theme].accentSoft);
      // The neutral accent still meets 4.5:1 on the secondary's tint.
      expect(
        contrastRatio(secondaryOnly[theme].accent, secondaryOnly[theme].selectSoft),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('treats anything but #rrggbb as not set, and accepts upper case', () => {
    for (const bad of ['red', '#fff', '#12345g', 'url(x)', '#1d6b5f; color: red', '', undefined]) {
      const tokens = brandTokens({ primary: bad, secondary: bad });
      expect(tokens.primary).toBeNull();
      expect(tokens.secondary).toBeNull();
      expect(tokens.light.accent).toBe(neutralBrandTokens.light.accent);
    }
    expect(brandTokens({ primary: '#1D6B5F', secondary: null }).primary).toBe('#1d6b5f');
  });

  it('shows ratios rounded down, so 4.49 is never "4.5:1"', () => {
    expect(formatRatio(4.49)).toBe('4.4:1');
    expect(formatRatio(4.5)).toBe('4.5:1');
    expect(formatRatio(21)).toBe('21.0:1');
  });

  it('converts to OKLCH and back without drift', () => {
    for (const hex of ['#1d6b5f', '#e0892b', '#000000', '#ffffff', '#3657d6', '#808080']) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex);
    }
    // Out of gamut: chroma is lowered, never a broken value.
    expect(oklchToHex({ l: 0.95, c: 0.4, h: 140 })).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('knows the neutral values of tokens.css', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/styles/tokens.css'), 'utf8');
    const pair = (name: string) => {
      const match = new RegExp(
        `--${name}:\\s*light-dark\\((#[0-9a-f]{6}),\\s*(#[0-9a-f]{6})\\)`,
      ).exec(css);
      return { light: match?.[1], dark: match?.[2] };
    };
    for (const theme of themes) {
      const neutral = neutralBrandTokens[theme];
      expect(neutral.accent).toBe(pair('accent')[theme]);
      expect(neutral.accentSoft).toBe(pair('accent-soft')[theme]);
      expect(neutral.onAccent).toBe(pair('on-accent')[theme]);
      expect(neutral.surface).toBe(pair('surface')[theme]);
      expect([...neutral.backgrounds].sort()).toEqual(
        [
          ...new Set([
            pair('surface')[theme],
            pair('bg')[theme],
            pair('surface-2')[theme],
            pair('canvas')[theme],
          ]),
          ...(theme === 'dark' ? [pair('surface-raised')[theme]] : []),
        ].sort(),
      );
    }
    expect(css).toMatch(/--select-soft:\s*var\(--accent-soft\)/);
    expect(css).toMatch(/--brand-line:\s*transparent/);
  });
});

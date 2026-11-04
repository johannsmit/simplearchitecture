import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The colour pairs of the design tokens, recomputed from the CSS the
 * app ships (tokens.css and the card fill in explorer.css), in both themes, with the WCAG 2.x
 * formula. jsdom can't compute contrast (axe's color-contrast rule is off in jsdom), so this is
 * the automated check of them.
 */

// A path, not a URL: jsdom replaces the URL global, which node:fs doesn't accept.
const styles = join(import.meta.dirname, '../src/styles');
const tokensCss = readFileSync(join(styles, 'tokens.css'), 'utf8');
const explorerCss = readFileSync(join(styles, 'explorer.css'), 'utf8');

type Theme = 'light' | 'dark';
const themes: Theme[] = ['light', 'dark'];

const tokens = new Map<string, Record<Theme, string>>();
for (const match of tokensCss.matchAll(
  /--([\w-]+):\s*light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)/gi,
)) {
  const [, name, light, dark] = match;
  if (name && light && dark) tokens.set(name, { light, dark });
}

function token(name: string, theme: Theme): string {
  const value = tokens.get(name)?.[theme];
  if (!value) throw new Error(`token --${name} not found in tokens.css`);
  return value;
}

const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = rgb(hex).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

/** `color-mix(in srgb, a p%, b)`: mixes the gamma-encoded channels, as browsers do. */
function mix(a: string, b: string, share: number): string {
  const [ca, cb] = [rgb(a), rgb(b)];
  return `#${ca
    .map((value, i) => Math.round(value * share + (cb[i] ?? 0) * (1 - share)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

// The card background: `--card-fill: color-mix(in srgb, var(--fill) 55%, var(--surface))`.
const cardMix =
  /--card-fill:\s*color-mix\(in srgb,\s*var\(--fill\)\s*(\d+)%,\s*var\(--surface\)\)/.exec(
    explorerCss,
  );
const cardShare = Number(cardMix?.[1]) / 100;

const colours = ['yellow', 'blue', 'green', 'gray'] as const;

/** A `color-mix(in srgb, var(--a) N%, var(--b))` share in explorer.css, found by its selector. */
function share(pattern: RegExp): number {
  const found = pattern.exec(explorerCss);
  if (!found?.[1]) throw new Error(`not found in explorer.css: ${String(pattern)}`);
  return Number(found[1]) / 100;
}

// The relationship pill's pressed and open + hover fills.
const pressedShare = share(
  /\.cpill:active \{[^}]*color-mix\(in srgb, var\(--accent\) (\d+)%, var\(--surface-raised\)\)/,
);
const openHoverShare = share(
  /\.cpill\[aria-expanded='true'\]:hover \{[^}]*color-mix\(in srgb, var\(--accent\) (\d+)%, var\(--text\)\)/,
);
// The dimmed card fill.
const dimShare = share(
  /\.is-dim \.card \{[^}]*--card-fill: color-mix\(in srgb, var\(--fill\) (\d+)%, var\(--canvas\)\)/,
);

// A container's body fill, and the dimmed body fill.
const bodyShare = share(
  /\.card\.is-container \{[^}]*--body-fill: color-mix\(in srgb, var\(--fill\) (\d+)%, var\(--surface\)\)/,
);
const dimBodyShare = share(
  /\.is-dim \.card\.is-container \{[^}]*--body-fill: color-mix\(in srgb, var\(--fill\) (\d+)%, var\(--canvas\)\)/,
);

describe('colour contrast of the design tokens (WCAG 2.x)', () => {
  it('finds every token and the card fill in the CSS', () => {
    expect(tokens.size).toBeGreaterThanOrEqual(30);
    expect(cardShare).toBeGreaterThan(0);
    expect(cardShare).toBeLessThanOrEqual(1);
  });

  describe.each(themes)('%s theme', (theme) => {
    const t = (name: string) => token(name, theme);

    it.each(colours)(
      '%s cards: text 4.5:1 on the card fill, border 3:1 on the canvas',
      (colour) => {
        const cardFill = mix(t(`${colour}-fill`), t('surface'), cardShare);
        // The name, and the Stakeholder icon (--card-type).
        expect(contrast(t('text'), cardFill)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('card-type'), cardFill)).toBeGreaterThanOrEqual(4.5);
        // The card border is the only edge of the card (1.4.11 non-text contrast).
        expect(contrast(t(`${colour}-line`), t('canvas'))).toBeGreaterThanOrEqual(3);
        expect(contrast(t(`${colour}-line`), cardFill)).toBeGreaterThanOrEqual(3);
        // The keyboard focus ring (--focus is --accent) sits 2px outside the card, on the canvas.
        expect(contrast(t('accent'), t('canvas'))).toBeGreaterThanOrEqual(3);
        // Details panel header: the full type fill behind the name and the type label.
        expect(contrast(t('text'), t(`${colour}-fill`))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('card-type'), t(`${colour}-fill`))).toBeGreaterThanOrEqual(4.5);
      },
    );

    it('text, muted text and links on every surface', () => {
      for (const surface of ['bg', 'surface', 'surface-2', 'surface-raised']) {
        expect(contrast(t('text'), t(surface)), surface).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('text-muted'), t(surface)), surface).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('accent'), t(surface)), surface).toBeGreaterThanOrEqual(4.5);
      }
      // The focused element's tree row: accent text on accent-soft.
      expect(contrast(t('accent'), t('accent-soft'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t('on-accent'), t('accent'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t('on-critical'), t('critical'))).toBeGreaterThanOrEqual(4.5);
    });

    // Form field edges, the mode pills and the form notes.
    it('form fields, the mode pills and the form notes', () => {
      for (const surface of ['surface', 'surface-raised']) {
        expect(contrast(t('field-border'), t(surface)), surface).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(t('text-muted'), t('surface-2'))).toBeGreaterThanOrEqual(4.5);
      for (const soft of ['critical-soft', 'warning-soft', 'info-soft']) {
        expect(contrast(t('text'), t(soft)), soft).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(t('accent'), t('surface-raised'))).toBeGreaterThanOrEqual(3);
    });

    it('status colours on the surface and on their soft backgrounds (chips, badges)', () => {
      for (const status of ['positive', 'info', 'warning', 'critical']) {
        expect(contrast(t(status), t('surface')), status).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t(status), t(`${status}-soft`)), status).toBeGreaterThanOrEqual(4.5);
      }
    });

    // The relationship pill (on the card's top border, so half
    // on the card fill and half on the canvas), the Stakeholder circle and dimmed cards.
    it.each(colours)(
      '%s cards: the relationship pill, the circle and the dimmed card',
      (colour) => {
        const cardFill = mix(t(`${colour}-fill`), t('surface'), cardShare);
        const dimFill = mix(t(`${colour}-fill`), t('canvas'), dimShare);
        const line = t(`${colour}-line`);
        const raised = t('surface-raised');
        const pressed = mix(t('accent'), raised, pressedShare);
        const openHover = mix(t('accent'), t('text'), openHoverShare);
        // The number at rest, on hover and pressed; --on-accent when open, and open + hover.
        expect(contrast(t('text'), raised)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('text'), t('accent-soft'))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('text'), pressed)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('on-accent'), t('accent'))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('on-accent'), openHover)).toBeGreaterThanOrEqual(4.5);
        // The icon (--accent) at rest, on hover and pressed.
        for (const fill of [raised, t('accent-soft'), pressed]) {
          expect(contrast(t('accent'), fill)).toBeGreaterThanOrEqual(3);
        }
        // The pill's border (--line, or --accent on hover, pressed and open), the focus rings and
        // the state badge's border, on the card fill and on the canvas.
        for (const behind of [cardFill, t('canvas')]) {
          expect(contrast(line, behind)).toBeGreaterThanOrEqual(3);
          expect(contrast(t('accent'), behind)).toBeGreaterThanOrEqual(3);
        }
        // The state badge's word.
        expect(contrast(t('text'), t('surface'))).toBeGreaterThanOrEqual(4.5);
        // The circle: the label on the canvas (dimmed: --text-muted), the border on the canvas, the
        // user icon on the card fill (dimmed: --text-muted on the dimmed fill).
        expect(contrast(t('text'), t('canvas'))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('text-muted'), t('canvas'))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('card-type'), cardFill)).toBeGreaterThanOrEqual(3);
        expect(contrast(t('text-muted'), dimFill)).toBeGreaterThanOrEqual(3);
        // Dimmed card: --text-muted on the dimmed fill, and the dimmed pill's number and border.
        expect(contrast(t('text-muted'), dimFill)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('text-muted'), raised)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t('text-muted'), t('canvas'))).toBeGreaterThanOrEqual(3);
      },
    );

    it('the dashed move-mode focus ring 3:1 on the canvas', () => {
      // --focus is var(--accent).
      expect(tokensCss).toMatch(/--focus:\s*var\(--accent\)/);
      expect(contrast(t('accent'), t('canvas'))).toBeGreaterThanOrEqual(3);
    });

    it('relationship lines 3:1 on the canvas', () => {
      expect(contrast(t('edge'), t('canvas'))).toBeGreaterThanOrEqual(3);
      expect(contrast(t('accent'), t('canvas'))).toBeGreaterThanOrEqual(3);
    });

    // The element list filter and the edge state marks.
    it('the filter button, popover, chips and result line', () => {
      const raised = t('surface-raised');
      const chipHover = mix(t('accent'), t('accent-soft'), 0.18);
      expect(explorerCss).toMatch(
        /\.chip-x:hover\s*\{\s*background:\s*color-mix\(in srgb, var\(--accent\) 18%, var\(--accent-soft\)\)/,
      );
      const pairs: [string, string, number][] = [
        [t('text-muted'), t('surface'), 3], // filter icon at rest
        [t('accent'), t('accent-soft'), 3], // filter icon active
        [t('accent'), t('surface'), 3], // active border
        [t('on-accent'), t('accent'), 4.5], // count badge
        [t('text'), raised, 4.5], // popover text
        [t('text'), t('surface-2'), 4.5], // popover text on hover
        [t('text-muted'), raised, 4.5], // (not set), zero rows, headings
        [t('text-muted'), t('surface-2'), 4.5], // .count
        [t('accent'), t('accent-soft'), 4.5], // picked count
        [t('accent'), raised, 3], // checkbox
        [t('text'), t('accent-soft'), 4.5], // chip values
        [t('text-muted'), t('accent-soft'), 4.5], // chip field label and × icon
        [t('text'), chipHover, 3], // × icon on hover
        [t('accent'), t('surface'), 4.5], // Clear all, Clear, Clear filters
        [t('text-muted'), t('surface'), 4.5], // result line
        [t('accent'), t('surface'), 3], // focus ring
        [t('accent'), raised, 3], // focus ring in the popover
      ];
      for (const [fg, bg, needs] of pairs) {
        expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(needs);
      }
    });

    // Containers, nested circles, Contains lines, the switch.
    it.each(colours)('%s containers, nested elements and Contains lines', (colour) => {
      const cardFill = mix(t(`${colour}-fill`), t('surface'), cardShare);
      const bodyFill = mix(t(`${colour}-fill`), t('surface'), bodyShare);
      const dimFill = mix(t(`${colour}-fill`), t('canvas'), dimShare);
      const dimBody = mix(t(`${colour}-fill`), t('canvas'), dimBodyShare);
      const line = t(`${colour}-line`);
      const pairs: [string, string, string, number][] = [
        ['header name on the card fill', t('text'), cardFill, 4.5],
        ['circle label on the body fill', t('text'), bodyFill, 4.5],
        ['container border on the canvas', line, t('canvas'), 3],
        ['type mark border on the card fill', line, cardFill, 3],
        ['Contains line and diamond on the canvas', t('edge'), t('canvas'), 3],
        ['Contains line and diamond on the body fill', t('edge'), bodyFill, 3],
        ['lit edge and focus ring on the body fill', t('accent'), bodyFill, 3],
        ['focus ring on the canvas', t('accent'), t('canvas'), 3],
        ['dimmed header name', t('text-muted'), dimFill, 4.5],
        ['dimmed circle label on the dimmed body', t('text-muted'), dimBody, 4.5],
        ['switch off: border and knob', t('text-muted'), t('surface'), 3],
        ['switch on: track', t('accent'), t('surface'), 3],
        ['switch on: knob', t('on-accent'), t('accent'), 3],
        ['switch label', t('text'), t('surface'), 4.5],
      ];
      for (const [what, fg, bg, needs] of pairs) {
        expect(contrast(fg, bg), what).toBeGreaterThanOrEqual(needs);
      }
      // A child card's border on every body fill (any type inside any type).
      for (const other of colours) {
        const otherBody = mix(t(`${other}-fill`), t('surface'), bodyShare);
        expect(
          contrast(line, otherBody),
          `${colour} border on ${other} body`,
        ).toBeGreaterThanOrEqual(3);
      }
    });

    it('edge state marks on the canvas and in lit labels', () => {
      for (const status of ['info', 'warning']) {
        expect(contrast(t(status), t('canvas')), status).toBeGreaterThanOrEqual(3);
        expect(contrast(t('on-accent'), t(status)), status).toBeGreaterThanOrEqual(3);
        expect(contrast(t(status), t('surface')), status).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(t('edge'), t('canvas'))).toBeGreaterThanOrEqual(3);
    });
  });
});

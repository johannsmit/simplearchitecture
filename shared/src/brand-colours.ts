/**
 * The brand colours worked out per theme. The API stores only the two
 * hex values; the browser turns them into the four tokens (`--accent`, `--accent-soft`,
 * `--select-soft`, `--brand-line`) for the light and the dark theme, adjusting a colour that
 * doesn't reach its contrast target. Colour maths in OKLCH; contrast is the WCAG 2.x ratio.
 */

/** The only colour form ever written into CSS: `#` and six lower-case hex digits. */
export const hexColourPattern = /^#[0-9a-f]{6}$/;

export function isHexColour(value: unknown): value is string {
  return typeof value === 'string' && hexColourPattern.test(value);
}

export type BrandTheme = 'light' | 'dark';
export const brandThemes: readonly BrandTheme[] = ['light', 'dark'];

/**
 * The neutral tokens and the backgrounds the accent must reach 4.5:1 on, as in
 * `frontend/src/styles/tokens.css` (keep in sync; a test compares them).
 */
export const neutralBrandTokens = {
  light: {
    accent: '#3657d6',
    accentSoft: '#e8edfd',
    onAccent: '#ffffff',
    surface: '#ffffff',
    backgrounds: ['#ffffff', '#f5f6f8', '#f0f2f5', '#f7f8fa'],
  },
  dark: {
    accent: '#8fa6ff',
    accentSoft: '#1e2747',
    onAccent: '#0f1218',
    surface: '#161a22',
    backgrounds: ['#0f1218', '#161a22', '#1d222c', '#20252f'],
  },
} as const;

/** Contrast targets (WCAG 2.x): text and controls, and the header line (decoration, 3:1). */
export const accentContrast = 4.5;
export const brandLineContrast = 3;

// --- sRGB and OKLab (Björn Ottosson's matrices) ---

const channels = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG 2.x contrast ratio of two `#rrggbb` colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

/** A ratio rounded down to one decimal, so 4.49 never shows as "4.5:1". */
export function formatRatio(ratio: number): string {
  return `${(Math.floor(ratio * 10 + 1e-9) / 10).toFixed(1)}:1`;
}

export interface Oklch {
  l: number;
  c: number;
  /** Degrees. */
  h: number;
}

export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

/** Linear sRGB of an OKLCH colour (may lie outside 0..1 when out of gamut). */
function oklchToLinear({ l: L, c, h }: Oklch): [number, number, number] {
  const radians = (h * Math.PI) / 180;
  const A = c * Math.cos(radians);
  const B = c * Math.sin(radians);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: number[]): boolean => rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);

const hexByte = (v: number): string =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0');

/** An OKLCH colour as `#rrggbb`; outside sRGB, C is lowered (same L and H) until it fits. */
export function oklchToHex(colour: Oklch): string {
  const l = Math.min(1, Math.max(0, colour.l));
  let rgb = oklchToLinear({ ...colour, l });
  if (!inGamut(rgb)) {
    let low = 0;
    let high = colour.c;
    for (let i = 0; i < 30; i++) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear({ l, c: mid, h: colour.h }))) low = mid;
      else high = mid;
    }
    rgb = oklchToLinear({ l, c: low, h: colour.h });
  }
  return `#${rgb.map((v) => hexByte(toGamma(Math.min(1, Math.max(0, v))))).join('')}`;
}

// --- The tokens ---

/** A pale tint at a fixed lightness with capped chroma (grey stays grey). */
function tint(hex: string, theme: BrandTheme): string {
  const { c, h } = hexToOklch(hex);
  const cap = theme === 'light' ? 0.03 : 0.06;
  return oklchToHex({ l: theme === 'light' ? 0.95 : 0.27, c: c < 0.01 ? 0 : Math.min(c, cap), h });
}

const lowest = (hex: string, backgrounds: readonly string[]): number =>
  Math.min(...backgrounds.map((bg) => contrastRatio(hex, bg)));

/**
 * The colour as entered when it reaches `target` on every background; otherwise
 * its OKLCH lightness stepped by 0.01 (down in light, up in dark) until it does. Each check is on
 * the final hex. Black passes on the light backgrounds and white on the dark ones, so it ends.
 */
function reach(
  hex: string,
  backgrounds: readonly string[],
  target: number,
  theme: BrandTheme,
): string {
  if (lowest(hex, backgrounds) >= target) return hex;
  const start = hexToOklch(hex);
  const direction = theme === 'light' ? -1 : 1;
  for (let step = 1; step <= 100; step++) {
    const candidate = oklchToHex({ ...start, l: start.l + direction * step * 0.01 });
    if (lowest(candidate, backgrounds) >= target) return candidate;
  }
  return theme === 'light' ? '#000000' : '#ffffff';
}

/** The token values for one theme (always complete: neutral where a colour isn't set). */
export interface ThemeBrandTokens {
  accent: string;
  accentSoft: string;
  /** The secondary's tint, or `accentSoft` when no secondary is set. */
  selectSoft: string;
  /** Null when no secondary is set (no line). */
  brandLine: string | null;
  onAccent: string;
}

/** What the page reports for one value in one theme. */
export interface BrandValueReport {
  /** The final hex (null: not set, e.g. no header line). */
  value: string | null;
  /** The colour as entered (null: not set, the neutral value applies). */
  entered: string | null;
  /** The final hex differs from the entered one. */
  adjusted: boolean;
  /** The lowest contrast against its backgrounds (null when there is no value). */
  ratio: number | null;
}

export interface ThemeBrandReport {
  accent: BrandValueReport;
  onAccent: BrandValueReport;
  brandLine: BrandValueReport;
  /** Its ratio is the accent's on it. */
  accentSoft: BrandValueReport;
  /** Its ratio is the accent's on it. */
  selectSoft: BrandValueReport;
}

export interface BrandTokens {
  /** The inputs, lower case; null when not set or not `#rrggbb`. */
  primary: string | null;
  secondary: string | null;
  light: ThemeBrandTokens;
  dark: ThemeBrandTokens;
  report: Record<BrandTheme, ThemeBrandReport>;
}

const valid = (value: string | null | undefined): string | null => {
  const lower = typeof value === 'string' ? value.toLowerCase() : null;
  return isHexColour(lower) ? lower : null;
};

function themeTokens(
  primary: string | null,
  secondary: string | null,
  theme: BrandTheme,
): { tokens: ThemeBrandTokens; report: ThemeBrandReport } {
  const neutral = neutralBrandTokens[theme];
  const accentSoft = primary ? tint(primary, theme) : neutral.accentSoft;
  const selectSoft = secondary ? tint(secondary, theme) : accentSoft;
  const backgrounds = [...neutral.backgrounds, accentSoft, selectSoft];
  const accent = primary ? reach(primary, backgrounds, accentContrast, theme) : neutral.accent;
  const brandLine = secondary
    ? reach(secondary, [neutral.surface], brandLineContrast, theme)
    : null;
  const tokens: ThemeBrandTokens = {
    accent,
    accentSoft,
    selectSoft,
    brandLine,
    onAccent: neutral.onAccent,
  };
  const report: ThemeBrandReport = {
    accent: {
      value: accent,
      entered: primary,
      adjusted: primary !== null && accent !== primary,
      ratio: lowest(accent, backgrounds),
    },
    onAccent: {
      value: neutral.onAccent,
      entered: null,
      adjusted: false,
      ratio: contrastRatio(neutral.onAccent, accent),
    },
    brandLine: {
      value: brandLine,
      entered: secondary,
      adjusted: secondary !== null && brandLine !== secondary,
      ratio: brandLine === null ? null : contrastRatio(brandLine, neutral.surface),
    },
    accentSoft: {
      value: accentSoft,
      entered: primary,
      adjusted: false,
      ratio: contrastRatio(accent, accentSoft),
    },
    selectSoft: {
      value: selectSoft,
      entered: secondary,
      adjusted: false,
      ratio: contrastRatio(accent, selectSoft),
    },
  };
  return { tokens, report };
}

/** Both themes' tokens and the report, from the two colours (null: not set). */
export function brandTokens(input: {
  primary: string | null | undefined;
  secondary: string | null | undefined;
}): BrandTokens {
  const primary = valid(input.primary);
  const secondary = valid(input.secondary);
  const light = themeTokens(primary, secondary, 'light');
  const dark = themeTokens(primary, secondary, 'dark');
  return {
    primary,
    secondary,
    light: light.tokens,
    dark: dark.tokens,
    report: { light: light.report, dark: dark.report },
  };
}

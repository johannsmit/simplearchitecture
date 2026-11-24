/**
 * The organisation's branding (Admin → Branding): a product title, a primary and a secondary
 * colour, a logo, a logo for the Dark theme and an app icon.
 */

/**
 * Response body of `GET /api/branding` (public, also signed out) and of every Admin change.
 * Colours are `#rrggbb` in lower case, or null for the neutral look. `title` is plain text, or
 * null for the default product title. The image URLs change with the version, so the images can
 * be cached for long.
 */
export interface Branding {
  title: string | null;
  primary: string | null;
  secondary: string | null;
  logoUrl: string | null;
  /** The logo for the Dark theme; without it, the Dark theme shows `logoUrl`. */
  darkLogoUrl: string | null;
  /** The app icon (tab, home screen and installed app); without it, the built-in icons. */
  iconUrl: string | null;
  version: number;
}

/** Body of `PUT /api/admin/branding`. Both colours are sent; null removes one. */
export interface UpdateBrandingColoursRequest {
  primary: string | null;
  secondary: string | null;
  /** The version read. */
  version: number;
}

/** Body of `PUT /api/admin/branding/title`. Null or empty (after trimming) removes the title. */
export interface UpdateBrandingTitleRequest {
  title: string | null;
  /** The version read. */
  version: number;
}

/** The product name when no title is set. */
export const defaultProductTitle = 'SimpleArchitecture';
/** Longest product title, in Unicode code points. */
export const maxProductTitleLength = 40;

export const productTitleTooLongMessage = 'The product title must be at most 40 characters.';
export const productTitleCharactersMessage =
  "The product title can't contain line breaks or control characters.";

/** Line breaks and control characters: C0, DEL, C1, and the line and paragraph separators. */
const forbiddenInTitle = /[\p{Cc}\u2028\u2029]/u;

/** The length of a title as people count it (code points, not UTF-16 units). */
export function productTitleLength(text: string): number {
  return Array.from(text).length;
}

/** Why a title (already trimmed) is refused, or null when it may be stored. */
export function productTitleIssue(text: string): string | null {
  if (forbiddenInTitle.test(text)) return productTitleCharactersMessage;
  if (productTitleLength(text) > maxProductTitleLength) return productTitleTooLongMessage;
  return null;
}

/** A stored title that passes the rules, or null (the default) for anything else. */
export function validProductTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed === value && productTitleIssue(trimmed) === null
    ? trimmed
    : null;
}

/** The logo types accepted (checked by the file's first bytes, never by its name). */
export const logoMediaTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoMediaType = (typeof logoMediaTypes)[number];

/** Largest logo file (bytes): 300 KB. */
export const maxLogoBytes = 300 * 1024;
/** Largest logo width and height (pixels). */
export const maxLogoPixels = 1024;

/** The app icon: a PNG of exactly this width and height, up to maxLogoBytes. */
export const iconMediaType = 'image/png';
export const iconPixels = 512;

export const brandingConflictMessage =
  'Someone else changed the branding after you opened it. Reload to see their change. Nothing was saved.';
export const logoTypeMessage = 'The logo must be a PNG, JPEG or WebP image.';
export const logoTooLargeMessage = 'The logo must be at most 300 KB.';
export const darkLogoTypeMessage = 'The Dark theme logo must be a PNG, JPEG or WebP image.';
export const darkLogoTooLargeMessage = 'The Dark theme logo must be at most 300 KB.';
export const iconTypeMessage = 'The app icon must be a PNG image.';
export const iconTooLargeMessage = 'The app icon must be at most 300 KB.';
export function iconSizeMessage(width: number, height: number): string {
  return `The app icon must be ${iconPixels} × ${iconPixels} pixels. This one is ${width} × ${height}.`;
}

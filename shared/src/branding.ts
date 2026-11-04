/**
 * The organisation's branding (Admin → Branding): a primary and a secondary colour and a logo.
 * Branding needs PostgreSQL; without a database everyone sees the neutral look and the Admin
 * routes answer 501 with `brandingUnavailableMessage`.
 */

/**
 * Response body of `GET /api/branding` (public, also signed out) and of every Admin change.
 * Colours are `#rrggbb` in lower case, or null for the neutral look. `logoUrl` changes with the
 * version, so the logo can be cached for long. `version` is 0 without a database.
 */
export interface Branding {
  primary: string | null;
  secondary: string | null;
  logoUrl: string | null;
  version: number;
}

/** Body of `PUT /api/admin/branding`. Both colours are sent; null removes one. */
export interface UpdateBrandingColoursRequest {
  primary: string | null;
  secondary: string | null;
  /** The version read. */
  version: number;
}

/** The logo types accepted (checked by the file's first bytes, never by its name). */
export const logoMediaTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type LogoMediaType = (typeof logoMediaTypes)[number];

/** Largest logo file (bytes): 300 KB. */
export const maxLogoBytes = 300 * 1024;
/** Largest logo width and height (pixels). */
export const maxLogoPixels = 1024;

export const brandingUnavailableMessage =
  'Branding needs a database. Ask your administrator to set up PostgreSQL.';
export const brandingConflictMessage =
  'Someone else changed the branding after you opened it. Reload to see their change. Nothing was saved.';
export const logoTypeMessage = 'The logo must be a PNG, JPEG or WebP image.';
export const logoTooLargeMessage = 'The logo must be at most 300 KB.';

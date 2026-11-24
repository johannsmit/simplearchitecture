import {
  brandingConflictMessage,
  darkLogoTooLargeMessage,
  darkLogoTypeMessage,
  iconMediaType,
  iconPixels,
  iconSizeMessage,
  iconTooLargeMessage,
  iconTypeMessage,
  logoMediaTypes,
  logoTooLargeMessage,
  logoTypeMessage,
  maxLogoBytes,
  maxLogoPixels,
  productTitleIssue,
  type Branding,
  type LogoMediaType,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { z } from 'zod';
import type { Db, Queryable } from '../db/db.js';
import {
  ConflictError,
  deleteSchema,
  parse,
  RejectedError,
  versionSchema,
} from '../editing/common.js';
import { inspectImage } from './image.js';

/**
 * The organisation's product title, colours, logos and app icon (Admin → Branding): the rules live here, so the REST routes
 * and a future MCP server behave the same. Input is `unknown` (or raw bytes) and checked here.
 *
 * - Every change carries the version read; another one is a conflict (ConflictError).
 * - A refused change stores nothing. Every stored change bumps the version and writes one audit
 *   row in the same transaction, with the changed field names only (never a title, colours or bytes). A
 *   change that changes nothing stores and audits nothing.
 */

/** An image isn't of an accepted type (by its bytes), or was sent as another type. */
export class LogoTypeError extends Error {
  override name = 'LogoTypeError';
  constructor(message: string = logoTypeMessage) {
    super(message);
  }
}

/** An image is larger than maxLogoBytes. */
export class LogoTooLargeError extends Error {
  override name = 'LogoTooLargeError';
  constructor(message: string = logoTooLargeMessage) {
    super(message);
  }
}

/** The three stored images: the logo, the logo for the Dark theme and the app icon. */
export type BrandImage = 'logo' | 'darkLogo' | 'icon';

export type BrandingAuditAction =
  | 'branding-colours-changed'
  | 'branding-title-set'
  | 'branding-title-removed'
  | `branding-${'logo' | 'dark-logo' | 'icon'}-${'set' | 'removed'}`
  | 'branding-reset';

interface ImageRules {
  /** The column holding the bytes; `<column>_type` holds the media type. */
  column: 'logo' | 'dark_logo' | 'icon';
  /** The public path, the audit's field name and the action's middle part. */
  path: 'logo' | 'dark-logo' | 'icon';
  field: BrandImage;
  noun: string;
  types: readonly LogoMediaType[];
  typeMessage: string;
  tooLargeMessage: string;
  /** Why these dimensions are refused, or null. */
  sizeIssue: (width: number, height: number) => string | null;
}

const withinLogoPixels = (noun: string) => (width: number, height: number) =>
  width > maxLogoPixels || height > maxLogoPixels
    ? `${noun} must be at most ${maxLogoPixels} × ${maxLogoPixels} pixels. This one is ${width} × ${height}.`
    : null;

export const imageRules: Record<BrandImage, ImageRules> = {
  logo: {
    column: 'logo',
    path: 'logo',
    field: 'logo',
    noun: 'the logo',
    types: logoMediaTypes,
    typeMessage: logoTypeMessage,
    tooLargeMessage: logoTooLargeMessage,
    sizeIssue: withinLogoPixels('The logo'),
  },
  darkLogo: {
    column: 'dark_logo',
    path: 'dark-logo',
    field: 'darkLogo',
    noun: 'the Dark theme logo',
    types: logoMediaTypes,
    typeMessage: darkLogoTypeMessage,
    tooLargeMessage: darkLogoTooLargeMessage,
    sizeIssue: withinLogoPixels('The Dark theme logo'),
  },
  icon: {
    column: 'icon',
    path: 'icon',
    field: 'icon',
    noun: 'the app icon',
    types: [iconMediaType],
    typeMessage: iconTypeMessage,
    tooLargeMessage: iconTooLargeMessage,
    sizeIssue: (width, height) =>
      width === iconPixels && height === iconPixels ? null : iconSizeMessage(width, height),
  },
};

/** An image's versioned URL; any other `v` is served without long caching. */
export function imageUrl(image: BrandImage, version: number): string {
  return `/api/branding/${imageRules[image].path}?v=${version}`;
}

/** The versioned logo URL. */
export function logoUrl(version: number): string {
  return imageUrl('logo', version);
}

const colourMessage = 'Enter a colour as # and six hexadecimal digits, for example #1a6fb0.';
const colourSchema = z
  .string({ error: colourMessage })
  .regex(/^#[0-9a-fA-F]{6}$/, { error: colourMessage })
  .transform((colour) => colour.toLowerCase())
  .nullable();

const coloursSchema = z.strictObject({
  primary: colourSchema,
  secondary: colourSchema,
  version: versionSchema,
});

const titleTypeMessage = 'Enter the product title as text.';
/** Trimmed; empty is no title (the default). Plain text, never markup: it is shown as text. */
const titleSchema = z.strictObject({
  title: z
    .string({ error: titleTypeMessage })
    .max(4096, { error: 'The product title must be at most 40 characters.' })
    .trim()
    .superRefine((title, context) => {
      const issue = productTitleIssue(title);
      if (issue !== null) context.addIssue({ code: 'custom', message: issue });
    })
    .transform((title) => (title === '' ? null : title))
    .nullable(),
  version: versionSchema,
});

interface Row {
  title: string | null;
  primary_colour: string | null;
  secondary_colour: string | null;
  has_logo: boolean;
  has_dark_logo: boolean;
  has_icon: boolean;
  version: number;
}

const rowColumns = `title, primary_colour, secondary_colour, logo is not null as has_logo,
  dark_logo is not null as has_dark_logo, icon is not null as has_icon, version`;
const hasImage = { logo: 'has_logo', darkLogo: 'has_dark_logo', icon: 'has_icon' } as const;
// The row is made by migration 004; this keeps a write working if it was ever removed.
const ensureRow = 'insert into branding (id) values (1) on conflict (id) do nothing';
const lockRow = `select ${rowColumns} from branding where id = 1 for update`;
const insertAudit = `insert into audit (action, user_id, user_name, details)
  values ($1, $2, $3, $4::text::jsonb)`;

function toBranding(row: Row | undefined): Branding {
  // The neutral look until a change makes the row.
  if (row === undefined) {
    return {
      title: null,
      primary: null,
      secondary: null,
      logoUrl: null,
      darkLogoUrl: null,
      iconUrl: null,
      version: 1,
    };
  }
  return {
    title: row.title,
    primary: row.primary_colour,
    secondary: row.secondary_colour,
    logoUrl: row.has_logo ? imageUrl('logo', row.version) : null,
    darkLogoUrl: row.has_dark_logo ? imageUrl('darkLogo', row.version) : null,
    iconUrl: row.has_icon ? imageUrl('icon', row.version) : null,
    version: row.version,
  };
}

const columnCasts = {
  title: 'text',
  primary_colour: 'text',
  secondary_colour: 'text',
  logo: 'bytea',
  logo_type: 'text',
  dark_logo: 'bytea',
  dark_logo_type: 'text',
  icon: 'bytea',
  icon_type: 'text',
} as const;

/** What a change writes: the columns to set (by name) and the audit's field names. */
interface Write {
  set: Partial<Record<keyof typeof columnCasts, string | Uint8Array | null>>;
  fields: string[];
}

export interface StoredLogo {
  bytes: Uint8Array;
  type: LogoMediaType;
  version: number;
}

function isLogoType(value: unknown, types: readonly LogoMediaType[]): value is LogoMediaType {
  return (types as readonly unknown[]).includes(value);
}

/** The media type of a Content-Type header value, without parameters, in lower case. */
function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

export class BrandingService {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** The current branding. */
  async get(): Promise<Branding> {
    const [row] = await this.#db.query<Row>(`select ${rowColumns} from branding where id = 1`);
    return toBranding(row);
  }

  /** A stored image, or undefined when there is none. */
  async getImage(image: BrandImage): Promise<StoredLogo | undefined> {
    const rules = imageRules[image];
    // The column names come from the fixed rules above.
    const [row] = await this.#db.query<{
      bytes: Uint8Array | null;
      type: string | null;
      version: number;
    }>(
      `select ${rules.column} as bytes, ${rules.column}_type as type, version from branding where id = 1`,
    );
    if (!row || row.bytes === null || !isLogoType(row.type, rules.types)) return undefined;
    return { bytes: row.bytes, type: row.type, version: row.version };
  }

  /** The stored logo, or undefined when there is none. */
  async getLogo(): Promise<StoredLogo | undefined> {
    return this.getImage('logo');
  }

  /** Sets both colours (`#rrggbb`, any case, stored in lower case; null removes one). */
  async setColours(input: unknown, actor: ModelAuthor): Promise<Branding> {
    const db = this.#db;
    const request = parse(coloursSchema, input, 'the colours');
    return this.#change(db, request.version, 'branding-colours-changed', actor, (current) => {
      const write: Write = { set: {}, fields: [] };
      if (request.primary !== current.primary_colour) {
        write.set.primary_colour = request.primary;
        write.fields.push('primary');
      }
      if (request.secondary !== current.secondary_colour) {
        write.set.secondary_colour = request.secondary;
        write.fields.push('secondary');
      }
      return write;
    });
  }

  /**
   * Sets the product title (`{ title, version }`): trimmed, 1–40 characters on one line; null or
   * empty removes it, so the default product name shows.
   */
  async setTitle(input: unknown, actor: ModelAuthor): Promise<Branding> {
    const db = this.#db;
    const request = parse(titleSchema, input, 'the product title');
    const action = request.title === null ? 'branding-title-removed' : 'branding-title-set';
    return this.#change(db, request.version, action, actor, (current) =>
      request.title === current.title
        ? { set: {}, fields: [] }
        : { set: { title: request.title }, fields: ['title'] },
    );
  }

  /**
   * Stores a new logo. `contentType` is the declared type: it must be one of the logo types, and
   * the file's own bytes decide which type is stored. `query` carries the version (`{ version }`).
   */
  async setLogo(
    bytes: Uint8Array,
    contentType: string | undefined,
    query: unknown,
    actor: ModelAuthor,
  ): Promise<Branding> {
    return this.setImage('logo', bytes, contentType, query, actor);
  }

  /**
   * Stores a new image (`logo`, `darkLogo` or `icon`) under its own rules: the declared type must
   * be one it accepts, and the file's own bytes decide which type is stored.
   */
  async setImage(
    image: BrandImage,
    bytes: Uint8Array,
    contentType: string | undefined,
    query: unknown,
    actor: ModelAuthor,
  ): Promise<Branding> {
    const db = this.#db;
    const rules = imageRules[image];
    const { version } = parse(deleteSchema, query, rules.noun);
    if (!isLogoType(mediaType(contentType), rules.types)) {
      throw new LogoTypeError(rules.typeMessage);
    }
    if (bytes.length > maxLogoBytes) throw new LogoTooLargeError(rules.tooLargeMessage);
    const inspected = inspectImage(bytes);
    if (inspected.kind === 'unknown' || !rules.types.includes(inspected.type)) {
      throw new LogoTypeError(rules.typeMessage);
    }
    if (inspected.kind === 'damaged') {
      throw new RejectedError([
        {
          field: rules.field,
          message: 'The image file is damaged or incomplete. Try another file.',
        },
      ]);
    }
    const sizeIssue = rules.sizeIssue(inspected.width, inspected.height);
    if (sizeIssue !== null) throw new RejectedError([{ field: rules.field, message: sizeIssue }]);
    // A copy (the caller's buffer may be reused), as a Buffer: both drivers store it as bytea.
    const stored = Buffer.from(bytes);
    return this.#change(db, version, `branding-${rules.path}-set`, actor, () => ({
      set: { [rules.column]: stored, [`${rules.column}_type`]: inspected.type },
      fields: [rules.field],
    }));
  }

  /** Removes the logo. `query` carries the version (`{ version }`). */
  async removeLogo(query: unknown, actor: ModelAuthor): Promise<Branding> {
    return this.removeImage('logo', query, actor);
  }

  /** Removes an image. `query` carries the version (`{ version }`). */
  async removeImage(image: BrandImage, query: unknown, actor: ModelAuthor): Promise<Branding> {
    const db = this.#db;
    const rules = imageRules[image];
    const { version } = parse(deleteSchema, query, rules.noun);
    return this.#change(db, version, `branding-${rules.path}-removed`, actor, (current) =>
      current[hasImage[image]]
        ? {
            set: { [rules.column]: null, [`${rules.column}_type`]: null },
            fields: [rules.field],
          }
        : { set: {}, fields: [] },
    );
  }

  /**
   * Back to the neutral look: no title, colours, logos or icon. `query` carries the version.
   */
  async reset(query: unknown, actor: ModelAuthor): Promise<Branding> {
    const db = this.#db;
    const { version } = parse(deleteSchema, query, 'the branding');
    return this.#change(db, version, 'branding-reset', actor, (current) => {
      const write: Write = { set: {}, fields: [] };
      if (current.title !== null) {
        write.set.title = null;
        write.fields.push('title');
      }
      if (current.primary_colour !== null) {
        write.set.primary_colour = null;
        write.fields.push('primary');
      }
      if (current.secondary_colour !== null) {
        write.set.secondary_colour = null;
        write.fields.push('secondary');
      }
      for (const image of ['logo', 'darkLogo', 'icon'] as const) {
        if (!current[hasImage[image]]) continue;
        const { column } = imageRules[image];
        Object.assign(write.set, { [column]: null, [`${column}_type`]: null });
        write.fields.push(image);
      }
      return write;
    });
  }

  /**
   * One change in one transaction: the row is locked, the version checked, the columns set, the
   * version bumped and the audit row written. Nothing to set: the current branding, unchanged.
   */
  async #change(
    db: Db,
    version: number,
    action: BrandingAuditAction,
    actor: ModelAuthor,
    plan: (current: Row) => Write,
  ): Promise<Branding> {
    return db.transaction(async (tx: Queryable) => {
      await tx.query(ensureRow);
      const [current] = await tx.query<Row>(lockRow);
      if (current === undefined) throw new Error('branding row missing');
      if (current.version !== version) {
        throw new ConflictError(current.version, brandingConflictMessage);
      }
      const write = plan(current);
      const columns = Object.keys(write.set) as (keyof Write['set'])[];
      if (columns.length === 0) return toBranding(current);
      // Column names come from the fixed list above; every value is a parameter.
      const assignments = columns.map(
        (column, index) => `${column} = $${index + 1}::${columnCasts[column]}`,
      );
      const values = columns.map((column) => write.set[column] ?? null);
      const [updated] = await tx.query<Row>(
        `update branding set ${assignments.join(', ')}, version = version + 1,
          updated_by_id = $${columns.length + 1}, updated_by_name = $${columns.length + 2},
          updated_at = now() where id = 1 returning ${rowColumns}`,
        [...values, actor.id, actor.name],
      );
      await tx.query(insertAudit, [
        action,
        actor.id,
        actor.name,
        JSON.stringify({ fields: write.fields }),
      ]);
      return toBranding(updated);
    });
  }
}

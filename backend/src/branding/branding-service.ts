import {
  brandingConflictMessage,
  brandingUnavailableMessage,
  logoMediaTypes,
  logoTooLargeMessage,
  logoTypeMessage,
  maxLogoBytes,
  maxLogoPixels,
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
 * The organisation's colours and logo (Admin → Branding): the rules live here, so the REST routes
 * and a future MCP server behave the same. Input is `unknown` (or raw bytes) and checked here.
 *
 * - Branding needs PostgreSQL. Without it, `get` gives the neutral look (version 0) and every
 *   change throws BrandingUnavailableError.
 * - Every change carries the version read; another one is a conflict (ConflictError).
 * - A refused change stores nothing. Every stored change bumps the version and writes one audit
 *   row in the same transaction, with the changed field names only (never colours or bytes). A
 *   change that changes nothing stores and audits nothing.
 */

/** Branding needs PostgreSQL. User-safe message. */
export class BrandingUnavailableError extends Error {
  override name = 'BrandingUnavailableError';
  constructor() {
    super(brandingUnavailableMessage);
  }
}

/** The logo isn't a PNG, JPEG or WebP file (by its bytes), or was sent as another type. */
export class LogoTypeError extends Error {
  override name = 'LogoTypeError';
  constructor() {
    super(logoTypeMessage);
  }
}

/** The logo is larger than maxLogoBytes. */
export class LogoTooLargeError extends Error {
  override name = 'LogoTooLargeError';
  constructor() {
    super(logoTooLargeMessage);
  }
}

export type BrandingAuditAction =
  'branding-colours-changed' | 'branding-logo-set' | 'branding-logo-removed' | 'branding-reset';

/** The versioned logo URL; any other `v` is served without long caching. */
export function logoUrl(version: number): string {
  return `/api/branding/logo?v=${version}`;
}

const neutral: Branding = { primary: null, secondary: null, logoUrl: null, version: 0 };

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

interface Row {
  primary_colour: string | null;
  secondary_colour: string | null;
  has_logo: boolean;
  version: number;
}

const rowColumns = 'primary_colour, secondary_colour, logo is not null as has_logo, version';
// The row is made by migration 004; this keeps a write working if it was ever removed.
const ensureRow = 'insert into branding (id) values (1) on conflict (id) do nothing';
const lockRow = `select ${rowColumns} from branding where id = 1 for update`;
const insertAudit = `insert into audit (action, user_id, user_name, details)
  values ($1, $2, $3, $4::text::jsonb)`;

function toBranding(row: Row | undefined): Branding {
  if (row === undefined) return { ...neutral, version: 1 };
  return {
    primary: row.primary_colour,
    secondary: row.secondary_colour,
    logoUrl: row.has_logo ? logoUrl(row.version) : null,
    version: row.version,
  };
}

/** What a change writes: the columns to set (by name) and the audit's field names. */
interface Write {
  set: Partial<{
    primary_colour: string | null;
    secondary_colour: string | null;
    logo: Uint8Array | null;
    logo_type: LogoMediaType | null;
  }>;
  fields: string[];
}

const columnCasts = {
  primary_colour: 'text',
  secondary_colour: 'text',
  logo: 'bytea',
  logo_type: 'text',
} as const;

export interface StoredLogo {
  bytes: Uint8Array;
  type: LogoMediaType;
  version: number;
}

function isLogoType(value: unknown): value is LogoMediaType {
  return (logoMediaTypes as readonly unknown[]).includes(value);
}

/** The media type of a Content-Type header value, without parameters, in lower case. */
function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

export class BrandingService {
  readonly #db: Db | undefined;

  constructor(db: Db | undefined) {
    this.#db = db;
  }

  /** Whether branding can be changed (there is a database). */
  get available(): boolean {
    return this.#db !== undefined;
  }

  #database(): Db {
    if (this.#db === undefined) throw new BrandingUnavailableError();
    return this.#db;
  }

  /** The current branding; the neutral look (version 0) without a database. */
  async get(): Promise<Branding> {
    if (this.#db === undefined) return neutral;
    const [row] = await this.#db.query<Row>(`select ${rowColumns} from branding where id = 1`);
    return toBranding(row);
  }

  /** The stored logo, or undefined when there is none (or no database). */
  async getLogo(): Promise<StoredLogo | undefined> {
    if (this.#db === undefined) return undefined;
    const [row] = await this.#db.query<{
      logo: Uint8Array | null;
      logo_type: string | null;
      version: number;
    }>('select logo, logo_type, version from branding where id = 1');
    if (!row || row.logo === null || !isLogoType(row.logo_type)) return undefined;
    return { bytes: row.logo, type: row.logo_type, version: row.version };
  }

  /** Sets both colours (`#rrggbb`, any case, stored in lower case; null removes one). */
  async setColours(input: unknown, actor: ModelAuthor): Promise<Branding> {
    const db = this.#database();
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
   * Stores a new logo. `contentType` is the declared type: it must be one of the logo types, and
   * the file's own bytes decide which type is stored. `query` carries the version (`{ version }`).
   */
  async setLogo(
    bytes: Uint8Array,
    contentType: string | undefined,
    query: unknown,
    actor: ModelAuthor,
  ): Promise<Branding> {
    const db = this.#database();
    const { version } = parse(deleteSchema, query, 'the logo');
    if (!isLogoType(mediaType(contentType))) throw new LogoTypeError();
    if (bytes.length > maxLogoBytes) throw new LogoTooLargeError();
    const image = inspectImage(bytes);
    if (image.kind === 'unknown') throw new LogoTypeError();
    if (image.kind === 'damaged') {
      throw new RejectedError([
        { field: 'logo', message: 'The image file is damaged or incomplete. Try another file.' },
      ]);
    }
    if (image.width > maxLogoPixels || image.height > maxLogoPixels) {
      throw new RejectedError([
        {
          field: 'logo',
          message: `The logo must be at most ${maxLogoPixels} × ${maxLogoPixels} pixels. This one is ${image.width} × ${image.height}.`,
        },
      ]);
    }
    // A copy (the caller's buffer may be reused), as a Buffer: both drivers store it as bytea.
    const logo = Buffer.from(bytes);
    return this.#change(db, version, 'branding-logo-set', actor, () => ({
      set: { logo, logo_type: image.type },
      fields: ['logo'],
    }));
  }

  /** Removes the logo. `query` carries the version (`{ version }`). */
  async removeLogo(query: unknown, actor: ModelAuthor): Promise<Branding> {
    const db = this.#database();
    const { version } = parse(deleteSchema, query, 'the logo');
    return this.#change(db, version, 'branding-logo-removed', actor, (current) =>
      current.has_logo
        ? { set: { logo: null, logo_type: null }, fields: ['logo'] }
        : { set: {}, fields: [] },
    );
  }

  /** Back to the neutral look: no colours and no logo. `query` carries the version. */
  async reset(query: unknown, actor: ModelAuthor): Promise<Branding> {
    const db = this.#database();
    const { version } = parse(deleteSchema, query, 'the branding');
    return this.#change(db, version, 'branding-reset', actor, (current) => {
      const write: Write = { set: {}, fields: [] };
      if (current.primary_colour !== null) {
        write.set.primary_colour = null;
        write.fields.push('primary');
      }
      if (current.secondary_colour !== null) {
        write.set.secondary_colour = null;
        write.fields.push('secondary');
      }
      if (current.has_logo) {
        Object.assign(write.set, { logo: null, logo_type: null });
        write.fields.push('logo');
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

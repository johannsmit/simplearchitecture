import { brandingConflictMessage, maxLogoBytes } from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BrandingService,
  BrandingUnavailableError,
  LogoTooLargeError,
  LogoTypeError,
} from '../src/branding/branding-service.js';
import { ConflictError, RejectedError } from '../src/editing/common.js';
import { jpeg, png, svg, webpLossless } from './images.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

const admin = { id: 'oid-made-up-admin', name: 'Made-up Admin' };

let db: TestDb;
let service: BrandingService;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetTestDb(db);
  service = new BrandingService(db);
});

interface AuditRow {
  action: string;
  user_id: string;
  user_name: string;
  model_id: string | null;
  details: unknown;
}
const auditRows = () =>
  db.query<AuditRow>('select action, user_id, user_name, model_id, details from audit order by id');
const storedRow = async () =>
  (
    await db.query<{ logo: Uint8Array | null; logo_type: string | null; version: number }>(
      'select logo, logo_type, version from branding',
    )
  )[0];

describe('BrandingService without a database', () => {
  it('gives the neutral look, and refuses every change', async () => {
    const none = new BrandingService(undefined);
    expect(none.available).toBe(false);
    expect(await none.get()).toEqual({ primary: null, secondary: null, logoUrl: null, version: 0 });
    expect(await none.getLogo()).toBeUndefined();
    const colours = { primary: '#123456', secondary: null, version: 1 };
    await expect(none.setColours(colours, admin)).rejects.toBeInstanceOf(BrandingUnavailableError);
    await expect(none.setLogo(png(), 'image/png', { version: 1 }, admin)).rejects.toBeInstanceOf(
      BrandingUnavailableError,
    );
    await expect(none.removeLogo({ version: 1 }, admin)).rejects.toBeInstanceOf(
      BrandingUnavailableError,
    );
    await expect(none.reset({ version: 1 }, admin)).rejects.toBeInstanceOf(
      BrandingUnavailableError,
    );
  });
});

describe('BrandingService: storage', () => {
  it('starts neutral at version 1 in a migrated database (the row comes from migration 004)', async () => {
    const fresh = await createTestDb();
    try {
      expect(await fresh.query('select id, version from branding')).toEqual([
        { id: 1, version: 1 },
      ]);
      expect(await new BrandingService(fresh).get()).toEqual({
        primary: null,
        secondary: null,
        logoUrl: null,
        version: 1,
      });
    } finally {
      await fresh.close();
    }
  });

  it('sets the colours in lower case, bumps the version and writes one audit row', async () => {
    const result = await service.setColours(
      { primary: '#1A6FB0', secondary: '#ffcc00', version: 1 },
      admin,
    );
    expect(result).toEqual({ primary: '#1a6fb0', secondary: '#ffcc00', logoUrl: null, version: 2 });
    expect(await service.get()).toEqual(result);
    expect(await auditRows()).toEqual([
      {
        action: 'branding-colours-changed',
        user_id: admin.id,
        user_name: admin.name,
        model_id: null,
        details: { fields: ['primary', 'secondary'] },
      },
    ]);
  });

  it('names only the changed colour, and stores and audits nothing when nothing changes', async () => {
    await service.setColours({ primary: '#111111', secondary: '#222222', version: 1 }, admin);
    const second = await service.setColours(
      { primary: '#111111', secondary: null, version: 2 },
      admin,
    );
    expect(second).toMatchObject({ secondary: null, version: 3 });
    const same = await service.setColours(
      { primary: '#111111', secondary: null, version: 3 },
      admin,
    );
    expect(same.version).toBe(3);
    const rows = await auditRows();
    expect(rows.map((row) => row.details)).toEqual([
      { fields: ['primary', 'secondary'] },
      { fields: ['secondary'] },
    ]);
    // Field names only: never a colour value.
    expect(JSON.stringify(rows)).not.toMatch(/#1111|#2222/);
  });

  it.each([
    [{ primary: '123456', secondary: null, version: 1 }, ['primary']],
    [{ primary: '#12345', secondary: null, version: 1 }, ['primary']],
    [{ primary: '#1234567', secondary: null, version: 1 }, ['primary']],
    [{ primary: ' #123456', secondary: null, version: 1 }, ['primary']],
    [{ primary: '#12345g', secondary: 'red', version: 1 }, ['primary', 'secondary']],
    [{ primary: 'rgb(1,2,3)', secondary: null, version: 1 }, ['primary']],
    [{ primary: 123456, secondary: null, version: 1 }, ['primary']],
    [{ primary: null, version: 1 }, ['secondary']],
    [{ primary: null, secondary: null }, ['version']],
    [{ primary: null, secondary: null, version: 1, logo: 'x' }, ['logo']],
    [null, ['']],
  ])('refuses %j with field messages, and stores nothing', async (input, fields) => {
    const error = await service.setColours(input, admin).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RejectedError);
    expect((error as RejectedError).fields.map((issue) => issue.field)).toEqual(fields);
    expect((await storedRow())?.version ?? 1).toBe(1);
    expect(await auditRows()).toEqual([]);
  });

  it('refuses a stale version with the current one, and stores nothing', async () => {
    await service.setColours({ primary: '#111111', secondary: null, version: 1 }, admin);
    const error = await service
      .setColours({ primary: '#999999', secondary: null, version: 1 }, admin)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).currentVersion).toBe(2);
    expect((error as ConflictError).message).toBe(brandingConflictMessage);
    await expect(service.removeLogo({ version: 1 }, admin)).rejects.toBeInstanceOf(ConflictError);
    await expect(service.reset({ version: '1' }, admin)).rejects.toBeInstanceOf(ConflictError);
    expect((await service.get()).primary).toBe('#111111');
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('BrandingService: the logo', () => {
  it.each([
    ['image/png', png(200, 80)],
    ['image/jpeg', jpeg(200, 80)],
    ['image/webp', webpLossless(200, 80)],
  ])(
    'stores a %s logo byte for byte, with a versioned URL and one audit row',
    async (type, bytes) => {
      const result = await service.setLogo(
        bytes,
        `${type}; charset=binary`,
        { version: '1' },
        admin,
      );
      expect(result).toEqual({
        primary: null,
        secondary: null,
        logoUrl: '/api/branding/logo?v=2',
        version: 2,
      });
      const logo = await service.getLogo();
      expect(logo?.type).toBe(type);
      expect(logo?.version).toBe(2);
      expect(Buffer.from(logo?.bytes ?? []).equals(bytes)).toBe(true);
      const rows = await auditRows();
      expect(rows).toEqual([
        {
          action: 'branding-logo-set',
          user_id: admin.id,
          user_name: admin.name,
          model_id: null,
          details: { fields: ['logo'] },
        },
      ]);
    },
  );

  it('stores the type the bytes say, when the declared one is another logo type', async () => {
    await service.setLogo(png(), 'image/jpeg', { version: 1 }, admin);
    expect((await service.getLogo())?.type).toBe('image/png');
  });

  it.each([
    ['an SVG sent as a PNG', svg, 'image/png', LogoTypeError],
    ['a PNG sent as SVG', png(), 'image/svg+xml', LogoTypeError],
    ['a PNG sent without a type', png(), undefined, LogoTypeError],
    ['HTML sent as a PNG', Buffer.from('<html><body>x</body></html>'), 'image/png', LogoTypeError],
    ['a GIF', Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'), 'image/png', LogoTypeError],
    ['an empty file', Buffer.alloc(0), 'image/png', LogoTypeError],
    ['a file over 300 KB', Buffer.alloc(maxLogoBytes + 1), 'image/png', LogoTooLargeError],
    ['a truncated PNG', png(4, 4).subarray(0, 40), 'image/png', RejectedError],
    ['a PNG of 1025 × 10 pixels', png(1025, 10), 'image/png', RejectedError],
    ['a JPEG of 10 × 1025 pixels', jpeg(10, 1025), 'image/jpeg', RejectedError],
    [
      'a PNG declaring 2^31 - 1 pixels',
      png(1, 1, { declared: [0x7fffffff, 1] }),
      'image/png',
      RejectedError,
    ],
  ])('refuses %s, and stores and audits nothing', async (_name, bytes, type, kind) => {
    const error = await service
      .setLogo(bytes, type, { version: 1 }, admin)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(kind);
    if (error instanceof RejectedError) expect(error.fields[0]?.field).toBe('logo');
    expect(await service.getLogo()).toBeUndefined();
    expect((await service.get()).version).toBe(1);
    expect(await auditRows()).toEqual([]);
  });

  it('accepts exactly 1024 × 1024 pixels', async () => {
    const result = await service.setLogo(png(1024, 1024), 'image/png', { version: 1 }, admin);
    expect(result.logoUrl).not.toBeNull();
  });

  it('removes the logo, and does nothing when there is none', async () => {
    await service.setLogo(png(), 'image/png', { version: 1 }, admin);
    const removed = await service.removeLogo({ version: 2 }, admin);
    expect(removed).toEqual({ primary: null, secondary: null, logoUrl: null, version: 3 });
    expect(await service.getLogo()).toBeUndefined();
    expect(await storedRow()).toMatchObject({ logo: null, logo_type: null });
    const again = await service.removeLogo({ version: 3 }, admin);
    expect(again.version).toBe(3);
    expect((await auditRows()).map((row) => [row.action, row.details])).toEqual([
      ['branding-logo-set', { fields: ['logo'] }],
      ['branding-logo-removed', { fields: ['logo'] }],
    ]);
  });

  it('needs the version for every logo change', async () => {
    for (const query of [{}, { version: 'x' }, { version: 0 }, { version: 1, extra: 1 }]) {
      await expect(service.setLogo(png(), 'image/png', query, admin)).rejects.toBeInstanceOf(
        RejectedError,
      );
      await expect(service.removeLogo(query, admin)).rejects.toBeInstanceOf(RejectedError);
      await expect(service.reset(query, admin)).rejects.toBeInstanceOf(RejectedError);
    }
    expect(await auditRows()).toEqual([]);
  });
});

describe('BrandingService: reset', () => {
  it('goes back to the neutral look in one change, naming what it cleared', async () => {
    await service.setColours({ primary: '#111111', secondary: '#222222', version: 1 }, admin);
    await service.setLogo(png(), 'image/png', { version: 2 }, admin);
    const result = await service.reset({ version: 3 }, admin);
    expect(result).toEqual({ primary: null, secondary: null, logoUrl: null, version: 4 });
    expect(await service.getLogo()).toBeUndefined();
    const rows = await auditRows();
    expect(rows.at(-1)).toMatchObject({
      action: 'branding-reset',
      details: { fields: ['primary', 'secondary', 'logo'] },
    });
    // Already neutral: nothing to store.
    expect((await service.reset({ version: 4 }, admin)).version).toBe(4);
    expect(await auditRows()).toHaveLength(3);
  });
});

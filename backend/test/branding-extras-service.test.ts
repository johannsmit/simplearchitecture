import {
  brandingConflictMessage,
  darkLogoTooLargeMessage,
  darkLogoTypeMessage,
  iconTooLargeMessage,
  iconTypeMessage,
  maxLogoBytes,
  productTitleCharactersMessage,
  productTitleTooLongMessage,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BrandingService,
  LogoTooLargeError,
  LogoTypeError,
} from '../src/branding/branding-service.js';
import { ConflictError, RejectedError } from '../src/editing/common.js';
import { jpeg, png, svg, webpLossless } from './images.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

/** The product title, the logo for the Dark theme and the app icon (Admin → Branding). */

const admin = { id: 'oid-made-up-admin', name: 'Made-up Admin' };
const neutral = {
  title: null,
  primary: null,
  secondary: null,
  logoUrl: null,
  darkLogoUrl: null,
  iconUrl: null,
  version: 1,
};

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

const ensureRow = 'insert into branding (id) values (1) on conflict (id) do nothing';
const auditRows = () =>
  db.query<{ action: string; details: unknown }>('select action, details from audit order by id');
const version = async () => (await service.get()).version;

describe('BrandingService: the product title', () => {
  it('stores a trimmed title, bumps the version and audits the field name only', async () => {
    const result = await service.setTitle({ title: '  Example Atlas  ', version: 1 }, admin);
    expect(result).toEqual({ ...neutral, title: 'Example Atlas', version: 2 });
    expect(await service.get()).toEqual(result);
    const rows = await auditRows();
    expect(rows).toEqual([{ action: 'branding-title-set', details: { fields: ['title'] } }]);
    expect(JSON.stringify(rows)).not.toContain('Atlas');
  });

  it('removes the title with null or an empty one, and stores nothing when unchanged', async () => {
    await service.setTitle({ title: 'Example Atlas', version: 1 }, admin);
    expect((await service.setTitle({ title: 'Example Atlas', version: 2 }, admin)).version).toBe(2);
    const removed = await service.setTitle({ title: '   ', version: 2 }, admin);
    expect(removed).toEqual({ ...neutral, version: 3 });
    expect((await service.setTitle({ title: null, version: 3 }, admin)).version).toBe(3);
    expect((await auditRows()).map((row) => row.action)).toEqual([
      'branding-title-set',
      'branding-title-removed',
    ]);
  });

  it('counts characters, not UTF-16 units: 40 emoji fit, 41 letters do not', async () => {
    const emoji = '\u{1F30D}'.repeat(40);
    expect((await service.setTitle({ title: emoji, version: 1 }, admin)).title).toBe(emoji);
    const error = await service
      .setTitle({ title: 'x'.repeat(41), version: 2 }, admin)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RejectedError);
    expect((error as RejectedError).fields).toEqual([
      { field: 'title', message: productTitleTooLongMessage },
    ]);
  });

  it.each([
    ['a line break', 'Example\nAtlas'],
    ['a carriage return', 'Example\rAtlas'],
    ['a tab', 'Example\tAtlas'],
    ['a NUL', 'Example\u0000Atlas'],
    ['a C1 control', 'Example\u0085Atlas'],
    ['a line separator', 'Example Atlas'],
    ['a paragraph separator', 'Example Atlas'],
  ])('refuses %s, and stores nothing', async (_name, title) => {
    const error = await service.setTitle({ title, version: 1 }, admin).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RejectedError);
    expect((error as RejectedError).fields).toEqual([
      { field: 'title', message: productTitleCharactersMessage },
    ]);
    expect(await version()).toBe(1);
    expect(await auditRows()).toEqual([]);
  });

  it('keeps markup as plain text', async () => {
    const title = '<b>Example</b> & "Atlas"';
    expect((await service.setTitle({ title, version: 1 }, admin)).title).toBe(title);
  });

  it.each([
    [{ title: 42, version: 1 }, ['title']],
    [{ title: ['Example'], version: 1 }, ['title']],
    [{ title: 'Example' }, ['version']],
    [{ title: 'Example', version: 1, primary: '#123456' }, ['primary']],
    [{ version: 1 }, ['title']],
    [null, ['']],
  ])('refuses %j, and stores nothing', async (input, fields) => {
    const error = await service.setTitle(input, admin).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RejectedError);
    expect((error as RejectedError).fields.map((issue) => issue.field)).toEqual(fields);
    expect(await auditRows()).toEqual([]);
  });

  it('refuses a stale version', async () => {
    await service.setTitle({ title: 'Example Atlas', version: 1 }, admin);
    const error = await service
      .setTitle({ title: 'Another', version: 1 }, admin)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).message).toBe(brandingConflictMessage);
    expect((await service.get()).title).toBe('Example Atlas');
  });

  it('keeps a wrong title out of the database even past the service', async () => {
    await db.query(ensureRow);
    for (const title of ['', ' padded', 'x'.repeat(41), 'line\nbreak', 'sep arator']) {
      await expect(
        db.query('update branding set title = $1 where id = 1', [title]),
        JSON.stringify(title),
      ).rejects.toThrow();
    }
    await db.query('update branding set title = $1 where id = 1', ['\u{1F30D}'.repeat(40)]);
  });
});

describe('BrandingService: the logo for the Dark theme', () => {
  it('stores it without a main logo, with its own URL and audit row, and removes it', async () => {
    const result = await service.setImage(
      'darkLogo',
      webpLossless(300, 80),
      'image/webp',
      { version: 1 },
      admin,
    );
    expect(result).toEqual({
      ...neutral,
      darkLogoUrl: '/api/branding/dark-logo?v=2',
      version: 2,
    });
    const stored = await service.getImage('darkLogo');
    expect(stored?.type).toBe('image/webp');
    expect(Buffer.from(stored?.bytes ?? []).equals(webpLossless(300, 80))).toBe(true);
    expect(await service.getLogo()).toBeUndefined();

    const removed = await service.removeImage('darkLogo', { version: 2 }, admin);
    expect(removed).toEqual({ ...neutral, version: 3 });
    expect((await service.removeImage('darkLogo', { version: 3 }, admin)).version).toBe(3);
    expect(await auditRows()).toEqual([
      { action: 'branding-dark-logo-set', details: { fields: ['darkLogo'] } },
      { action: 'branding-dark-logo-removed', details: { fields: ['darkLogo'] } },
    ]);
  });

  it('keeps the main logo when the Dark theme logo changes, and the other way round', async () => {
    await service.setLogo(png(40, 20), 'image/png', { version: 1 }, admin);
    await service.setImage('darkLogo', jpeg(40, 20), 'image/jpeg', { version: 2 }, admin);
    expect(await service.get()).toMatchObject({
      logoUrl: '/api/branding/logo?v=3',
      darkLogoUrl: '/api/branding/dark-logo?v=3',
    });
    await service.removeLogo({ version: 3 }, admin);
    expect(await service.get()).toMatchObject({
      logoUrl: null,
      darkLogoUrl: '/api/branding/dark-logo?v=4',
    });
  });

  it.each([
    ['an SVG', svg, 'image/png', LogoTypeError, darkLogoTypeMessage],
    ['a declared SVG', png(), 'image/svg+xml', LogoTypeError, darkLogoTypeMessage],
    [
      'a file over 300 KB',
      Buffer.alloc(maxLogoBytes + 1),
      'image/png',
      LogoTooLargeError,
      darkLogoTooLargeMessage,
    ],
  ])('refuses %s with its own message', async (_name, bytes, type, kind, message) => {
    const error = await service
      .setImage('darkLogo', bytes, type, { version: 1 }, admin)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(kind);
    expect((error as Error).message).toBe(message);
    expect(await auditRows()).toEqual([]);
  });

  it('refuses one over 1024 × 1024 pixels or damaged, on the darkLogo field', async () => {
    for (const bytes of [png(1025, 4), png(4, 4).subarray(0, 40)]) {
      const error = await service
        .setImage('darkLogo', bytes, 'image/png', { version: 1 }, admin)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RejectedError);
      expect((error as RejectedError).fields[0]?.field).toBe('darkLogo');
    }
    const wide = await service
      .setImage('darkLogo', png(1025, 4), 'image/png', { version: 1 }, admin)
      .catch((caught: unknown) => caught);
    expect((wide as RejectedError).fields[0]?.message).toBe(
      'The Dark theme logo must be at most 1024 × 1024 pixels. This one is 1025 × 4.',
    );
  });
});

describe('BrandingService: the app icon', () => {
  it('stores a 512 × 512 PNG with its own URL and audit row, and removes it', async () => {
    const icon = png(512, 512);
    const result = await service.setImage('icon', icon, 'image/png', { version: '1' }, admin);
    expect(result).toEqual({ ...neutral, iconUrl: '/api/branding/icon?v=2', version: 2 });
    const stored = await service.getImage('icon');
    expect(stored?.type).toBe('image/png');
    expect(Buffer.from(stored?.bytes ?? []).equals(icon)).toBe(true);
    await service.removeImage('icon', { version: 2 }, admin);
    expect(await service.getImage('icon')).toBeUndefined();
    expect(await auditRows()).toEqual([
      { action: 'branding-icon-set', details: { fields: ['icon'] } },
      { action: 'branding-icon-removed', details: { fields: ['icon'] } },
    ]);
  });

  it.each([
    ['a JPEG', jpeg(512, 512), 'image/jpeg'],
    ['a JPEG declared as PNG', jpeg(512, 512), 'image/png'],
    ['a WebP', webpLossless(512, 512), 'image/webp'],
    ['an SVG declared as PNG', svg, 'image/png'],
    ['a PNG declared as SVG', png(512, 512), 'image/svg+xml'],
  ])('refuses %s as not a PNG', async (_name, bytes, type) => {
    const error = await service
      .setImage('icon', bytes, type, { version: 1 }, admin)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LogoTypeError);
    expect((error as Error).message).toBe(iconTypeMessage);
    expect(await service.getImage('icon')).toBeUndefined();
  });

  it.each([
    [511, 512],
    [512, 511],
    [1024, 1024],
    [256, 256],
  ])('refuses %i × %i pixels, saying the size', async (width, height) => {
    const error = await service
      .setImage('icon', png(width, height), 'image/png', { version: 1 }, admin)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RejectedError);
    expect((error as RejectedError).fields).toEqual([
      {
        field: 'icon',
        message: `The app icon must be 512 × 512 pixels. This one is ${width} × ${height}.`,
      },
    ]);
    expect(await auditRows()).toEqual([]);
  });

  it('refuses one over 300 KB', async () => {
    const big = Buffer.concat([png(512, 512), Buffer.alloc(maxLogoBytes)]);
    const error = await service
      .setImage('icon', big, 'image/png', { version: 1 }, admin)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LogoTooLargeError);
    expect((error as Error).message).toBe(iconTooLargeMessage);
  });

  it('keeps a non-PNG icon out of the database even past the service', async () => {
    await db.query(ensureRow);
    await expect(
      db.query("update branding set icon = '\\x01'::bytea, icon_type = 'image/jpeg' where id = 1"),
    ).rejects.toThrow();
    await expect(
      db.query("update branding set icon = '\\x01'::bytea, icon_type = null where id = 1"),
    ).rejects.toThrow();
  });
});

describe('BrandingService: reset clears all six settings', () => {
  it('in one change, naming each field it cleared', async () => {
    await service.setTitle({ title: 'Example Atlas', version: 1 }, admin);
    await service.setColours({ primary: '#111111', secondary: '#222222', version: 2 }, admin);
    await service.setLogo(png(), 'image/png', { version: 3 }, admin);
    await service.setImage('darkLogo', png(), 'image/png', { version: 4 }, admin);
    await service.setImage('icon', png(512, 512), 'image/png', { version: 5 }, admin);
    const result = await service.reset({ version: 6 }, admin);
    expect(result).toEqual({ ...neutral, version: 7 });
    for (const image of ['logo', 'darkLogo', 'icon'] as const) {
      expect(await service.getImage(image)).toBeUndefined();
    }
    expect((await auditRows()).at(-1)).toEqual({
      action: 'branding-reset',
      details: { fields: ['title', 'primary', 'secondary', 'logo', 'darkLogo', 'icon'] },
    });
  });

  it('needs the current version for every new change', async () => {
    await service.setTitle({ title: 'Example Atlas', version: 1 }, admin);
    for (const image of ['darkLogo', 'icon'] as const) {
      await expect(
        service.setImage(image, png(512, 512), 'image/png', { version: 1 }, admin),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(service.removeImage(image, { version: 1 }, admin)).rejects.toBeInstanceOf(
        ConflictError,
      );
      await expect(service.removeImage(image, {}, admin)).rejects.toBeInstanceOf(RejectedError);
    }
    expect(await auditRows()).toHaveLength(1);
  });
});

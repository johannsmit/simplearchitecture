import {
  darkLogoTooLargeMessage,
  darkLogoTypeMessage,
  iconTooLargeMessage,
  iconTypeMessage,
  maxLogoBytes,
  productTitleCharactersMessage,
  productTitleTooLongMessage,
  type Branding,
  type ElementConflict,
  type ElementRejected,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import {
  buildTestApp,
  captureLogs,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';
import { jpeg, png, svg, textChunk } from './images.js';
import { createTestDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

/** The routes for the product title, the Dark theme logo, the app icon and the manifest. */

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000b2b2', name: 'Made-up Icon Admin' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

let db: TestDb;
let idp: OAuth2Server;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  db = await createTestDb();
  idp = await startMockIdp();
});

afterAll(async () => {
  await idp.stop();
  await db.close();
});

beforeEach(async () => {
  await resetTestDb(db);
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
});

const withDb = () =>
  idpOptions(idp, { database: DatabaseService.using(db, testConnection, silent) });

async function signedOut(): Promise<FastifyInstance> {
  app = await buildTestApp({}, withDb());
  return app;
}

async function signedInAs(
  roles: string[],
  logLevel: 'silent' | 'info' = 'silent',
): Promise<{ target: FastifyInstance; cookie: string }> {
  app = await buildTestApp({ LOG_LEVEL: logLevel }, withDb());
  withClaims(idp, { roles, ...user });
  const { sessionCookie } = await signIn(app);
  return { target: app, cookie: sessionCookie };
}

type Method = 'GET' | 'PUT' | 'DELETE';

interface Call {
  cookie?: string;
  origin?: string | null;
  json?: unknown;
  raw?: Buffer;
  contentType?: string;
}

function call(target: FastifyInstance, method: Method, url: string, opts: Call = {}) {
  const origin = opts.origin === undefined ? webOrigin : opts.origin;
  const payload = opts.raw ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json));
  const contentType =
    opts.contentType ??
    (opts.raw !== undefined
      ? 'image/png'
      : opts.json !== undefined
        ? 'application/json'
        : undefined);
  return target.inject({
    method,
    url,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(contentType === undefined ? {} : { 'content-type': contentType }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

const auditCount = async () =>
  (await db.query<{ count: number }>('select count(*)::int as count from audit'))[0]?.count;

const icon = png(512, 512);

const adminRoutes: [Method, string, Call][] = [
  ['PUT', '/api/admin/branding/title', { json: { title: 'Example Atlas', version: 1 } }],
  ['PUT', '/api/admin/branding/dark-logo?version=1', { raw: png(40, 20) }],
  ['DELETE', '/api/admin/branding/dark-logo?version=1', {}],
  ['PUT', '/api/admin/branding/icon?version=1', { raw: icon }],
  ['DELETE', '/api/admin/branding/icon?version=1', {}],
];

describe('branding extras: access', () => {
  it('gives 401 on every change when signed out, and stores nothing', async () => {
    const target = await signedOut();
    for (const [method, url, opts] of adminRoutes) {
      const res = await call(target, method, url, opts);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(await auditCount()).toBe(0);
  });

  it.each([['Viewer'], ['Modeller']])('gives %ss 403, and stores nothing', async (role) => {
    const { target, cookie } = await signedInAs([role]);
    for (const [method, url, opts] of adminRoutes) {
      const res = await call(target, method, url, { ...opts, cookie });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(await auditCount()).toBe(0);
  });

  it('refuses a change from another origin, or without one, even for an Admin', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    for (const origin of ['http://localhost:9999', null]) {
      for (const [method, url, opts] of adminRoutes) {
        const res = await call(target, method, url, { ...opts, cookie, origin });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    expect(await auditCount()).toBe(0);
  });

  it('answers 409 with the current version when it is stale', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    await call(target, 'PUT', '/api/admin/branding', {
      cookie,
      json: { primary: '#111111', secondary: null, version: 1 },
    });
    for (const [method, url, opts] of adminRoutes) {
      const res = await call(target, method, url, { ...opts, cookie });
      expect(res.statusCode, `${method} ${url}`).toBe(409);
      expect(res.json<ElementConflict>().currentVersion).toBe(2);
    }
    expect(await auditCount()).toBe(1);
  });

  it('serves the title, the Dark theme logo and the icon signed out', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    await call(target, 'PUT', '/api/admin/branding/title', {
      cookie,
      json: { title: 'Example Atlas', version: 1 },
    });
    await call(target, 'PUT', '/api/admin/branding/dark-logo?version=2', {
      cookie,
      raw: jpeg(40, 20),
      contentType: 'image/jpeg',
    });
    await call(target, 'PUT', '/api/admin/branding/icon?version=3', { cookie, raw: icon });

    const res = await target.inject({ method: 'GET', url: '/api/branding' });
    expect(res.json()).toEqual({
      title: 'Example Atlas',
      primary: null,
      secondary: null,
      logoUrl: null,
      darkLogoUrl: '/api/branding/dark-logo?v=4',
      iconUrl: '/api/branding/icon?v=4',
      version: 4,
    });

    const dark = await target.inject({ method: 'GET', url: '/api/branding/dark-logo?v=4' });
    expect(dark.statusCode).toBe(200);
    expect(dark.headers['content-type']).toBe('image/jpeg');
    expect(dark.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(dark.rawPayload.equals(jpeg(40, 20))).toBe(true);
    expect(dark.headers['set-cookie']).toBeUndefined();

    const got = await target.inject({ method: 'GET', url: '/api/branding/icon?v=4' });
    expect(got.statusCode).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.rawPayload.equals(icon)).toBe(true);
    const stale = await target.inject({ method: 'GET', url: '/api/branding/icon?v=3' });
    expect(stale.headers['cache-control']).toBe('no-cache');
  });

  it('answers 404 for a Dark theme logo or icon that is not set', async () => {
    const target = await signedOut();
    for (const url of ['/api/branding/dark-logo?v=1', '/api/branding/icon']) {
      const res = await target.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
    }
  });
});

describe('branding extras: changes', () => {
  it('sets and removes each one, with one audit row and log line each, never the title', async () => {
    const { target, cookie } = await signedInAs(['Admin'], 'info');
    const logs = captureLogs(target);
    const steps: [Method, string, Call][] = [
      ['PUT', '/api/admin/branding/title', { json: { title: 'Example Atlas', version: 1 } }],
      ['PUT', '/api/admin/branding/title', { json: { title: '', version: 2 } }],
      ['PUT', '/api/admin/branding/dark-logo?version=3', { raw: png(40, 20) }],
      ['DELETE', '/api/admin/branding/dark-logo?version=4', {}],
      ['PUT', '/api/admin/branding/icon?version=5', { raw: icon }],
      ['DELETE', '/api/admin/branding/icon?version=6', {}],
    ];
    for (const [method, url, opts] of steps) {
      const res = await call(target, method, url, { ...opts, cookie });
      expect(res.statusCode, `${method} ${url}`).toBe(200);
    }
    const final = await target.inject({ method: 'GET', url: '/api/branding' });
    expect(final.json<Branding>()).toMatchObject({
      title: null,
      darkLogoUrl: null,
      iconUrl: null,
      version: 7,
    });
    const actions = await db.query<{ action: string }>('select action from audit order by id');
    expect(actions.map((row) => row.action)).toEqual([
      'branding-title-set',
      'branding-title-removed',
      'branding-dark-logo-set',
      'branding-dark-logo-removed',
      'branding-icon-set',
      'branding-icon-removed',
    ]);
    const audits = logs.filter((line) => line.includes('"audit":"branding-'));
    expect(audits).toHaveLength(6);
    expect(audits.join('\n')).not.toMatch(/Example Atlas|Made-up Icon Admin/);
  });

  it('reset clears the title, both logos and the icon too', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    await call(target, 'PUT', '/api/admin/branding/title', {
      cookie,
      json: { title: 'Example Atlas', version: 1 },
    });
    await call(target, 'PUT', '/api/admin/branding/logo?version=2', { cookie, raw: png() });
    await call(target, 'PUT', '/api/admin/branding/dark-logo?version=3', { cookie, raw: png() });
    await call(target, 'PUT', '/api/admin/branding/icon?version=4', { cookie, raw: icon });
    const reset = await call(target, 'DELETE', '/api/admin/branding?version=5', { cookie });
    expect(reset.json()).toEqual({
      title: null,
      primary: null,
      secondary: null,
      logoUrl: null,
      darkLogoUrl: null,
      iconUrl: null,
      version: 6,
    });
    for (const url of ['/api/branding/logo', '/api/branding/dark-logo', '/api/branding/icon']) {
      expect((await target.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });

  it.each([
    ['x'.repeat(41), productTitleTooLongMessage],
    ['Example\nAtlas', productTitleCharactersMessage],
    ['Example Atlas', productTitleCharactersMessage],
  ])('answers 422 to the title %j, without echoing it', async (title, message) => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await call(target, 'PUT', '/api/admin/branding/title', {
      cookie,
      json: { title, version: 1 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<ElementRejected>().fields).toEqual([{ field: 'title', message }]);
    expect(res.body).not.toContain('Example');
    expect(await auditCount()).toBe(0);
  });

  it('answers 415 to a title that is not JSON, and 422 to extra fields', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const form = await call(target, 'PUT', '/api/admin/branding/title', {
      cookie,
      raw: Buffer.from('title=Example'),
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(form.statusCode).toBe(415);
    const extra = await call(target, 'PUT', '/api/admin/branding/title', {
      cookie,
      json: { title: 'Example', version: 1, html: true },
    });
    expect(extra.statusCode).toBe(422);
    expect(await auditCount()).toBe(0);
  });

  it('answers 415, 413 and 422 for the Dark theme logo with its own messages', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const url = '/api/admin/branding/dark-logo?version=1';
    const declared = await call(target, 'PUT', url, {
      cookie,
      raw: png(),
      contentType: 'image/svg+xml',
    });
    expect(declared.statusCode).toBe(415);
    expect(declared.json<{ message: string }>().message).toBe(darkLogoTypeMessage);
    const renamed = await call(target, 'PUT', url, { cookie, raw: svg });
    expect(renamed.statusCode).toBe(415);
    expect(renamed.json<{ message: string }>().message).toBe(darkLogoTypeMessage);
    const big = await call(target, 'PUT', url, {
      cookie,
      raw: Buffer.concat([png(), Buffer.alloc(maxLogoBytes)]),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json<{ message: string }>().message).toBe(darkLogoTooLargeMessage);
    const wide = await call(target, 'PUT', url, { cookie, raw: png(2000, 10) });
    expect(wide.statusCode).toBe(422);
    expect(wide.json<ElementRejected>().fields[0]?.field).toBe('darkLogo');
    expect(await auditCount()).toBe(0);
  });

  it('answers 415, 413 and 422 for the app icon with its own messages', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const url = '/api/admin/branding/icon?version=1';
    for (const [raw, contentType] of [
      [jpeg(512, 512), 'image/jpeg'],
      [png(512, 512), 'image/webp'],
      [jpeg(512, 512), 'image/png'],
      [svg, 'image/png'],
    ] as const) {
      const res = await call(target, 'PUT', url, { cookie, raw, contentType });
      expect(res.statusCode, contentType).toBe(415);
      expect(res.json<{ message: string }>().message).toBe(iconTypeMessage);
    }
    const big = await call(target, 'PUT', url, {
      cookie,
      raw: Buffer.concat([icon, Buffer.alloc(maxLogoBytes)]),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json<{ message: string }>().message).toBe(iconTooLargeMessage);
    const small = await call(target, 'PUT', url, { cookie, raw: png(192, 192) });
    expect(small.statusCode).toBe(422);
    expect(small.json<ElementRejected>().fields).toEqual([
      { field: 'icon', message: 'The app icon must be 512 × 512 pixels. This one is 192 × 192.' },
    ]);
    expect(await auditCount()).toBe(0);
  });

  it('serves a polyglot icon only as image/png, with nosniff and a sandbox', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const polyglot = png(512, 512, { extraChunks: [textChunk('<script>alert(1)</script>')] });
    const res = await call(target, 'PUT', '/api/admin/branding/icon?version=1', {
      cookie,
      raw: polyglot,
    });
    expect(res.statusCode).toBe(200);
    const got = await target.inject({ method: 'GET', url: '/api/branding/icon?v=2' });
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect(String(got.headers['content-security-policy'])).toContain('sandbox');
  });
});

describe('the web app manifest', () => {
  it('names the default product and lists the built-in icons when nothing is set', async () => {
    const target = await signedOut();
    const res = await target.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/manifest+json; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['set-cookie']).toBeUndefined();
    const manifest = res.json<Record<string, unknown>>();
    expect(manifest).toMatchObject({
      name: 'SimpleArchitecture',
      short_name: 'SimpleArch',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      lang: 'en',
    });
    expect(manifest).not.toHaveProperty('id');
    expect(manifest.icons).toEqual([
      { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
      { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });

  it('uses the product title and the app icon, keeping the built-in maskable icon', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const title = 'Example "Atlas" <b>';
    await call(target, 'PUT', '/api/admin/branding/title', { cookie, json: { title, version: 1 } });
    await call(target, 'PUT', '/api/admin/branding/icon?version=2', { cookie, raw: icon });
    const res = await target.inject({ method: 'GET', url: '/manifest.webmanifest' });
    const manifest = res.json<Record<string, unknown>>();
    expect(manifest.name).toBe(title);
    expect(manifest.short_name).toBe(title);
    expect(manifest.icons).toEqual([
      { src: '/api/branding/icon?v=3', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
    // Plain JSON text: the markup in the title is never raw HTML.
    expect(res.body).toContain(JSON.stringify(title));
  });
});

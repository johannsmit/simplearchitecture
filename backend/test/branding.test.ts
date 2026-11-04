import {
  brandingUnavailableMessage,
  logoTooLargeMessage,
  logoTypeMessage,
  maxLogoBytes,
  type Branding,
  type ElementConflict,
  type ElementRejected,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
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
import { jpeg, png, svg, textChunk, webpLossy } from './images.js';
import { createTestDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000b1b1', name: 'Made-up Brand Admin' };
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

async function signedOut(withDatabase = true): Promise<FastifyInstance> {
  app = await buildTestApp({}, withDatabase ? withDb() : idpOptions(idp));
  return app;
}

async function signedInAs(
  roles: string[],
  withDatabase = true,
  logLevel: 'silent' | 'info' = 'silent',
): Promise<{ target: FastifyInstance; cookie: string }> {
  app = await buildTestApp({ LOG_LEVEL: logLevel }, withDatabase ? withDb() : idpOptions(idp));
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

const adminRoutes: [Method, string, Call][] = [
  ['PUT', '/api/admin/branding', { json: { primary: '#123456', secondary: null, version: 1 } }],
  ['DELETE', '/api/admin/branding?version=1', {}],
  ['PUT', '/api/admin/branding/logo?version=1', { raw: png() }],
  ['DELETE', '/api/admin/branding/logo?version=1', {}],
];

describe('branding routes: access', () => {
  it('gives 401 on the Admin routes when signed out, and stores nothing', async () => {
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
    expect((await call(target, 'GET', '/api/branding')).json<Branding>().version).toBe(1);
  });

  it('refuses a change from another origin, or without one', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    for (const origin of ['http://localhost:9999', null]) {
      for (const [method, url, opts] of adminRoutes) {
        const res = await call(target, method, url, { ...opts, cookie, origin });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
      }
    }
    expect(await auditCount()).toBe(0);
  });

  it('serves the branding and the logo signed out, with nothing else in the body', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    await call(target, 'PUT', '/api/admin/branding', {
      cookie,
      json: { primary: '#1A6FB0', secondary: '#FFCC00', version: 1 },
    });
    await call(target, 'PUT', '/api/admin/branding/logo?version=2', { cookie, raw: png(40, 20) });

    const res = await target.inject({ method: 'GET', url: '/api/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.json()).toEqual({
      primary: '#1a6fb0',
      secondary: '#ffcc00',
      logoUrl: '/api/branding/logo?v=3',
      version: 3,
    });
    expect(res.body).not.toContain(user.name);
    expect(res.body).not.toContain(user.oid);
    expect(res.headers['set-cookie']).toBeUndefined();

    const logo = await target.inject({ method: 'GET', url: '/api/branding/logo?v=3' });
    expect(logo.statusCode).toBe(200);
    expect(logo.rawPayload.equals(png(40, 20))).toBe(true);
  });
});

describe('branding routes: changes', () => {
  it('sets the colours, the logo, removes the logo and resets, with one audit row each', async () => {
    const { target, cookie } = await signedInAs(['Admin'], true, 'info');
    const logs = captureLogs(target);

    const colours = await call(target, 'PUT', '/api/admin/branding', {
      cookie,
      json: { primary: '#ABCDEF', secondary: null, version: 1 },
    });
    expect(colours.statusCode).toBe(200);
    expect(colours.json()).toEqual({
      primary: '#abcdef',
      secondary: null,
      logoUrl: null,
      version: 2,
    });

    const logo = await call(target, 'PUT', '/api/admin/branding/logo?version=2', {
      cookie,
      raw: jpeg(64, 64),
      contentType: 'image/jpeg',
    });
    expect(logo.statusCode).toBe(200);
    expect(logo.json<Branding>()).toMatchObject({ logoUrl: '/api/branding/logo?v=3', version: 3 });

    const removed = await call(target, 'DELETE', '/api/admin/branding/logo?version=3', { cookie });
    expect(removed.json<Branding>()).toMatchObject({ logoUrl: null, version: 4 });

    const reset = await call(target, 'DELETE', '/api/admin/branding?version=4', { cookie });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toEqual({ primary: null, secondary: null, logoUrl: null, version: 5 });

    // Unchanged: no new version, no audit row, no log line.
    const same = await call(target, 'DELETE', '/api/admin/branding?version=5', { cookie });
    expect(same.json<Branding>().version).toBe(5);

    expect(await auditCount()).toBe(4);
    const audits = logs.filter((line) => line.includes('"audit":"branding-'));
    expect(audits).toHaveLength(4);
    // The log has who and what, never a colour or the user's name.
    expect(audits.join('\n')).not.toMatch(/abcdef|Made-up Brand Admin/i);
  });

  it('answers 422 with field messages for bad colours, and stores nothing', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await call(target, 'PUT', '/api/admin/branding', {
      cookie,
      json: { primary: 'blue', secondary: '#12345', version: 1 },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json<ElementRejected>();
    expect(body.fields.map((issue) => issue.field)).toEqual(['primary', 'secondary']);
    expect(body.fields[0]?.message).toMatch(/#1a6fb0/);
    // The value sent is never echoed.
    expect(res.body).not.toContain('blue');
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

  it('answers 415 before reading a body of another type, and for content that is not an image', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const url = '/api/admin/branding/logo?version=1';
    for (const contentType of ['image/svg+xml', 'image/gif', 'text/html', 'application/json']) {
      const res = await call(target, 'PUT', url, { cookie, raw: png(), contentType });
      expect(res.statusCode, contentType).toBe(415);
      expect(res.json<{ message: string }>().message).toBe(logoTypeMessage);
    }
    // An SVG renamed to .png and sent as image/png.
    const renamed = await call(target, 'PUT', url, { cookie, raw: svg, contentType: 'image/png' });
    expect(renamed.statusCode).toBe(415);
    const colours = await call(target, 'PUT', '/api/admin/branding', {
      cookie,
      raw: Buffer.from('primary=%23123456'),
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(colours.statusCode).toBe(415);
    expect(await auditCount()).toBe(0);
  });

  it('answers 422 for a truncated image and for one over 1024 × 1024 pixels', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const url = '/api/admin/branding/logo?version=1';
    const truncated = await call(target, 'PUT', url, { cookie, raw: png(8, 8).subarray(0, 50) });
    expect(truncated.statusCode).toBe(422);
    expect(truncated.json<ElementRejected>().fields[0]?.field).toBe('logo');
    const huge = await call(target, 'PUT', url, {
      cookie,
      raw: png(1, 1, { declared: [100_000, 100_000] }),
    });
    expect(huge.statusCode).toBe(422);
    expect(huge.json<ElementRejected>().fields[0]?.message).toMatch(/1024 × 1024/);
    const wide = await call(target, 'PUT', url, {
      cookie,
      raw: webpLossy(2000, 10),
      contentType: 'image/webp',
    });
    expect(wide.statusCode).toBe(422);
    expect(await auditCount()).toBe(0);
  });

  it('answers 413 over 300 KB, and 422 without a version', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const big = Buffer.concat([png(), Buffer.alloc(maxLogoBytes)]);
    const res = await call(target, 'PUT', '/api/admin/branding/logo?version=1', {
      cookie,
      raw: big,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json<{ message: string }>().message).toBe(logoTooLargeMessage);
    const noVersion = await call(target, 'PUT', '/api/admin/branding/logo', { cookie, raw: png() });
    expect(noVersion.statusCode).toBe(422);
    expect(noVersion.json<ElementRejected>().fields[0]?.field).toBe('version');
    const deleteNoVersion = await call(target, 'DELETE', '/api/admin/branding', { cookie });
    expect(deleteNoVersion.statusCode).toBe(422);
    expect(await auditCount()).toBe(0);
  });
});

describe('branding routes: serving the logo (hostile input)', () => {
  async function upload(bytes: Buffer, contentType = 'image/png'): Promise<FastifyInstance> {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await call(target, 'PUT', '/api/admin/branding/logo?version=1', {
      cookie,
      raw: bytes,
      contentType,
    });
    expect(res.statusCode).toBe(200);
    return target;
  }

  it.each([
    [
      'HTML after the PNG end',
      png(2, 2, { after: Buffer.from('<html><script>alert(1)</script>') }),
    ],
    [
      'HTML in a PNG text chunk',
      png(2, 2, { extraChunks: [textChunk('<script>alert(1)</script>')] }),
    ],
  ])(
    'serves a polyglot (%s) only as image/png, with nosniff and a sandbox',
    async (_name, bytes) => {
      // Declared as JPEG: the stored type is what the bytes say.
      const target = await upload(bytes, 'image/jpeg');
      const res = await target.inject({ method: 'GET', url: '/api/branding/logo?v=2' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-disposition']).toBe('inline');
      const csp = String(res.headers['content-security-policy']);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain('sandbox');
      expect(csp).not.toContain('script-src');
      expect(res.rawPayload.equals(bytes)).toBe(true);
    },
  );

  it('caches the current version for long, and any other URL not at all', async () => {
    const target = await upload(png());
    const current = await target.inject({ method: 'GET', url: '/api/branding/logo?v=2' });
    expect(current.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    for (const url of ['/api/branding/logo', '/api/branding/logo?v=1', '/api/branding/logo?v=x']) {
      const res = await target.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('no-cache');
    }
  });

  it('answers 413 to a chunked body over 300 KB (no Content-Length), and stores nothing', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const big = Buffer.concat([png(), Buffer.alloc(maxLogoBytes)]);
    const res = await target.inject({
      method: 'PUT',
      url: '/api/admin/branding/logo?version=1',
      headers: { origin: webOrigin, cookie, 'content-type': 'image/png' },
      payload: Readable.from([big.subarray(0, 1000), big.subarray(1000)]),
    });
    expect(res.statusCode).toBe(413);
    expect(await auditCount()).toBe(0);
    expect((await target.inject({ method: 'GET', url: '/api/branding' })).json()).toMatchObject({
      logoUrl: null,
      version: 1,
    });
  });

  it('answers 422, not 500, to a version sent twice or not a number, and stores nothing', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    for (const query of ['version=1&version=1', 'version=abc', 'version=-1', 'version=1e400']) {
      for (const [method, path, opts] of [
        ['PUT', '/api/admin/branding/logo', { raw: png() }],
        ['DELETE', '/api/admin/branding/logo', {}],
        ['DELETE', '/api/admin/branding', {}],
      ] as [Method, string, Call][]) {
        const res = await call(target, method, `${path}?${query}`, { ...opts, cookie });
        expect(res.statusCode, `${method} ${path}?${query}`).toBe(422);
      }
    }
    // Colours: extra fields, a colour that isn't a string, and CSS text are refused.
    for (const json of [
      { primary: '#123456', secondary: null, version: 1, logo: 'x' },
      { primary: 0x123456, secondary: null, version: 1 },
      { primary: '#123456;color:red', secondary: null, version: 1 },
      { primary: '#123456', version: 1 },
    ]) {
      const res = await call(target, 'PUT', '/api/admin/branding', { cookie, json });
      expect(res.statusCode, JSON.stringify(json)).toBe(422);
    }
    expect(await auditCount()).toBe(0);
  });

  it('serves the logo with the same safe headers to a HEAD, and never sets a cookie', async () => {
    const target = await upload(png());
    const head = await target.inject({ method: 'HEAD', url: '/api/branding/logo?v=2' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toBe('image/png');
    expect(head.headers['x-content-type-options']).toBe('nosniff');
    expect(String(head.headers['content-security-policy'])).toContain('sandbox');
    expect(head.headers['set-cookie']).toBeUndefined();
  });

  it('answers 404 when there is no logo, and to a HEAD the same way', async () => {
    const target = await signedOut();
    const res = await target.inject({ method: 'GET', url: '/api/branding/logo?v=1' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    const head = await target.inject({ method: 'HEAD', url: '/api/branding/logo' });
    expect(head.statusCode).toBe(404);
  });
});

describe('branding routes without a database', () => {
  it('serves the neutral look, and says branding needs a database', async () => {
    const { target, cookie } = await signedInAs(['Admin'], false);
    const res = await target.inject({ method: 'GET', url: '/api/branding' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ primary: null, secondary: null, logoUrl: null, version: 0 });
    expect((await target.inject({ method: 'GET', url: '/api/branding/logo' })).statusCode).toBe(
      404,
    );
    for (const [method, url, opts] of adminRoutes) {
      const change = await call(target, method, url, { ...opts, cookie });
      expect(change.statusCode, `${method} ${url}`).toBe(501);
      expect(change.json<{ message: string }>().message).toBe(brandingUnavailableMessage);
    }
  });
});

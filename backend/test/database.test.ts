import type { DatabaseStatus, DatabaseTestResult } from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresSessionStore } from '../src/auth/postgres-sessions.js';
import type { SessionUser } from '../src/auth/sessions.js';
import { ConfigError, loadConfig, loadDatabaseConfig } from '../src/config.js';
import { parseDatabaseUrl } from '../src/db/connection.js';
import { classifyDatabaseError, DatabaseError } from '../src/db/db.js';
import { loadMigrations } from '../src/db/migrate.js';
import {
  connectedMessage,
  DatabaseService,
  failureMessages,
  notConfiguredMessage,
} from '../src/db/service.js';
import { tooManyTestsMessage } from '../src/routes/database.js';
import {
  buildTestApp,
  captureLogs,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';
import { createTestDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

const password = 'made-up-db-password';
const madeUpUrl = `postgres://made_up_user:${password}@db.example.test:5432/made_up_db`;
const user = { oid: '9f0c4f8e-0000-4000-8000-00000000dbdb', name: 'Made-up Database Admin' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

let db: TestDb;
let idp: OAuth2Server;

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
  db.failPing = undefined;
});

describe('DATABASE_URL', () => {
  it('reads the parts, with TLS on for any host but this machine', () => {
    expect(parseDatabaseUrl(madeUpUrl)).toEqual({
      ok: true,
      connection: {
        host: 'db.example.test',
        port: 5432,
        database: 'made_up_db',
        user: 'made_up_user',
        password,
        tls: true,
      },
    });
    const local = parseDatabaseUrl('postgresql://me:p%40ss@localhost/dev');
    expect(local).toMatchObject({
      ok: true,
      connection: { tls: false, password: 'p@ss', port: 5432 },
    });
    expect(parseDatabaseUrl('postgres://me@127.0.0.1:5433/dev?sslmode=verify-full')).toMatchObject({
      ok: true,
      connection: { tls: true, port: 5433 },
    });
    // `require` (as cloud portals often show it) still gets a verified certificate.
    expect(parseDatabaseUrl(`${madeUpUrl}?sslmode=require`)).toMatchObject({
      ok: true,
      connection: { tls: true },
    });
  });

  it.each([
    ['not a URL', 'made up', 'must be a URL'],
    ['another scheme', `mysql://u:${password}@db.example.test/app`, 'must be a URL'],
    ['no user', 'postgres://db.example.test/app', 'user is missing'],
    ['no database', `postgres://u:${password}@db.example.test`, 'one database name'],
    ['sslmode=disable to another host', `${madeUpUrl}?sslmode=disable`, 'verified certificate'],
    ['sslmode=no-verify', `${madeUpUrl}?sslmode=no-verify`, 'verified certificate'],
    ['sslmode=prefer', `${madeUpUrl}?sslmode=prefer`, 'verified certificate'],
    ['an unknown sslmode', `${madeUpUrl}?sslmode=maybe`, 'unknown sslmode'],
    ['other parameters', `${madeUpUrl}?sslrootcert=/tmp/x`, 'one parameter only'],
    ['a bad percent-encoding', 'postgres://u:%zz@db.example.test/app', 'percent-encoded'],
  ])('refuses %s, never echoing the URL', (_name, value, message) => {
    const parsed = parseDatabaseUrl(value);
    expect(parsed.ok).toBe(false);
    const text = parsed.ok ? '' : parsed.message;
    expect(text).toContain(message);
    expect(text).not.toContain(password);
    expect(text).not.toContain('db.example.test');
  });

  it('is validated with the other settings, and required outside tests', () => {
    const env = {
      NODE_ENV: 'test',
      OIDC_ISSUER: 'https://idp.example.test/tenant-a',
      OIDC_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
      OIDC_CLIENT_SECRET: 'database-test-client-secret',
      SESSION_SECRET: 'database-test-session-secret-0123456789',
      WEB_ORIGIN: 'https://app.example.com',
      AUTH_REDIRECT_URI: 'https://app.example.com/auth/callback',
    };
    const production = {
      ...env,
      NODE_ENV: 'production',
      APP_DOMAIN: 'app.example.com',
      OIDC_ROLES_CLAIM: 'roles',
      OIDC_ROLE_ADMIN: 'Admin',
      OIDC_ROLE_MODELLER: 'Modeller',
      OIDC_ROLE_VIEWER: 'Viewer',
    };
    expect(loadConfig(env).DATABASE_URL).toBeUndefined();
    expect(() => loadConfig(production)).toThrow(/is required[\s\S]*DATABASE_URL/);
    const development = { ...production, NODE_ENV: 'development', APP_DOMAIN: '' };
    expect(() => loadConfig(development)).toThrow(/is required[\s\S]*DATABASE_URL/);
    expect(loadConfig({ ...production, DATABASE_URL: madeUpUrl }).DATABASE_URL).toBe(madeUpUrl);
    let error: unknown;
    try {
      loadConfig({ ...env, DATABASE_URL: `${madeUpUrl}?sslmode=disable` });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toMatch(/DATABASE_URL/);
    expect((error as Error).message).not.toContain(password);
    // The db:* commands need no sign-in settings.
    expect(loadDatabaseConfig({ DATABASE_URL: madeUpUrl })).toEqual({
      DATABASE_URL: madeUpUrl,
      DATABASE_WAIT_SECONDS: 60,
    });
    expect(() => loadDatabaseConfig({})).toThrow(/is required[\s\S]*DATABASE_URL/);
  });
});

describe('database errors', () => {
  const failure = (code: string | undefined, message = 'made-up') =>
    classifyDatabaseError(Object.assign(new Error(message), code === undefined ? {} : { code }));

  it('are sorted into a few kinds, from codes rather than text', () => {
    expect(failure('28P01')).toBe('auth');
    expect(failure('3D000')).toBe('missing-database');
    expect(failure('ECONNREFUSED')).toBe('unreachable');
    expect(failure('ENOTFOUND')).toBe('unreachable');
    expect(failure('ETIMEDOUT')).toBe('timeout');
    expect(failure('57014')).toBe('timeout');
    expect(failure('DEPTH_ZERO_SELF_SIGNED_CERT')).toBe('tls');
    expect(failure('ERR_TLS_CERT_ALTNAME_INVALID')).toBe('tls');
    expect(failure(undefined, 'The server does not support SSL connections')).toBe('tls');
    expect(failure(undefined, 'timeout expired')).toBe('timeout');
    expect(failure('42P01')).toBe('other');
  });

  it('never keep the driver message', () => {
    const raw = Object.assign(new Error(`password ${password} for "made_up_user"`), {
      code: '28P01',
    });
    const error = new DatabaseError(classifyDatabaseError(raw), '28P01');
    expect(error.message).not.toContain(password);
    expect(error.message).not.toContain('made_up_user');
  });
});

describe('PostgresSessionStore', () => {
  const sessionUser: SessionUser = {
    id: 'oid-session',
    name: 'Made-up Person',
    email: null,
    roles: ['Viewer'],
  };
  let time = 0;
  const timeouts = { idleMs: 30 * 60_000, absoluteMs: 8 * 60 * 60_000 };
  const open = () => new PostgresSessionStore(db, { timeouts, now: () => time, log: silent });

  beforeEach(() => {
    time = Date.UTC(2026, 9, 28, 9);
  });

  it('keeps a session across a restart, storing only a hash of its id', async () => {
    const session = await open().create(sessionUser);
    const rows = await db.query<{ id_hash: string }>('select id_hash from sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(session.id);

    time += 60_000;
    const restarted = open();
    expect(await restarted.touch(session.id)).toEqual({
      id: session.id,
      user: sessionUser,
      createdAt: session.createdAt,
      lastSeenAt: time,
    });
    expect(await restarted.touch('made-up-unknown-id')).toBeUndefined();
  });

  it('ends a session after 30 idle minutes', async () => {
    const store = open();
    const session = await store.create(sessionUser);
    time += timeouts.idleMs - 1;
    expect(await store.touch(session.id)).toBeDefined();
    time += timeouts.idleMs;
    expect(await store.touch(session.id)).toBeUndefined();
    const [left] = await db.query<{ count: number }>('select count(*)::int as count from sessions');
    expect(left?.count).toBe(0);
  });

  it('ends a session 8 hours after sign-in, however active', async () => {
    const store = open();
    const session = await store.create(sessionUser);
    for (let i = 0; i < 16; i++) {
      time += 29 * 60_000;
      await store.touch(session.id);
    }
    time = session.createdAt + timeouts.absoluteMs;
    expect(await store.touch(session.id)).toBeUndefined();
  });

  it('destroys a session once, and sweeps expired ones', async () => {
    const store = open();
    const ended = await store.create(sessionUser);
    expect((await store.destroy(ended.id))?.user).toEqual(sessionUser);
    expect(await store.destroy(ended.id)).toBeUndefined();

    await store.create(sessionUser);
    const fresh = await store.create(sessionUser);
    time += timeouts.idleMs;
    await store.touch(fresh.id).catch(() => undefined);
    const live = await store.create(sessionUser);
    expect(await store.sweep()).toBeGreaterThanOrEqual(1);
    expect(await store.touch(live.id)).toBeDefined();
    const [left] = await db.query<{ count: number }>('select count(*)::int as count from sessions');
    expect(left?.count).toBe(1);
  });

  it('refuses a session whose stored user is unreadable', async () => {
    const store = open();
    const session = await store.create(sessionUser);
    await db.query(`update sessions set user_data = '{"name": 5}'::jsonb`);
    expect(await store.touch(session.id)).toBeUndefined();
  });
});

describe('the API with PostgreSQL', () => {
  let app: FastifyInstance | undefined;
  let second: FastifyInstance | undefined;

  afterEach(async () => {
    idp.service.removeAllListeners('beforeTokenSigning');
    await app?.close();
    await second?.close();
    app = undefined;
    second = undefined;
  });

  const service = () => DatabaseService.using(db, testConnection, silent);
  const start = (database = service()) =>
    buildTestApp({ DATABASE_URL: madeUpUrl }, idpOptions(idp, { database }));

  async function signedInAs(roles: string[], target: FastifyInstance): Promise<string> {
    withClaims(idp, { roles, ...user });
    return (await signIn(target)).sessionCookie;
  }

  it('keeps people signed in across a restart, and stores models in PostgreSQL', async () => {
    app = await start();
    const cookie = await signedInAs(['Admin'], app);
    const saved = await app.inject({
      method: 'POST',
      url: '/api/models',
      headers: { cookie, origin: webOrigin, 'content-type': 'application/json' },
      payload: JSON.stringify({ graph: { label: 'Made-up stored model' } }),
    });
    expect(saved.statusCode).toBe(201);
    await app.close();
    app = undefined;

    second = await start();
    const me = await second.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    const models = await second.inject({ method: 'GET', url: '/api/models', headers: { cookie } });
    expect(models.json<{ models: { name: string }[] }>().models.map((m) => m.name)).toEqual([
      'Made-up stored model',
    ]);
  });

  describe('Admin → Database', () => {
    it('shows the status: the parts of the connection, never the password or URL', async () => {
      app = await start();
      const logs = captureLogs(app);
      const cookie = await signedInAs(['Admin'], app);
      const res = await app.inject({
        method: 'GET',
        url: '/api/admin/database',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const status = res.json<DatabaseStatus>();
      expect(status).toEqual({
        configured: true,
        connected: true,
        host: 'db.example.test',
        port: 5432,
        database: 'made_up_db',
        user: 'made_up_user',
        tls: true,
        tlsVerified: true,
        serverVersion: expect.stringMatching(/^\d+\.\d+/) as string,
        migrations: { applied: loadMigrations().length, total: loadMigrations().length },
      });
      expect(res.body).not.toContain(password);
      expect(res.body).not.toContain('postgres://');
      expect(logs.join('\n')).not.toContain(password);
    });

    it('says when there is no database: file storage', async () => {
      app = await buildTestApp({}, idpOptions(idp));
      const cookie = await signedInAs(['Admin'], app);
      const status = await app.inject({
        method: 'GET',
        url: '/api/admin/database',
        headers: { cookie },
      });
      expect(status.json<DatabaseStatus>()).toMatchObject({
        configured: false,
        connected: false,
        host: null,
        migrations: { applied: null, total: loadMigrations().length },
      });
      const test = await app.inject({
        method: 'POST',
        url: '/api/admin/database/test',
        headers: { cookie, origin: webOrigin },
      });
      expect(test.json<DatabaseTestResult>()).toEqual({ ok: false, message: notConfiguredMessage });
    });

    it('is for Admins only', async () => {
      app = await start();
      const signedOut = await app.inject({ method: 'GET', url: '/api/admin/database' });
      expect(signedOut.statusCode).toBe(401);
      for (const roles of [['Viewer'], ['Modeller'], []]) {
        const cookie = await signedInAs(roles, app);
        idp.service.removeAllListeners('beforeTokenSigning');
        const get = await app.inject({
          method: 'GET',
          url: '/api/admin/database',
          headers: { cookie },
        });
        const post = await app.inject({
          method: 'POST',
          url: '/api/admin/database/test',
          headers: { cookie, origin: webOrigin },
        });
        expect([get.statusCode, post.statusCode]).toEqual([403, 403]);
      }
    });

    it('tests the connection, with the CSRF check and at most 5 tests a minute', async () => {
      app = await start();
      const cookie = await signedInAs(['Admin'], app);
      const noOrigin = await app.inject({
        method: 'POST',
        url: '/api/admin/database/test',
        headers: { cookie },
      });
      expect(noOrigin.statusCode).toBe(403);
      for (let i = 0; i < 5; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/admin/database/test',
          headers: { cookie, origin: webOrigin },
        });
        expect(res.json<DatabaseTestResult>()).toEqual({ ok: true, message: connectedMessage });
      }
      const limited = await app.inject({
        method: 'POST',
        url: '/api/admin/database/test',
        headers: { cookie, origin: webOrigin },
      });
      expect(limited.statusCode).toBe(429);
      expect(limited.json<{ message: string }>().message).toBe(tooManyTestsMessage);
    });

    it.each([
      ['28P01', 'auth'],
      ['3D000', 'missing-database'],
      ['ECONNREFUSED', 'unreachable'],
      ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
      ['ETIMEDOUT', 'timeout'],
      ['XX000', 'other'],
    ] as const)(
      'reports a failure (%s) with a fixed text, never the driver message',
      async (code, kind) => {
        app = await start();
        const logs = captureLogs(app);
        const cookie = await signedInAs(['Admin'], app);
        db.failPing = Object.assign(
          new Error(`failed for user "made_up_user" at db.example.test with ${password}`),
          { code },
        );
        const res = await app.inject({
          method: 'POST',
          url: '/api/admin/database/test',
          headers: { cookie, origin: webOrigin },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json<DatabaseTestResult>()).toEqual({
          ok: false,
          message: failureMessages[kind],
        });
        expect(res.body).not.toContain(password);
        expect(res.body).not.toContain('failed for user');
        expect(logs.join('\n')).not.toContain(password);
        expect(logs.join('\n')).not.toContain('failed for user');
      },
    );

    it('shows "not connected" when the database stops answering', async () => {
      const broken = DatabaseService.using(
        {
          ...db,
          query: () => Promise.reject(new DatabaseError('unreachable', 'ECONNREFUSED')),
        },
        testConnection,
        silent,
      );
      const status = await broken.status();
      expect(status).toMatchObject({ configured: true, connected: false, serverVersion: null });
      expect(status.migrations.applied).toBeNull();
    });
  });
});

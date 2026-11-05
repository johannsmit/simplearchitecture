import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SaveModelResult } from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { loadWebApp } from '../src/web-app.js';
import {
  buildTestApp,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';
import { createTestDb, testConnection, type TestDb } from './pglite.js';

/** 'oauth' and 'mcp': the AI agents' endpoints, which never take the session as a sign-in. */
type Level = 'public' | 'authenticated' | 'viewing' | 'modelling' | 'admin' | 'oauth' | 'mcp';

/** Every route and who may call it. A new route fails the first test until it is listed here. */
const expectedAccess: Record<string, Level> = {
  'GET /auth/login': 'public',
  'GET /auth/callback': 'public',
  'POST /auth/logout': 'public',
  'GET /api/health': 'public',
  'GET /api/branding': 'public',
  'GET /api/branding/logo': 'public',
  'GET /api/me': 'authenticated',
  'GET /api/viewing/ping': 'viewing',
  'GET /api/models': 'viewing',
  'GET /api/models/:id': 'viewing',
  'GET /api/modelling/ping': 'modelling',
  'POST /api/import/jgf': 'modelling',
  'POST /api/import/oef': 'modelling',
  'GET /api/export/jgf': 'modelling',
  'GET /api/models/:id/elements/:elementId': 'modelling',
  'POST /api/models/:id/elements': 'modelling',
  'PATCH /api/models/:id/elements/:elementId': 'modelling',
  'DELETE /api/models/:id/elements/:elementId': 'modelling',
  'GET /api/models/:id/relationships/:relationshipId': 'modelling',
  'POST /api/models/:id/relationships': 'modelling',
  'PATCH /api/models/:id/relationships/:relationshipId': 'modelling',
  'DELETE /api/models/:id/relationships/:relationshipId': 'modelling',
  'GET /api/models/:id/views': 'viewing',
  'GET /api/models/:id/views/:viewId': 'viewing',
  'POST /api/models/:id/views': 'modelling',
  'PATCH /api/models/:id/views/:viewId': 'modelling',
  'PUT /api/models/:id/views/:viewId/contents': 'modelling',
  'DELETE /api/models/:id/views/:viewId': 'modelling',
  'GET /api/admin/ping': 'admin',
  'GET /api/admin/models/damaged': 'admin',
  'POST /api/models': 'admin',
  'POST /api/models/new': 'admin',
  'POST /api/models/import/oef': 'admin',
  'DELETE /api/models/:id': 'admin',
  'GET /api/admin/database': 'admin',
  'POST /api/admin/database/test': 'admin',
  'PUT /api/admin/branding': 'admin',
  'DELETE /api/admin/branding': 'admin',
  'PUT /api/admin/branding/logo': 'admin',
  'DELETE /api/admin/branding/logo': 'admin',
};

/** The AI agents' OAuth server and MCP endpoint: only with PostgreSQL, as in the image. */
const agentAccess: Record<string, Level> = {
  'GET /.well-known/oauth-authorization-server': 'public',
  'GET /.well-known/oauth-protected-resource/mcp': 'public',
  'GET /.well-known/oauth-protected-resource': 'public',
  'POST /oauth/register': 'oauth',
  'GET /oauth/authorize': 'oauth',
  'POST /oauth/token': 'oauth',
  'POST /oauth/revoke': 'oauth',
  'POST /mcp': 'mcp',
  'GET /mcp': 'mcp',
  'DELETE /mcp': 'mcp',
  'GET /api/agents/requests/:id': 'authenticated',
  'POST /api/agents/requests/:id': 'authenticated',
  'GET /api/agents': 'authenticated',
  'DELETE /api/agents/:id': 'authenticated',
  'GET /api/admin/agents': 'admin',
  'DELETE /api/admin/agents/:id': 'admin',
  'DELETE /api/admin/agents/users/:userId': 'admin',
  'DELETE /api/admin/agents': 'admin',
};

/** Who gets past each level. Roles are cumulative: Admin includes Modeller includes Viewer. */
const allowedFor: Record<string, Level[]> = {
  'no role': ['public', 'authenticated'],
  // A value that matches none of the configured roles counts as no role.
  Superuser: ['public', 'authenticated'],
  admin: ['public', 'authenticated'],
  Viewer: ['public', 'authenticated', 'viewing'],
  Modeller: ['public', 'authenticated', 'viewing', 'modelling'],
  Admin: ['public', 'authenticated', 'viewing', 'modelling', 'admin'],
};

const madeUpModel = {
  graph: {
    label: 'Made-up model',
    nodes: { a: { label: 'Made-up element', metadata: { type: 'Application' } } },
    edges: [],
  },
};

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The routes a browser calls with its session, which the CSRF check covers. */
function browserStateChanging(access: Record<string, Level>): string[] {
  return Object.entries(access)
    .filter(([route, level]) => !route.startsWith('GET ') && level !== 'oauth' && level !== 'mcp')
    .map(([route]) => route);
}

// With a database the sessions and models live in PostgreSQL, as in the image.
describe.each([
  ['file storage', false],
  ['PostgreSQL', true],
])('access to every route, with %s', (_storage, withDatabase) => {
  let idp: OAuth2Server;
  let app: FastifyInstance;
  let db: TestDb | undefined;
  const routes: string[] = [];
  const cookies = new Map<string, string>();
  const access = withDatabase ? { ...expectedAccess, ...agentAccess } : expectedAccess;

  const sessionFor = async (who: string): Promise<string> => {
    idp.service.removeAllListeners('beforeTokenSigning');
    withClaims(idp, {
      roles: who === 'no role' ? [] : [who],
      oid: `made-up-${who}`,
      name: `Made-up ${who}`,
    });
    const { sessionCookie } = await signIn(app);
    expect(sessionCookie).not.toBe('');
    return sessionCookie;
  };

  const call = (key: string, cookie?: string) => {
    const [method = 'GET', pattern = ''] = key.split(' ');
    return app.inject({
      method: method as 'GET',
      url: pattern.replaceAll(/:[A-Za-z]+/g, '11111111-1111-4111-8111-111111111111'),
      headers: { origin: webOrigin, ...(cookie === undefined ? {} : { cookie }) },
    });
  };

  beforeAll(async () => {
    idp = await startMockIdp();
    db = withDatabase ? await createTestDb() : undefined;
    app = await buildTestApp(
      {},
      idpOptions(idp, {
        ...(db === undefined
          ? {}
          : { database: DatabaseService.using(db, testConnection, silent) }),
        onRoute: (route) => {
          routes.push(`${String(route.method)} ${route.url}`);
        },
      }),
    );
    for (const who of Object.keys(allowedFor)) cookies.set(who, await sessionFor(who));
  });

  afterAll(async () => {
    await app.close();
    await db?.close();
    await idp.stop();
  });

  it('lists every route the app registers, so none goes unchecked', () => {
    const registered = routes.filter((route) => !route.startsWith('HEAD ')).sort();
    expect(registered).toEqual(Object.keys(access).sort());
  });

  it('refuses a visitor with 401 on everything that is not public', async () => {
    for (const [route, level] of Object.entries(access)) {
      if (level === 'public' || level === 'oauth') continue;
      const res = await call(route);
      expect(res.statusCode, route).toBe(401);
    }
  });

  it('answers a visitor on every public route', async () => {
    for (const [route, level] of Object.entries(access)) {
      if (level !== 'public') continue;
      const res = await call(route);
      expect([401, 403], `${route} gave ${res.statusCode}`).not.toContain(res.statusCode);
    }
  });

  it('treats a session cookie it never issued as signed out', async () => {
    const forged = (cookies.get('Admin') ?? '').replace(/=.*/, '=made-up-session-id');
    expect(forged).toContain('=made-up-session-id');
    for (const [route, level] of Object.entries(access)) {
      if (level === 'public' || level === 'oauth') continue;
      const res = await call(route, forged);
      expect(res.statusCode, route).toBe(401);
    }
  });

  it('refuses every state-changing route from another origin or none, even for an Admin', async () => {
    const cookie = cookies.get('Admin') ?? '';
    for (const route of browserStateChanging(access)) {
      const [method = 'POST', pattern = ''] = route.split(' ');
      const url = pattern.replaceAll(/:[A-Za-z]+/g, '11111111-1111-4111-8111-111111111111');
      for (const origin of ['https://elsewhere.example.test', undefined]) {
        const res = await app.inject({
          method: method as 'POST',
          url,
          headers: { cookie, ...(origin === undefined ? {} : { origin }) },
        });
        expect(res.statusCode, `${route} from ${String(origin)}`).toBe(403);
      }
    }
  });

  it("refuses the agents' endpoints from another origin, even for an Admin, but not without one", async () => {
    const cookie = cookies.get('Admin') ?? '';
    for (const [route, level] of Object.entries(access)) {
      if (level !== 'oauth' && level !== 'mcp') continue;
      const [method = 'POST', url = ''] = route.split(' ');
      const foreign = await app.inject({
        method: method as 'POST',
        url,
        headers: { cookie, origin: 'https://elsewhere.example.test' },
      });
      expect(foreign.statusCode, route).toBe(403);
      const none = await app.inject({ method: method as 'POST', url, headers: { cookie } });
      expect(none.statusCode, `${route} without an origin`).not.toBe(403);
    }
  });

  it('never lets a session cookie through to the MCP endpoint', async () => {
    for (const who of Object.keys(allowedFor)) {
      for (const [route, level] of Object.entries(access)) {
        if (level !== 'mcp') continue;
        const res = await call(route, cookies.get(who));
        expect(res.statusCode, `${who}: ${route}`).toBe(401);
      }
    }
  });

  it.each(Object.keys(allowedFor))('gives %s exactly the access of its role', async (who) => {
    const cookie = cookies.get(who);
    const allowed = allowedFor[who] ?? [];
    for (const [route, level] of Object.entries(access)) {
      if (level === 'oauth' || level === 'mcp') continue;
      // The sign-in routes answer the same to everyone, and sign-out would end the session.
      if (route.includes('/auth/')) continue;
      const res = await call(route, cookie);
      if (allowed.includes(level)) {
        expect([401, 403], `${who}: ${route} gave ${res.statusCode}`).not.toContain(res.statusCode);
      } else {
        expect(res.statusCode, `${who}: ${route}`).toBe(403);
      }
    }
  });

  it('applies the same rule to the HEAD form of a route', async () => {
    const head = (url: string, cookie?: string) =>
      app.inject({ method: 'HEAD', url, headers: cookie === undefined ? {} : { cookie } });
    expect((await head('/api/models')).statusCode).toBe(401);
    expect((await head('/api/models', cookies.get('no role'))).statusCode).toBe(403);
    expect((await head('/api/admin/database', cookies.get('Modeller'))).statusCode).toBe(403);
    expect((await head('/api/models', cookies.get('Viewer'))).statusCode).toBe(200);
  });

  it('lets an Admin store a model and export it, with no licence anywhere', async () => {
    const headers = { origin: webOrigin, cookie: cookies.get('Admin') ?? '' };
    const saved = await app.inject({
      method: 'POST',
      url: '/api/models',
      headers,
      payload: madeUpModel,
    });
    expect(saved.statusCode).toBe(201);
    const { model } = saved.json<SaveModelResult>();
    const exported = await app.inject({ method: 'GET', url: `/api/models/${model.id}`, headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.json<typeof madeUpModel>().graph.label).toBe('Made-up model');

    // What an export gives imports again, unchanged.
    const again = await app.inject({
      method: 'POST',
      url: '/api/models',
      headers,
      payload: exported.json<object>(),
    });
    expect(again.statusCode).toBe(201);
    const copy = await app.inject({
      method: 'GET',
      url: `/api/models/${again.json<SaveModelResult>().model.id}`,
      headers,
    });
    expect(copy.json<typeof madeUpModel>().graph.nodes).toEqual(
      exported.json<typeof madeUpModel>().graph.nodes,
    );
  });

  it('has no licence route left', async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const res = await app.inject({
        method,
        url: '/api/licence',
        headers: { origin: webOrigin, cookie: cookies.get('Admin') ?? '' },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('a route without an access rule', () => {
  it('stops the app from building, wherever it is registered', async () => {
    await expect(
      buildTestApp(
        {},
        {
          extraRoutes: async (instance) => {
            await instance.register(async (nested) => {
              nested.get('/api/made-up-open', async () => 'open');
            });
          },
        },
      ),
    ).rejects.toThrow(/no access rule/);
  });
});

describe('the web app route', () => {
  const dist = mkdtempSync(join(tmpdir(), 'sa-route-access-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  let app: FastifyInstance;
  const routes: string[] = [];

  beforeAll(async () => {
    app = await buildTestApp(
      {},
      {
        webApp: loadWebApp(dist),
        onRoute: (route) => {
          routes.push(`${String(route.method)} ${route.url}`);
        },
      },
    );
  });

  afterAll(async () => {
    await app.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it('adds only the public page for browsers to the routes above', () => {
    const added = routes
      .filter((route) => !route.startsWith('HEAD '))
      .filter((route) => !Object.hasOwn(expectedAccess, route));
    expect(added).toEqual(['GET /*']);
  });

  it('gives a visitor the page and nothing of the API', async () => {
    const page = await app.inject({ method: 'GET', url: '/admin/models' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="root"');
    expect((await app.inject({ method: 'GET', url: '/api/models' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/licence' })).statusCode).toBe(404);
    // The agents' paths belong to the API too, even without the database that serves them.
    for (const url of ['/oauth/authorize', '/mcp', '/.well-known/oauth-authorization-server']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(404);
    }
  });
});

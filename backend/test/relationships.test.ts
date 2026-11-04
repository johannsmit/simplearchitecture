import {
  editingUnavailableMessage,
  type DeletedRelationshipResult,
  type ElementConflict,
  type JgfDocument,
  type RelationshipChangeResult,
  type RelationshipNotFound,
  type RelationshipRejected,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
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

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000e2e2', name: 'Made-up Relationship Editor' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const unknownModel = '0b6f8d55-1c1e-4b7e-9a51-6c1c2f4f2d10';

// Made up: a bakery whose kitchen holds the oven.
const bakery: JgfDocument = {
  graph: {
    label: 'Made-up bakery',
    nodes: {
      baker: { label: 'Baker', metadata: { type: 'Stakeholder' } },
      kitchen: { label: 'Kitchen', metadata: { type: 'Infrastructure' } },
      oven: { label: 'Oven', metadata: { type: 'Application' } },
      tray: { label: 'Tray', metadata: { type: 'Other' } },
    },
    edges: [
      { id: 'b1', source: 'kitchen', target: 'oven', relation: 'Contains' },
      {
        id: 'b2',
        source: 'baker',
        target: 'oven',
        relation: 'Relation',
        metadata: { informationFlow: true },
      },
    ],
  },
};

let db: TestDb;
let idp: OAuth2Server;
let app: FastifyInstance | undefined;
let modelId: string;

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
  const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
  modelId = (await store.save(bakery, { id: 'oid-seed', name: 'Made-up Seeder' })).id;
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
});

async function signedInAs(
  roles: string[],
  withDatabase = true,
): Promise<{ target: FastifyInstance; cookie: string }> {
  app = await buildTestApp(
    { LOG_LEVEL: 'trace' },
    idpOptions(
      idp,
      withDatabase ? { database: DatabaseService.using(db, testConnection, silent) } : {},
    ),
  );
  withClaims(idp, { roles, ...user });
  const { sessionCookie } = await signIn(app);
  return { target: app, cookie: sessionCookie };
}

interface Call {
  cookie?: string;
  origin?: string | null;
  body?: unknown;
  payload?: string;
  contentType?: string;
}

function call(
  target: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: Call = {},
) {
  const origin = opts.origin === undefined ? webOrigin : opts.origin;
  const payload = opts.payload ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  return target.inject({
    method,
    url,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(payload === undefined ? {} : { 'content-type': opts.contentType ?? 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

const auditRows = () =>
  db.query<{ action: string; relationship_id: string; details: { fields: string[] } }>(
    'select action, relationship_id, details from audit order by id',
  );

const routes = (id: string): ['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown][] => [
  ['GET', `/api/models/${id}/relationships/b2`, undefined],
  [
    'POST',
    `/api/models/${id}/relationships`,
    { source: 'baker', target: 'kitchen', type: 'Relation' },
  ],
  ['PATCH', `/api/models/${id}/relationships/b2`, { version: 1, reverse: true }],
  ['DELETE', `/api/models/${id}/relationships/b2?version=1`, undefined],
];

describe('relationship routes: access', () => {
  it('gives 401 when signed out', async () => {
    app = await buildTestApp(
      {},
      idpOptions(idp, { database: DatabaseService.using(db, testConnection, silent) }),
    );
    for (const [method, url, body] of routes(modelId)) {
      const res = await call(app, method, url, { body });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('gives Viewers 403, and stores nothing', async () => {
    const { target, cookie } = await signedInAs(['Viewer']);
    for (const [method, url, body] of routes(modelId)) {
      const res = await call(target, method, url, { cookie, body });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    expect(await auditRows()).toEqual([]);
  });

  it('refuses a change from another origin', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    for (const [method, url, body] of routes(modelId).slice(1)) {
      for (const origin of ['https://evil.example', null]) {
        const res = await call(target, method, url, { cookie, origin, body });
        expect(res.statusCode, `${method} ${String(origin)}`).toBe(403);
      }
    }
    expect(await auditRows()).toEqual([]);
  });
});

describe('relationship routes: editing', () => {
  it('adds, reads, reverses, changes and deletes, with one audit row per change', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const logs = captureLogs(target);
    const base = `/api/models/${modelId}/relationships`;

    const added = await call(target, 'POST', base, {
      cookie,
      body: {
        source: 'kitchen',
        target: 'tray',
        type: 'Contains',
        description: 'Made-up secret description',
      },
    });
    expect(added.statusCode).toBe(201);
    const result = added.json<RelationshipChangeResult>();
    const { id } = result.relationship;
    expect(added.headers.location).toBe(`${base}/${id}`);
    expect(result.relationship.version).toBe(1);
    expect(result.nestingChanges).toEqual([{ elementId: 'tray', containerId: 'kitchen' }]);

    const read = await call(target, 'GET', `${base}/${id}`, { cookie });
    expect(read.json<RelationshipChangeResult>().relationship).toEqual(result.relationship);

    const reversed = await call(target, 'PATCH', `${base}/b1`, {
      cookie,
      body: { version: 1, reverse: true },
    });
    expect(reversed.statusCode).toBe(200);
    expect(reversed.json<RelationshipChangeResult>()).toMatchObject({
      relationship: { id: 'b1', version: 2, edge: { source: 'oven', target: 'kitchen' } },
      nestingChanges: [
        { elementId: 'kitchen', containerId: 'oven' },
        { elementId: 'oven', containerId: null },
      ],
    });

    const stale = await call(target, 'PATCH', `${base}/b1`, {
      cookie,
      body: { version: 1, architectureState: 'Target' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<ElementConflict>()).toMatchObject({ statusCode: 409, currentVersion: 2 });

    const changed = await call(target, 'PATCH', `${base}/b2`, {
      cookie,
      body: { version: 1, architectureState: 'Deprecate' },
    });
    expect(changed.json<RelationshipChangeResult>().relationship.version).toBe(2);

    const removed = await call(target, 'DELETE', `${base}/${id}?version=1`, { cookie });
    expect(removed.statusCode).toBe(200);
    expect(removed.json<DeletedRelationshipResult>()).toEqual({
      id,
      nestingChanges: [{ elementId: 'tray', containerId: null }],
    });

    expect((await auditRows()).map((row) => [row.action, row.relationship_id])).toEqual([
      ['relationship-added', id],
      ['relationship-reversed', 'b1'],
      ['relationship-updated', 'b2'],
      ['relationship-deleted', id],
    ]);
    const text = logs.join('\n');
    expect(text).toContain('"audit":"relationship-added"');
    expect(text).not.toContain('Made-up secret description');
  });

  it('answers 422 with fields and duplicateOf, 404 with what is missing, 400, 413 and 415', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const base = `/api/models/${modelId}/relationships`;
    const invalid = await call(target, 'POST', base, {
      cookie,
      body: { source: 'baker', target: 'oven', type: 'Uses', architectureState: 'Later' },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json<RelationshipRejected>().fields.map((issue) => issue.field)).toEqual([
      'type',
      'architectureState',
    ]);

    const first = await call(target, 'POST', base, {
      cookie,
      body: { source: 'oven', target: 'baker', type: 'Contains' },
    });
    expect(first.statusCode).toBe(201);
    const twin = await call(target, 'POST', base, {
      cookie,
      body: { source: 'oven', target: 'baker', type: 'Contains' },
    });
    expect(twin.statusCode).toBe(422);
    expect(twin.json<RelationshipRejected>()).toMatchObject({
      duplicateOf: first.json<RelationshipChangeResult>().relationship.id,
    });

    const self = await call(target, 'POST', base, {
      cookie,
      body: { source: 'oven', target: 'oven', type: 'Contains' },
    });
    expect(self.json<RelationshipRejected>().fields[0]?.field).toBe('target');

    const statuses = await Promise.all([
      call(target, 'PATCH', `${base}/nope`, { cookie, body: { version: 1 } }),
      call(target, 'DELETE', `${base}/nope?version=1`, { cookie }),
      call(target, 'GET', `/api/models/${unknownModel}/relationships/b1`, { cookie }),
      call(target, 'POST', base, {
        cookie,
        body: { source: 'nobody', target: 'oven', type: 'Relation' },
      }),
      call(target, 'POST', base, {
        cookie,
        body: { source: 'baker', target: 'nobody', type: 'Relation' },
      }),
      call(target, 'POST', '/api/models/not-a-uuid/relationships', {
        cookie,
        body: { source: 'baker', target: 'oven', type: 'Relation' },
      }),
      call(target, 'POST', base, {
        cookie,
        body: { source: 'baker', target: 'oven', type: 'Relation' },
        contentType: 'text/plain',
      }),
      call(target, 'POST', base, {
        cookie,
        payload: JSON.stringify({
          source: 'baker',
          target: 'oven',
          type: 'Relation',
          description: 'x'.repeat(70_000),
        }),
      }),
      call(target, 'DELETE', `${base}/b1`, { cookie }),
      call(target, 'PATCH', `${base}/b1`, { cookie, payload: '{"version":1,"__proto__":{"x":1}}' }),
    ]);
    expect(statuses.map((res) => res.statusCode)).toEqual([
      404, 404, 404, 404, 404, 400, 415, 413, 422, 400,
    ]);
    expect(statuses.slice(0, 5).map((res) => res.json<RelationshipNotFound>().missing)).toEqual([
      'relationship',
      'relationship',
      'model',
      'source',
      'target',
    ]);
    for (const res of statuses) expect(res.json()).not.toHaveProperty('stack');
    expect((await auditRows()).map((row) => row.action)).toEqual(['relationship-added']);
  });
});

describe('relationship routes without a database', () => {
  it('says editing is not available', async () => {
    const { target, cookie } = await signedInAs(['Modeller'], false);
    const res = await call(target, 'POST', `/api/models/${unknownModel}/relationships`, {
      cookie,
      body: { source: 'a', target: 'b', type: 'Relation' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ statusCode: 501, message: editingUnavailableMessage });
  });
});

describe('custom metadata through the route', () => {
  const url = () => `/api/models/${modelId}/relationships/b2`;
  const secret = 'made-up-value-kept-out-of-logs';

  it('keeps Modeller as the gate for metadata', async () => {
    app = await buildTestApp(
      {},
      idpOptions(idp, { database: DatabaseService.using(db, testConnection, silent) }),
    );
    const body = { version: 1, metadata: { protocol: secret } };
    expect((await call(app, 'PATCH', url(), { body })).statusCode).toBe(401);
    await app.close();
    const { target, cookie } = await signedInAs(['Viewer']);
    expect((await call(target, 'PATCH', url(), { cookie, body })).statusCode).toBe(403);
    expect(await auditRows()).toEqual([]);
  });

  it('saves for a Modeller and keeps the value out of the log and the audit row', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const logs = captureLogs(target);
    const body = { version: 1, metadata: { protocol: secret } };
    const res = await call(target, 'PATCH', url(), { cookie, body });
    expect(res.statusCode).toBe(200);
    expect(res.json<RelationshipChangeResult>().relationship.edge.metadata).toEqual({
      informationFlow: true,
      protocol: secret,
    });
    const rows = await auditRows();
    expect(rows.map((row) => row.details.fields)).toEqual([['metadata.protocol']]);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(secret);
  });

  it('answers 422 by field, 422 for a NUL, and 413 above the body limit', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const refused = await call(target, 'PATCH', url(), {
      cookie,
      body: { version: 1, metadata: { protocol: 'x'.repeat(2001) } },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json<RelationshipRejected>().fields).toEqual([
      expect.objectContaining({ field: 'metadata.protocol' }),
    ]);
    const nul = await call(target, 'PATCH', url(), {
      cookie,
      body: { version: 1, metadata: { protocol: 'a\u0000b' } },
    });
    expect(nul.statusCode).toBe(422);
    const big = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`k${i}`, 'x'.repeat(2000)]),
    );
    const large = await call(target, 'PATCH', url(), {
      cookie,
      body: { version: 1, metadata: big },
    });
    expect(large.statusCode).toBe(413);
    expect(await auditRows()).toEqual([]);
  });
});

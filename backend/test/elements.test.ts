import {
  editingUnavailableMessage,
  type DeletedElementResult,
  type ElementChangeResult,
  type ElementConflict,
  type ElementNotFound,
  type ElementRejected,
  type JgfDocument,
  type ModelListResponse,
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

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000e1e1', name: 'Made-up Element Editor' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const unknownModel = '0b6f8d55-1c1e-4b7e-9a51-6c1c2f4f2d10';

const garden: JgfDocument = {
  graph: {
    label: 'Made-up garden',
    nodes: {
      gardener: { label: 'Gardener', metadata: { type: 'Stakeholder' } },
      shed: { label: 'Shed', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      {
        id: 'g1',
        source: 'gardener',
        target: 'shed',
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
  modelId = (await store.save(garden, { id: 'oid-seed', name: 'Made-up Seeder' })).id;
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
  contentType?: string;
}

function call(
  target: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: Call = {},
) {
  const origin = opts.origin === undefined ? webOrigin : opts.origin;
  return target.inject({
    method,
    url,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.body === undefined
        ? {}
        : { 'content-type': opts.contentType ?? 'application/json' }),
    },
    ...(opts.body === undefined ? {} : { payload: JSON.stringify(opts.body) }),
  });
}

const auditCount = async () =>
  (await db.query<{ count: number }>('select count(*)::int as count from audit'))[0]?.count;

const routes = (id: string): ['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown][] => [
  ['GET', `/api/models/${id}/elements/shed`, undefined],
  ['POST', `/api/models/${id}/elements`, { type: 'Other', name: 'A' }],
  ['PATCH', `/api/models/${id}/elements/shed`, { version: 1, name: 'B' }],
  ['DELETE', `/api/models/${id}/elements/shed?version=1`, undefined],
];

describe('element routes: access', () => {
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
    expect(await auditCount()).toBe(0);
  });

  it('refuses a change from another origin', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    for (const origin of ['https://evil.example', null]) {
      const res = await call(target, 'POST', `/api/models/${modelId}/elements`, {
        cookie,
        origin,
        body: { type: 'Other', name: 'A' },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(await auditCount()).toBe(0);
  });
});

describe('element routes: editing', () => {
  it('adds, reads, changes and deletes an element, with one audit row per change', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const logs = captureLogs(target);
    const list = await call(target, 'GET', '/api/models', { cookie });
    expect(list.json<ModelListResponse>().editable).toBe(true);

    const added = await call(target, 'POST', `/api/models/${modelId}/elements`, {
      cookie,
      body: { type: 'Application', name: 'Watering', metadata: { secretNote: 'Made-up value' } },
    });
    expect(added.statusCode).toBe(201);
    const { element } = added.json<ElementChangeResult>();
    expect(added.headers.location).toBe(`/api/models/${modelId}/elements/${element.id}`);
    expect(element.version).toBe(1);

    const read = await call(target, 'GET', `/api/models/${modelId}/elements/${element.id}`, {
      cookie,
    });
    expect(read.json<ElementChangeResult>().element).toEqual(element);

    const changed = await call(target, 'PATCH', `/api/models/${modelId}/elements/${element.id}`, {
      cookie,
      body: { version: 1, metadata: { sourcing: 'Buy' } },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<ElementChangeResult>().element.version).toBe(2);

    const stale = await call(target, 'PATCH', `/api/models/${modelId}/elements/${element.id}`, {
      cookie,
      body: { version: 1, name: 'Mine' },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<ElementConflict>()).toMatchObject({ statusCode: 409, currentVersion: 2 });

    const removed = await call(
      target,
      'DELETE',
      `/api/models/${modelId}/elements/gardener?version=1`,
      { cookie },
    );
    expect(removed.statusCode).toBe(200);
    expect(removed.json<DeletedElementResult>()).toEqual({
      id: 'gardener',
      deletedRelationshipCount: 1,
      deletedRelationshipIds: ['g1'],
      unnestedElementIds: [],
    });

    const model = await call(target, 'GET', `/api/models/${modelId}`, { cookie });
    expect(Object.keys(model.json<JgfDocument>().graph.nodes ?? {})).toEqual(['shed', element.id]);
    expect(await auditCount()).toBe(3);
    // The log has ids and actions, never names, keys or values.
    const text = logs.join('\n');
    expect(text).toContain('"audit":"element-added"');
    expect(text).not.toContain('Watering');
    expect(text).not.toContain('secretNote');
    expect(text).not.toContain('Made-up value');
  });

  it('answers 422 with field messages, 404, 400 and 415, and stores nothing', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const invalid = await call(target, 'POST', `/api/models/${modelId}/elements`, {
      cookie,
      body: { type: 'Application', name: '', metadata: { sourcing: 'Lease' } },
    });
    expect(invalid.statusCode).toBe(422);
    const body = invalid.json<ElementRejected>();
    expect(body.fields.map((issue) => issue.field)).toEqual(['name']);

    const badValue = await call(target, 'PATCH', `/api/models/${modelId}/elements/shed`, {
      cookie,
      body: { version: 1, metadata: { architectureState: 'Someday' } },
    });
    expect(badValue.statusCode).toBe(422);
    expect(badValue.json<ElementRejected>().fields).toEqual([
      {
        field: 'metadata.architectureState',
        message: expect.stringMatching(/^Must be one of/) as string,
      },
    ]);

    const statuses = await Promise.all([
      call(target, 'PATCH', `/api/models/${modelId}/elements/nope`, {
        cookie,
        body: { version: 1 },
      }),
      call(target, 'DELETE', `/api/models/${modelId}/elements/nope?version=1`, { cookie }),
      call(target, 'GET', `/api/models/${unknownModel}/elements/shed`, { cookie }),
      call(target, 'POST', `/api/models/${unknownModel}/elements`, {
        cookie,
        body: { type: 'Other', name: 'A' },
      }),
      call(target, 'POST', '/api/models/not-a-uuid/elements', {
        cookie,
        body: { type: 'Other', name: 'A' },
      }),
      call(target, 'POST', `/api/models/${modelId}/elements`, {
        cookie,
        body: { type: 'Other', name: 'A' },
        contentType: 'text/plain',
      }),
      call(target, 'DELETE', `/api/models/${modelId}/elements/shed`, { cookie }),
    ]);
    expect(statuses.map((res) => res.statusCode)).toEqual([404, 404, 404, 404, 400, 415, 422]);
    // The form tells "someone else deleted this element" from an unknown model.
    expect(statuses.slice(0, 4).map((res) => res.json<ElementNotFound>().missing)).toEqual([
      'element',
      'element',
      'model',
      'model',
    ]);
    for (const res of statuses) expect(res.json()).not.toHaveProperty('stack');
    expect(await auditCount()).toBe(0);
  });
});

describe('element routes without a database', () => {
  it('says editing is not available', async () => {
    const { target, cookie } = await signedInAs(['Modeller'], false);
    const list = await call(target, 'GET', '/api/models', { cookie });
    expect(list.json<ModelListResponse>().editable).toBe(false);
    const res = await call(target, 'POST', `/api/models/${unknownModel}/elements`, {
      cookie,
      body: { type: 'Other', name: 'A' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ statusCode: 501, message: editingUnavailableMessage });
  });
});

describe('element routes: hostile input', () => {
  const raw = (
    target: FastifyInstance,
    method: 'POST' | 'PATCH',
    url: string,
    cookie: string,
    payload: string,
  ) =>
    target.inject({
      method,
      url,
      headers: { origin: webOrigin, cookie, 'content-type': 'application/json' },
      payload,
    });

  const storedMetadata = async () =>
    (
      await db.query<{ metadata: Record<string, unknown> | null }>(
        "select metadata from elements where model_id = $1::uuid and id = 'shed'",
        [modelId],
      )
    )[0]?.metadata;

  it('refuses prototype keys, reserved keys, bad shapes and huge bodies; stores and audits nothing', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const add = `/api/models/${modelId}/elements`;
    const shed = `/api/models/${modelId}/elements/shed`;
    const before = await storedMetadata();

    const results = await Promise.all([
      raw(
        target,
        'POST',
        add,
        cookie,
        '{"type":"Other","name":"A","metadata":{"__proto__":{"polluted":"yes"}}}',
      ),
      raw(target, 'PATCH', shed, cookie, '{"version":1,"metadata":{"__proto__":"x"}}'),
      raw(
        target,
        'PATCH',
        shed,
        cookie,
        '{"version":1,"metadata":{"simplearchitecture:internal":"x"}}',
      ),
      raw(target, 'PATCH', shed, cookie, '{"version":1,"metadata":{"type":"Application"}}'),
      raw(target, 'PATCH', shed, cookie, '{"version":1,"metadata":["a"]}'),
      raw(target, 'PATCH', shed, cookie, '{"version":1,"id":"other","name":"X"}'),
      raw(target, 'PATCH', shed, cookie, '{"version":"1","name":"X"}'),
      raw(target, 'PATCH', shed, cookie, '{"version":1.5,"name":"X"}'),
      raw(target, 'PATCH', shed, cookie, '{"version":1,"name":"' + 'x'.repeat(201) + '"}'),
      raw(target, 'POST', add, cookie, '{"type":"Other","name":"A","metadata":{"k":{"a":1}}}'),
      raw(target, 'POST', add, cookie, '[1]'),
      raw(target, 'POST', add, cookie, 'null'),
      raw(target, 'POST', add, cookie, '{not json'),
      raw(
        target,
        'POST',
        add,
        cookie,
        JSON.stringify({ type: 'Other', name: 'A', description: 'd'.repeat(2 * 1024 * 1024) }),
      ),
    ]);
    expect(results.map((res) => res.statusCode)).toEqual([
      // 400: Fastify's JSON parser itself refuses an own __proto__ key.
      400, 400, 422, 422, 422, 422, 422, 422, 422, 422, 422, 422, 400, 413,
    ]);
    for (const res of results) {
      expect(res.body).not.toContain('polluted');
      expect(res.json()).not.toHaveProperty('stack');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(await storedMetadata()).toEqual(before);
    expect(await auditCount()).toBe(0);
  });

  it('stores a "constructor" key as plain custom metadata, and an audit row has no values', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await call(target, 'PATCH', `/api/models/${modelId}/elements/shed`, {
      cookie,
      body: {
        version: 1,
        metadata: { constructor: 'Made-up audit value', toString: 'Another audit value' },
      },
    });
    expect(res.statusCode).toBe(200);
    const rows = await db.query<{ details: unknown; element_id: string }>(
      'select details, element_id from audit',
    );
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('audit value');
    expect(rows[0]?.element_id).toBe('shed');
  });

  it('a stale PATCH and a stale DELETE store nothing and write no audit row', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const url = `/api/models/${modelId}/elements/shed`;
    expect(
      (await call(target, 'PATCH', url, { cookie, body: { version: 1, name: 'Fresh' } }))
        .statusCode,
    ).toBe(200);
    expect(await auditCount()).toBe(1);
    const stale = await call(target, 'PATCH', url, { cookie, body: { version: 1, name: 'Stale' } });
    const staleDelete = await call(target, 'DELETE', `${url}?version=1`, { cookie });
    expect([stale.statusCode, staleDelete.statusCode]).toEqual([409, 409]);
    expect(await auditCount()).toBe(1);
    const got = await call(target, 'GET', url, { cookie });
    expect(got.json<ElementChangeResult>().element.node.label).toBe('Fresh');
  });
});

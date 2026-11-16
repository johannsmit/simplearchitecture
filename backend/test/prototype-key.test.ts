import {
  prototypeKeyMessage,
  type JgfDocument,
  type ModelAuthor,
  type RelationshipPropertyRejected,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { parseEditingJson } from '../src/routes/body.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import {
  buildTestApp,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';
import { createTestDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

// A metadata key `__proto__` is refused with the forms' message, at its field, never dropped
// silently. Made-up data only.

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000f3f3', name: 'Made-up Proto Modeller' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const seeder: ModelAuthor = { id: 'oid-seed', name: 'Made-up Seeder' };

const garden: JgfDocument = {
  graph: {
    label: 'Made-up garden',
    nodes: {
      gardener: { label: 'Gardener', metadata: { type: 'Stakeholder' } },
      shed: { label: 'Shed', metadata: { type: 'Infrastructure', colour: 'Green' } },
    },
    edges: [{ id: 'g1', source: 'gardener', target: 'shed', relation: 'Relation' }],
  },
};

let db: TestDb;
let idp: OAuth2Server;
let app: FastifyInstance | undefined;
let store: PostgresModelStore;
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
  store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
  modelId = (await store.save(garden, seeder)).id;
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
});

async function signedInAs(roles: string[]): Promise<{ target: FastifyInstance; cookie: string }> {
  await app?.close();
  app = await buildTestApp(
    { LOG_LEVEL: 'silent' },
    idpOptions(idp, { database: DatabaseService.using(db, testConnection, silent) }),
  );
  withClaims(idp, { roles, ...user });
  const { sessionCookie } = await signIn(app);
  return { target: app, cookie: sessionCookie };
}

/** A request with a body written by hand, as JSON.stringify drops a `__proto__` key. */
function raw(
  target: FastifyInstance,
  method: 'POST' | 'PATCH',
  url: string,
  cookie: string,
  payload: string,
) {
  return target.inject({
    method,
    url,
    headers: { origin: webOrigin, cookie, 'content-type': 'application/json' },
    payload,
  });
}

const refusal = { field: 'metadata.__proto__', message: prototypeKeyMessage };

describe('a metadata key __proto__ at the API', () => {
  it('is refused at its field on an element and a relationship, and nothing changes', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const models = `/api/models/${modelId}`;
    const results = await Promise.all([
      raw(
        target,
        'POST',
        `${models}/elements`,
        cookie,
        '{"type":"Other","name":"A","metadata":{"__proto__":"x"}}',
      ),
      raw(
        target,
        'PATCH',
        `${models}/elements/shed`,
        cookie,
        '{"version":1,"metadata":{"__proto__":"x"}}',
      ),
      raw(
        target,
        'PATCH',
        `${models}/relationships/g1`,
        cookie,
        '{"version":1,"metadata":{"__proto__":"x"}}',
      ),
    ]);
    for (const res of results) {
      expect(res.statusCode).toBe(422);
      expect(res.json<RelationshipPropertyRejected>().fields).toEqual([refusal]);
    }
    const stored = await store.get(modelId);
    expect(stored?.graph.nodes?.shed?.metadata).toEqual({
      type: 'Infrastructure',
      colour: 'Green',
    });
    expect(Object.keys(stored?.graph.nodes ?? {})).toEqual(['gardener', 'shed']);
    expect(stored?.graph.edges?.[0]?.metadata).toBeUndefined();
  });

  it('is refused anywhere else in the body, as before, and so is constructor.prototype', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const shed = `/api/models/${modelId}/elements/shed`;
    const elsewhere = await raw(
      target,
      'PATCH',
      shed,
      cookie,
      '{"version":1,"__proto__":{"name":"X"}}',
    );
    expect(elsewhere.statusCode).toBe(400);
    expect(elsewhere.json<{ message: string }>().message).toBe(prototypeKeyMessage);
    const nested = await raw(
      target,
      'PATCH',
      shed,
      cookie,
      '{"version":1,"metadata":{"a":{"__proto__":{}}}}',
    );
    expect(nested.statusCode).toBe(400);
    const poisoned = await raw(
      target,
      'PATCH',
      shed,
      cookie,
      '{"version":1,"constructor":{"prototype":{}}}',
    );
    expect(poisoned.statusCode).toBe(400);
    expect(({} as Record<string, unknown>).name).toBeUndefined();
  });

  it('is refused on a new relationship too, and other routes keep the standard parser', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const models = `/api/models/${modelId}`;
    const added = await raw(
      target,
      'POST',
      `${models}/relationships`,
      cookie,
      '{"source":"gardener","target":"shed","type":"Relation","metadata":{"__proto__":"x"}}',
    );
    expect(added.statusCode).toBe(422);
    expect(added.json<RelationshipPropertyRejected>().fields).toEqual([refusal]);
    expect((await store.get(modelId))?.graph.edges).toHaveLength(1);
    // The editing routes' parser stays in their own plugins: a view's body still can't hold one.
    const view = await raw(
      target,
      'POST',
      `${models}/views`,
      cookie,
      '{"name":"Made-up view","elementIds":[],"relationshipIds":[],"metadata":{"__proto__":{}}}',
    );
    expect(view.statusCode).toBe(400);
    expect(view.json<{ message: string }>().message).not.toBe(prototypeKeyMessage);
  });

  it('keeps __proto__ in metadata as a plain own key, never as a prototype', () => {
    const body = parseEditingJson('{"metadata":{"__proto__":{"polluted":"yes"}}}') as {
      metadata: Record<string, unknown>;
    };
    expect(Object.hasOwn(body.metadata, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(body.metadata)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('is refused as a property key on Admin → Properties, with the same message', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await target.inject({
      method: 'POST',
      url: '/api/properties',
      headers: { origin: webOrigin, cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Made-up proto', key: '__proto__', kind: 'text' }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<RelationshipPropertyRejected>().fields).toEqual([
      { field: 'key', message: prototypeKeyMessage },
    ]);
  });
});

import { PGlite } from '@electric-sql/pglite';
import type {
  ElementPropertyRejected,
  JgfDocument,
  ModelAuthor,
  RelationshipPropertyListResponse,
  SaveModelResult,
} from '@simplearchitecture/shared';
import { referenceKey } from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { DatabaseService } from '../src/db/service.js';
import { ElementService } from '../src/editing/element-service.js';
import { McpReadService } from '../src/mcp/read-service.js';
import { PropertyService } from '../src/properties/property-service.js';
import { readElementDefinitions } from '../src/properties/property-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { ViewService } from '../src/views/view-service.js';
import {
  buildTestApp,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';
import { createTestDb, pgliteDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

// The edges of element properties: the list a change names in `for`, keys that are names of
// object members or kept by the server, a type change with defined values, a deleted property a
// view groups by, and the upgrade on odd keys. Made-up data only.

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000e2e2', name: 'Made-up Edge Admin' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const seeder: ModelAuthor = { id: 'oid-seed', name: 'Made-up Seeder' };
const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };
const ref = (...ids: string[]) => ({ [referenceKey]: ids });

// Made up: a greenhouse with a pump and its controller.
const greenhouse: JgfDocument = {
  graph: {
    label: 'Made-up greenhouse',
    nodes: {
      pump: {
        label: 'Pump',
        metadata: { type: 'Infrastructure', zone: 'North', drives: ref('panel') },
      },
      panel: { label: 'Panel', metadata: { type: 'Application', sourcing: 'Buy' } },
    },
    edges: [{ id: 'g1', source: 'panel', target: 'pump', relation: 'Relation' }],
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
  modelId = (await store.save(greenhouse, seeder)).id;
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

function call(
  target: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string | undefined,
  body?: string | object,
) {
  const payload =
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return target.inject({
    method,
    url,
    headers: {
      origin: webOrigin,
      ...(cookie === undefined ? {} : { cookie }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

const lists = async (target: FastifyInstance, cookie: string) =>
  (await call(target, 'GET', '/api/properties', cookie)).json<RelationshipPropertyListResponse>();
const keysOf = (list: readonly { key: string }[]) => list.map((definition) => definition.key);
const elementUrl = (id: string) => `/api/models/${modelId}/elements/${id}`;
const newProperty = { name: 'Made-up', key: 'madeUp', kind: 'text' };

describe('the list a change names in for', () => {
  it('refuses a for that is empty, unknown, sent twice or next to an unknown query field', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const before = await lists(target, cookie);
    for (const query of [
      '?for=',
      '?for=Element',
      '?for=elements',
      '?for=element&for=element',
      '?for=element&list=element',
    ]) {
      const res = await call(target, 'POST', `/api/properties${query}`, cookie, newProperty);
      expect(res.statusCode, query).toBe(422);
    }
    for (const query of ['?for=node&key=zone', '?key=zone&for=element&x=1']) {
      expect((await call(target, 'DELETE', `/api/properties${query}`, cookie)).statusCode).toBe(
        422,
      );
      const patch = await call(target, 'PATCH', `/api/properties${query}`, cookie, {
        version: 1,
        name: 'Zone name',
      });
      expect(patch.statusCode).toBe(422);
    }
    expect(await lists(target, cookie)).toEqual(before);
  });

  it('changes the relationship list without for or with for=relationship, never the element list', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    // `zone` is an element property only: the relationship list has no such key.
    expect((await call(target, 'DELETE', '/api/properties?key=zone', cookie)).statusCode).toBe(404);
    const patch = await call(target, 'PATCH', '/api/properties?for=relationship&key=zone', cookie, {
      version: 1,
      name: 'Zone name',
    });
    expect(patch.statusCode).toBe(404);
    const created = await call(
      target,
      'POST',
      '/api/properties?for=relationship',
      cookie,
      newProperty,
    );
    expect(created.statusCode).toBe(201);
    const body = await lists(target, cookie);
    expect(keysOf(body.properties)).toEqual(['madeUp']);
    expect(keysOf(body.elementProperties)).toEqual(['drives', 'zone']);
    expect((await store.get(modelId))?.graph.nodes?.pump?.metadata).toMatchObject({
      zone: 'North',
    });
    // And the other way: an element delete of a relationship-only key is not found.
    expect(
      (await call(target, 'DELETE', '/api/properties?for=element&key=madeUp', cookie)).statusCode,
    ).toBe(404);
    expect(keysOf((await lists(target, cookie)).properties)).toEqual(['madeUp']);
  });

  it('answers 401 without a session on every element property route, and changes nothing', async () => {
    const { target } = await signedInAs(['Admin']);
    const requests: [method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: object][] = [
      ['GET', '/api/properties'],
      ['GET', '/api/properties/usage'],
      ['POST', '/api/properties?for=element', newProperty],
      ['PATCH', '/api/properties?for=element&key=zone', { version: 1, name: 'Zone name' }],
      ['DELETE', '/api/properties?for=element&key=zone'],
    ];
    for (const [method, url, body] of requests) {
      expect((await call(target, method, url, undefined, body)).statusCode, url).toBe(401);
    }
    expect(keysOf(await new PropertyService(db).listElements())).toEqual(['drives', 'zone']);
  });
});

describe('keys that name object members or are kept by the server', () => {
  it('refuses them on an element while they aren’t defined, and stores nothing', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const before = await store.get(modelId);
    for (const key of [
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      referenceKey,
      'simplearchitecture:note',
    ]) {
      const res = await call(target, 'PATCH', elementUrl('pump'), cookie, {
        version: 1,
        metadata: { [key]: 'Made-up value' },
      });
      expect(res.statusCode, key).toBe(422);
      expect(res.json<ElementPropertyRejected>().fields.map((issue) => issue.field)).toEqual([
        `metadata.${key}`,
      ]);
      const added = await call(target, 'POST', `/api/models/${modelId}/elements`, cookie, {
        type: 'Other',
        name: 'Valve',
        metadata: { [key]: 'Made-up value' },
      });
      expect(added.statusCode, key).toBe(422);
    }
    expect(await store.get(modelId)).toEqual(before);
  });

  it('takes constructor and toString once an Admin defines them, as own keys everywhere', async () => {
    const properties = new PropertyService(db);
    await properties.create({ name: 'Builder', key: 'constructor', kind: 'text' }, seeder, {
      for: 'element',
    });
    await properties.create({ name: 'toString', key: 'toString', kind: 'reference' }, seeder, {
      for: 'element',
    });
    const service = new ElementService(store);
    const set = await service.updateElement(
      modelId,
      'panel',
      { version: 1, metadata: { constructor: 'Made-up works', toString: ref('pump') } },
      modeller,
    );
    expect(set.element.node.metadata).toEqual({
      type: 'Application',
      sourcing: 'Buy',
      constructor: 'Made-up works',
      toString: ref('pump'),
    });
    const mcp = new McpReadService(store, properties);
    const panel = await mcp.element(modelId, 'panel');
    expect(panel.definedProperties).toEqual({
      Builder: 'Made-up works',
      toString: [{ id: 'pump', name: 'Pump' }],
    });
    // An element without them has none: no member of an object is read as a value.
    const pump = await mcp.element(modelId, 'pump');
    expect(Object.keys(pump.definedProperties ?? {})).toEqual(['drives', 'zone']);
    const deleted = await properties.delete({ key: 'constructor', for: 'element' }, seeder);
    expect(deleted).toEqual({ key: 'constructor', values: 1, models: 1 });
    expect((await store.get(modelId))?.graph.nodes?.panel?.metadata).toEqual({
      type: 'Application',
      sourcing: 'Buy',
      toString: ref('pump'),
    });
  });
});

describe('a type change and a delete, with element properties', () => {
  it('keeps a defined value as a defined one through a type change, and back', async () => {
    const service = new ElementService(store);
    const changed = await service.updateElement(
      modelId,
      'pump',
      { version: 1, type: 'Stakeholder' },
      modeller,
    );
    expect(changed.element.node.metadata).toEqual({
      type: 'Stakeholder',
      zone: 'North',
      drives: ref('panel'),
    });
    // Still defined, so still checked by its kind, not as Was a property.
    await expect(
      service.updateElement(modelId, 'pump', { version: 2, metadata: { zone: ['A'] } }, modeller),
    ).rejects.toThrow();
    const panel = await service.updateElement(
      modelId,
      'panel',
      { version: 1, type: 'Other' },
      modeller,
    );
    expect(panel.element.node.metadata).toEqual({ type: 'Other', sourcing: 'Buy' });
    const back = await service.updateElement(
      modelId,
      'panel',
      { version: 2, type: 'Application', metadata: { sourcing: 'Build' } },
      modeller,
    );
    expect(back.element.node.metadata).toEqual({ type: 'Application', sourcing: 'Build' });
  });

  it('leaves a view that groups by a deleted property readable', async () => {
    const properties = new PropertyService(db);
    const views = new ViewService(store, properties);
    const { view } = await views.createView(
      modelId,
      { name: 'By zone', elementIds: ['pump', 'panel'], groupBy: 'zone' },
      modeller,
    );
    await properties.delete({ key: 'zone', for: 'element' }, seeder);
    const read = await views.getView(modelId, view.id);
    expect(read.view.elementIds).toEqual(expect.arrayContaining(['pump', 'panel']));
    expect((await views.listViews(modelId)).views.map((listed) => listed.name)).toEqual([
      'By zone',
    ]);
  });
});

describe('import with keys the lists hold already', () => {
  it('adds an element key that is a relationship property too, and leaves a defined one', async () => {
    await new PropertyService(db).create({ name: 'Region', key: 'region', kind: 'text' }, seeder);
    const { target, cookie } = await signedInAs(['Admin']);
    const file: JgfDocument = {
      graph: {
        label: 'Made-up orchard',
        nodes: {
          tree: { label: 'Tree', metadata: { type: 'Other', region: 'East', zone: 'South' } },
        },
      },
    };
    const res = await call(target, 'POST', '/api/models', cookie, file);
    expect(res.statusCode).toBe(201);
    expect(res.json<SaveModelResult>().newElementProperties).toEqual([
      { key: 'region', name: 'region', kind: 'text', values: 1 },
    ]);
    const body = await lists(target, cookie);
    expect(keysOf(body.properties)).toEqual(['region']);
    expect(keysOf(body.elementProperties)).toEqual(['drives', 'region', 'zone']);
  });
});

describe('the upgrade on odd keys', () => {
  it('never defines __proto__, the type or the server’s keys, and takes constructor as a key', async () => {
    const target = pgliteDb(new PGlite());
    try {
      const migrations = loadMigrations().filter((migration) => migration.version <= '020');
      await migrate(
        target,
        migrations.filter((migration) => migration.version <= '019'),
      );
      const old = await PostgresModelStore.open(target, { log: { warn: () => undefined } });
      await old.save(greenhouse, seeder);
      // Stored as is, as a model from before could hold them.
      await target.query(`update elements set metadata = metadata || $1::jsonb where id = 'pump'`, [
        JSON.stringify({
          constructor: 'Made-up works',
          'simplearchitecture:note': 'kept by the server',
          '': 'blank',
        }),
      ]);
      await target.query(
        `update elements set metadata = metadata || '{"__proto__": "odd"}'::jsonb where id = 'panel'`,
      );
      expect(await migrate(target, migrations)).toBe(1);
      const keys = keysOf(await readElementDefinitions(target));
      expect(keys).toEqual(['constructor', 'drives', 'zone']);
      const [row] = await target.query<{ metadata: Record<string, unknown> }>(
        `select metadata from elements where id = 'panel'`,
      );
      expect(Object.hasOwn(row?.metadata ?? {}, '__proto__')).toBe(true);
    } finally {
      await target.close();
    }
  });
});

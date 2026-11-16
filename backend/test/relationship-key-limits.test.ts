import {
  definitionsForKeys,
  maxPropertyKeyLength,
  withImportableRelationshipKeys,
  type DeletedRelationshipPropertyResult,
  type JgfDocument,
  type ModelAuthor,
  type RelationshipPropertyListResponse,
  type RelationshipPropertyResult,
  type SaveModelResult,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { insertDefinitions, readDefinitions } from '../src/properties/property-store.js';
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

// Relationship keys no property can have: blank, or over 100 characters. An import shortens or
// leaves them out; one defined before (by an earlier import or the upgrade) can still be managed.
// Made-up data only.

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000f2f2', name: 'Made-up Key Admin' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const seeder: ModelAuthor = { id: 'oid-seed', name: 'Made-up Seeder' };

// 124 characters; two keys that differ only after the first 100.
const prefix = 'madeUpSupplierContractReference'.repeat(4);
const longOne = `${prefix}One`;
const longTwo = `${prefix}Two`;
// Over 100 characters only because of spaces: trimmed, it is a standard key.
const paddedStandard = `  description${' '.repeat(100)}`;

describe('withImportableRelationshipKeys', () => {
  it('keeps every key that is fine, and the edges as they are', () => {
    const edges = [{ metadata: { region: 'North', ' spaced ': 'x' } }, {}];
    const result = withImportableRelationshipKeys(edges);
    expect(result.changes).toEqual([]);
    expect(result.edges[0]).toBe(edges[0]);
  });

  it('leaves out blank keys and shortens long ones, uniquely and never to a standard key', () => {
    const edges = [
      {
        id: 'a',
        metadata: {
          first: 'kept',
          [longOne]: 'one',
          '': 'empty',
          '   ': 'spaces',
          [longTwo]: 'two',
          [paddedStandard]: 'padded',
          [prefix.slice(0, maxPropertyKeyLength)]: 'taken',
        },
      },
      { id: 'b', metadata: { [longOne]: 'one again' } },
    ];
    const { edges: result, changes } = withImportableRelationshipKeys(edges);
    const cut = prefix.slice(0, maxPropertyKeyLength);
    expect(changes).toEqual([
      { key: '', values: 1 },
      { key: '   ', values: 1 },
      {
        key: `${paddedStandard.slice(0, maxPropertyKeyLength)}…`,
        storedAs: 'description (2)',
        values: 1,
      },
      { key: `${cut}…`, storedAs: `${prefix.slice(0, 96)} (2)`, values: 2 },
      { key: `${cut}…`, storedAs: `${prefix.slice(0, 96)} (3)`, values: 1 },
    ]);
    // In the order they were, under their new keys.
    expect(Object.entries(result[0]?.metadata ?? {})).toEqual([
      ['first', 'kept'],
      [`${prefix.slice(0, 96)} (2)`, 'one'],
      [`${prefix.slice(0, 96)} (3)`, 'two'],
      ['description (2)', 'padded'],
      [cut, 'taken'],
    ]);
    expect(result[1]?.metadata).toEqual({ [`${prefix.slice(0, 96)} (2)`]: 'one again' });
    for (const change of changes) {
      expect(change.storedAs?.length ?? 0).toBeLessThanOrEqual(maxPropertyKeyLength);
    }
    // The input isn't changed.
    expect(Object.keys(edges[0]?.metadata ?? {})).toHaveLength(7);
  });
});

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
  cookie: string,
  body?: unknown,
) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return target.inject({
    method,
    url,
    headers: {
      origin: webOrigin,
      cookie,
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

const keyQuery = (key: string) => `/api/properties?key=${encodeURIComponent(key)}`;
const relationshipUrl = (id: string) => `/api/models/${modelId}/relationships/${id}`;
const storedMetadata = async (id: string) =>
  (await store.get(modelId))?.graph.edges?.find((edge) => edge.id === id)?.metadata;

// Made up: a kitchen, as an earlier version imported it, with odd keys on its relationships.
const kitchen: JgfDocument = {
  graph: {
    label: 'Made-up kitchen',
    nodes: {
      cook: { label: 'Cook', metadata: { type: 'Stakeholder' } },
      oven: { label: 'Oven', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      {
        id: 'k1',
        source: 'cook',
        target: 'oven',
        relation: 'Relation',
        metadata: { [longOne]: 'Long value', '   ': 'Blank value', '': 'Empty key value' },
      },
    ],
  },
};

describe('a blank or long property defined before this version', () => {
  beforeEach(async () => {
    await resetTestDb(db);
    store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    modelId = (await store.save(kitchen, seeder)).id;
    // As an earlier import (or the upgrade) defined them; the empty key never was.
    const existing = await readDefinitions(db);
    const missing = [longOne, '   '].filter((key) => !existing.some((d) => d.key === key));
    await insertDefinitions(db, definitionsForKeys(missing, existing));
  });

  it('can have its values changed and removed on a relationship, through the API', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const changed = await call(target, 'PATCH', relationshipUrl('k1'), cookie, {
      version: 1,
      metadata: { [longOne]: 'Changed long', '   ': 'Changed blank' },
    });
    expect(changed.statusCode).toBe(200);
    expect(await storedMetadata('k1')).toEqual({
      [longOne]: 'Changed long',
      '   ': 'Changed blank',
      '': 'Empty key value',
    });
    const removed = await call(target, 'PATCH', relationshipUrl('k1'), cookie, {
      version: 2,
      metadata: { [longOne]: null, '   ': null, '': null },
    });
    expect(removed.statusCode).toBe(200);
    expect(await storedMetadata('k1')).toEqual({});
  });

  it('still refuses a new blank or long key that isn’t a property', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await call(target, 'PATCH', relationshipUrl('k1'), cookie, {
      version: 1,
      metadata: { [longTwo]: 'x', '\t': 'y' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ fields: unknown[] }>().fields).toEqual([
      {
        field: `metadata.${longTwo}`,
        message: 'The property name must be at most 100 characters.',
      },
      { field: 'metadata.\t', message: 'Enter a name for the property.' },
    ]);
  });

  it('can be renamed by an Admin with its key sent back as it is, and deleted by its key', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const list = (
      await call(target, 'GET', '/api/properties', cookie)
    ).json<RelationshipPropertyListResponse>().properties;
    const blank = list.find((property) => property.key === '   ');
    const renamed = await call(target, 'PATCH', keyQuery('   '), cookie, {
      version: blank?.version,
      name: 'Made-up blank',
      key: '   ',
      kind: 'text',
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<RelationshipPropertyResult>().property).toMatchObject({
      key: '   ',
      name: 'Made-up blank',
      fromModels: false,
    });

    for (const key of [longOne, '   ']) {
      const deleted = await call(target, 'DELETE', keyQuery(key), cookie);
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json<DeletedRelationshipPropertyResult>()).toEqual({
        key,
        values: 1,
        models: 1,
      });
    }
    expect(await storedMetadata('k1')).toEqual({ '': 'Empty key value' });
  });
});

describe('importing blank and long relationship keys', () => {
  beforeEach(async () => {
    await resetTestDb(db);
    store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
  });

  const pantry = {
    graph: {
      label: 'Made-up pantry',
      nodes: {
        shelf: { label: 'Shelf', metadata: { type: 'Infrastructure' } },
        jar: { label: 'Jar', metadata: { type: 'Other', [longOne]: 'element keys stay' } },
      },
      edges: [
        {
          id: 'p1',
          source: 'shelf',
          target: 'jar',
          relation: 'Relation',
          metadata: { [longOne]: 'one', [longTwo]: 'two', '': 'empty', '  ': 'spaces', size: 'S' },
        },
        {
          id: 'p2',
          source: 'jar',
          target: 'shelf',
          relation: 'Relation',
          metadata: { [longOne]: 'again' },
        },
      ],
    },
  };

  it('shortens long keys, leaves blank ones out, says so, and defines no odd property', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await call(target, 'POST', '/api/models', cookie, pantry);
    expect(res.statusCode).toBe(201);
    const body = res.json<SaveModelResult>();
    const cut = prefix.slice(0, maxPropertyKeyLength);
    expect(body.changedKeys).toEqual([
      { key: '', values: 1 },
      { key: '  ', values: 1 },
      { key: `${cut}…`, storedAs: cut, values: 2 },
      { key: `${cut}…`, storedAs: `${prefix.slice(0, 96)} (2)`, values: 1 },
    ]);
    expect(body.newProperties?.map((added) => added.key)).toEqual([
      `${prefix.slice(0, 96)} (2)`,
      cut,
      'size',
    ]);
    const stored = await store.get(body.model.id);
    expect(stored?.graph.edges?.[0]?.metadata).toEqual({
      [cut]: 'one',
      [`${prefix.slice(0, 96)} (2)`]: 'two',
      size: 'S',
    });
    expect(stored?.graph.edges?.[1]?.metadata).toEqual({ [cut]: 'again' });
    // Elements keep their custom metadata as it is.
    expect(stored?.graph.nodes?.jar?.metadata).toMatchObject({ [longOne]: 'element keys stay' });
    for (const property of await readDefinitions(db)) {
      expect(property.key.trim()).not.toBe('');
      expect(property.key.length).toBeLessThanOrEqual(maxPropertyKeyLength);
    }
    // The same file again: its shortened keys hold the properties the first import added.
    const again = await call(target, 'POST', '/api/models', cookie, pantry);
    expect(again.json<SaveModelResult>().newProperties).toBeUndefined();
    expect(again.json<SaveModelResult>().changedKeys).toHaveLength(4);
  });

  it('says nothing when every key is fine', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const fine = { graph: { ...pantry.graph, edges: [] } };
    const res = await call(target, 'POST', '/api/models', cookie, fine);
    expect(res.statusCode).toBe(201);
    expect(res.json<SaveModelResult>()).not.toHaveProperty('changedKeys');
  });
});

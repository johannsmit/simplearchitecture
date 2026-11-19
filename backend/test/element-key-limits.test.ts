import {
  maxPropertyKeyLength,
  withImportableElementKeys,
  type JgfDocument,
  type ModelAuthor,
  type SaveModelResult,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { readDefinitions } from '../src/properties/property-store.js';
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

// Element property names no form would make: blank, or over 100 characters. An import shortens or
// leaves them out, as for relationships; ones stored before can still be changed and removed.
// Elements keep free custom metadata, so no property is defined for them. Made-up data only.

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000e4e4', name: 'Made-up Element Admin' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const seeder: ModelAuthor = { id: 'oid-seed', name: 'Made-up Seeder' };

// 124 characters; two names that differ only after the first 100.
const prefix = 'madeUpWarrantyCertificateNumber'.repeat(4);
const longOne = `${prefix}One`;
const longTwo = `${prefix}Two`;
const cut = prefix.slice(0, maxPropertyKeyLength);
const numbered = (n: number) => `${prefix.slice(0, 96)} (${String(n)})`;
// Over 100 characters only because of spaces: trimmed, they are a standard and a reserved key.
const paddedStandard = `  owningTeam${' '.repeat(100)}`;
const paddedType = `type${' '.repeat(100)}`;

describe('withImportableElementKeys', () => {
  it('keeps every name that is fine, and the nodes as they are', () => {
    const nodes = {
      a: { label: 'A', metadata: { type: 'Other', region: 'North', ' spaced ': 'x' } },
      b: { label: 'B' },
    };
    const result = withImportableElementKeys(nodes);
    expect(result.changes).toEqual([]);
    expect(result.nodes.a).toBe(nodes.a);
    expect(Object.keys(result.nodes)).toEqual(['a', 'b']);
  });

  it('leaves out blank names and shortens long ones, uniquely and never to a standard key', () => {
    const nodes = {
      a: {
        label: 'A',
        metadata: {
          type: 'Other',
          first: 'kept',
          [longOne]: 'one',
          '': 'empty',
          '   ': 'spaces',
          [longTwo]: 'two',
          [paddedStandard]: 'padded',
          [paddedType]: 'typed',
        },
      },
      // Another element's name: a shortened one never takes it.
      b: { label: 'B', metadata: { type: 'Other', [cut]: 'taken', [longOne]: 'one again' } },
    };
    const { nodes: result, changes } = withImportableElementKeys(nodes);
    expect(changes).toEqual([
      { key: '', values: 1 },
      { key: '   ', values: 1 },
      {
        key: `${paddedStandard.slice(0, maxPropertyKeyLength)}…`,
        storedAs: 'owningTeam (2)',
        values: 1,
      },
      { key: `${cut}…`, storedAs: numbered(2), values: 2 },
      { key: `${cut}…`, storedAs: numbered(3), values: 1 },
      { key: `${paddedType.slice(0, maxPropertyKeyLength)}…`, storedAs: 'type (2)', values: 1 },
    ]);
    expect(Object.entries(result.a?.metadata ?? {})).toEqual([
      ['type', 'Other'],
      ['first', 'kept'],
      [numbered(2), 'one'],
      [numbered(3), 'two'],
      ['owningTeam (2)', 'padded'],
      ['type (2)', 'typed'],
    ]);
    expect(result.b?.metadata).toEqual({
      type: 'Other',
      [cut]: 'taken',
      [numbered(2)]: 'one again',
    });
    // The input isn't changed.
    expect(Object.keys(nodes.a.metadata)).toHaveLength(8);
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
  method: 'POST' | 'PATCH',
  url: string,
  cookie: string,
  body: unknown,
) {
  return target.inject({
    method,
    url,
    headers: { origin: webOrigin, cookie, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

const elementUrl = (id: string) => `/api/models/${modelId}/elements/${id}`;
const storedMetadata = async (id: string) =>
  (await store.get(modelId))?.graph.nodes?.[id]?.metadata;

// Made up: a workshop, as an earlier version stored it, with odd names.
const workshop: JgfDocument = {
  graph: {
    label: 'Made-up workshop',
    nodes: {
      bench: {
        label: 'Bench',
        metadata: {
          type: 'Infrastructure',
          [longOne]: 'Long value',
          '   ': 'Blank value',
          '': 'Empty name value',
          colour: 'Green',
        },
      },
    },
    edges: [],
  },
};

describe('a blank or long element property stored before this version', () => {
  beforeEach(async () => {
    await resetTestDb(db);
    store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    modelId = (await store.save(workshop, seeder)).id;
  });

  it('can have its value changed and be removed, through the API', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const changed = await call(target, 'PATCH', elementUrl('bench'), cookie, {
      version: 1,
      metadata: { [longOne]: 'Changed long', '   ': 'Changed blank', '': 'Changed empty' },
    });
    expect(changed.statusCode).toBe(200);
    expect(await storedMetadata('bench')).toEqual({
      type: 'Infrastructure',
      [longOne]: 'Changed long',
      '   ': 'Changed blank',
      '': 'Changed empty',
      colour: 'Green',
    });
    const removed = await call(target, 'PATCH', elementUrl('bench'), cookie, {
      version: 2,
      metadata: { [longOne]: null, '   ': null, '': null },
    });
    expect(removed.statusCode).toBe(200);
    expect(await storedMetadata('bench')).toEqual({ type: 'Infrastructure', colour: 'Green' });
  });

  it('can be renamed: the old name removed and a new one set in one change', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await call(target, 'PATCH', elementUrl('bench'), cookie, {
      version: 1,
      metadata: { [longOne]: null, warranty: 'Long value' },
    });
    expect(res.statusCode).toBe(200);
    expect(await storedMetadata('bench')).toMatchObject({ warranty: 'Long value' });
    expect(await storedMetadata('bench')).not.toHaveProperty(longOne);
  });

  it('still refuses a new blank or long name', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const res = await call(target, 'PATCH', elementUrl('bench'), cookie, {
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
    const created = await call(target, 'POST', `/api/models/${modelId}/elements`, cookie, {
      type: 'Other',
      name: 'Made-up stool',
      metadata: { [longTwo]: 'x' },
    });
    expect(created.statusCode).toBe(422);
  });
});

describe('importing blank and long element property names', () => {
  beforeEach(async () => {
    await resetTestDb(db);
    store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
  });

  const shed: JgfDocument = {
    graph: {
      label: 'Made-up shed',
      nodes: {
        rack: {
          label: 'Rack',
          metadata: { type: 'Infrastructure', [longOne]: 'one', '': 'empty', size: 'L' },
        },
        saw: {
          label: 'Saw',
          metadata: { type: 'Other', [longOne]: 'again', [longTwo]: 'two', '  ': 'spaces' },
        },
      },
      edges: [
        {
          id: 's1',
          source: 'rack',
          target: 'saw',
          relation: 'Relation',
          metadata: { [longOne]: 'on a line' },
        },
      ],
    },
  };

  it('shortens long names, leaves blank ones out, says so apart from relationships', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await call(target, 'POST', '/api/models', cookie, shed);
    expect(res.statusCode).toBe(201);
    const body = res.json<SaveModelResult>();
    expect(body.changedElementKeys).toEqual([
      { key: '', values: 1 },
      { key: '  ', values: 1 },
      { key: `${cut}…`, storedAs: cut, values: 2 },
      { key: `${cut}…`, storedAs: numbered(2), values: 1 },
    ]);
    expect(body.changedKeys).toEqual([{ key: `${cut}…`, storedAs: cut, values: 1 }]);
    const stored = await store.get(body.model.id);
    expect(stored?.graph.nodes?.rack?.metadata).toEqual({
      type: 'Infrastructure',
      [cut]: 'one',
      size: 'L',
    });
    expect(stored?.graph.nodes?.saw?.metadata).toEqual({
      type: 'Other',
      [cut]: 'again',
      [numbered(2)]: 'two',
    });
    // Elements keep free custom metadata: only the relationship's key is a property.
    expect((await readDefinitions(db)).map((property) => property.key)).not.toContain('size');
  });

  it('says nothing when every name is fine', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const fine = {
      graph: {
        label: 'Made-up shed',
        nodes: { rack: { label: 'Rack', metadata: { type: 'Other', size: 'L' } } },
      },
    };
    const res = await call(target, 'POST', '/api/models', cookie, fine);
    expect(res.statusCode).toBe(201);
    expect(res.json<SaveModelResult>()).not.toHaveProperty('changedElementKeys');
  });
});

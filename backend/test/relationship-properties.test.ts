import { readFileSync } from 'node:fs';
import type {
  DeletedRelationshipPropertyResult,
  ImportOefModelResult,
  JgfDocument,
  ModelAuthor,
  RelationshipPropertyDefinition,
  RelationshipPropertyListResponse,
  RelationshipPropertyRejected,
  RelationshipPropertyResult,
  RelationshipPropertyUsageResponse,
  SaveModelResult,
} from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { validateJgf } from '../src/jgf/validate.js';
import { McpReadService } from '../src/mcp/read-service.js';
import { PropertyService } from '../src/properties/property-service.js';
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

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000f1f1', name: 'Made-up Property Admin' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const seeder: ModelAuthor = { id: 'oid-seed', name: 'Made-up Seeder' };
const bakeryOef = readFileSync(new URL('./fixtures/bakery-oef.xml', import.meta.url), 'utf8');

// Made up: a post office whose sorting room holds the scanner.
const postOffice: JgfDocument = {
  graph: {
    label: 'Made-up post office',
    nodes: {
      clerk: { label: 'Clerk', metadata: { type: 'Stakeholder', badge: 'element-only' } },
      room: { label: 'Sorting room', metadata: { type: 'Infrastructure' } },
      scanner: { label: 'Scanner', metadata: { type: 'Application' } },
      ledger: { label: 'Ledger', metadata: { type: 'Application' } },
    },
    edges: [
      {
        id: 'p1',
        source: 'clerk',
        target: 'scanner',
        relation: 'Relation',
        label: 'Scans at {region}',
        metadata: { region: 'North' },
      },
      { id: 'p2', source: 'scanner', target: 'ledger', relation: 'Relation' },
      {
        id: 'p3',
        source: 'room',
        target: 'scanner',
        relation: 'Contains',
        metadata: { region: 'Kept on a Contains' },
      },
    ],
  },
};

// Made up: a second model holding the same key.
const depot: JgfDocument = {
  graph: {
    label: 'Made-up depot',
    nodes: {
      driver: { label: 'Driver', metadata: { type: 'Stakeholder' } },
      van: { label: 'Van', metadata: { type: 'Other' } },
    },
    edges: [
      {
        id: 'd1',
        source: 'driver',
        target: 'van',
        relation: 'Relation',
        metadata: { region: 'South' },
      },
    ],
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
  modelId = (await store.save(postOffice, seeder)).id;
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
});

async function signedInAs(roles: string[]): Promise<{ target: FastifyInstance; cookie: string }> {
  await app?.close();
  app = await buildTestApp(
    { LOG_LEVEL: 'trace' },
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
  contentType = 'application/json',
) {
  const payload =
    body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return target.inject({
    method,
    url,
    headers: {
      origin: webOrigin,
      cookie,
      ...(payload === undefined ? {} : { 'content-type': contentType }),
    },
    ...(payload === undefined ? {} : { payload }),
  });
}

const keyQuery = (key: string) => `/api/properties?key=${encodeURIComponent(key)}`;

const list = async (target: FastifyInstance, cookie: string) =>
  (await call(target, 'GET', '/api/properties', cookie)).json<RelationshipPropertyListResponse>()
    .properties;

const definitionOf = async (key: string): Promise<RelationshipPropertyDefinition | undefined> =>
  (await new PropertyService(db).list()).find((definition) => definition.key === key);

const fieldsOf = (body: unknown) => (body as RelationshipPropertyRejected).fields;

const relationshipUrl = (id: string, model = modelId) => `/api/models/${model}/relationships/${id}`;

describe('reading the definitions', () => {
  it('lists the properties the save of a model added, for every role, by name', async () => {
    for (const role of ['Viewer', 'Modeller', 'Admin']) {
      const { target, cookie } = await signedInAs([role]);
      expect(await list(target, cookie)).toEqual([
        { key: 'region', name: 'region', kind: 'text', fromModels: true, version: 1 },
      ]);
    }
  });

  it('refuses everyone without a role, and the usage to anyone but an Admin', async () => {
    const { target, cookie } = await signedInAs([]);
    expect((await call(target, 'GET', '/api/properties', cookie)).statusCode).toBe(403);
    for (const role of ['Viewer', 'Modeller']) {
      const signed = await signedInAs([role]);
      const usage = await call(signed.target, 'GET', '/api/properties/usage', signed.cookie);
      expect(usage.statusCode).toBe(403);
    }
  });
});

describe('Admin-only definition changes', () => {
  it('refuses a Modeller and a Viewer at the API, and changes nothing', async () => {
    for (const role of ['Viewer', 'Modeller']) {
      const { target, cookie } = await signedInAs([role]);
      const create = { name: 'Cost centre', key: 'costCentre', kind: 'text' };
      expect((await call(target, 'POST', '/api/properties', cookie, create)).statusCode).toBe(403);
      const patch = { version: 1, name: 'Region' };
      expect((await call(target, 'PATCH', keyQuery('region'), cookie, patch)).statusCode).toBe(403);
      expect((await call(target, 'DELETE', keyQuery('region'), cookie)).statusCode).toBe(403);
    }
    expect(await new PropertyService(db).list()).toEqual([
      { key: 'region', name: 'region', kind: 'text', fromModels: true, version: 1 },
    ]);
    expect(
      await db.query(
        "select action from audit where action like 'property-%' and user_id is not null",
      ),
    ).toEqual([{ action: 'property-added' }]);
  });

  it('lets an Admin create a text and a choice property, audited by key and field names', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const logs = captureLogs(target);
    const text = await call(target, 'POST', '/api/properties', cookie, {
      name: '  Cost centre ',
      key: ' costCentre ',
      kind: 'text',
    });
    expect(text.statusCode).toBe(201);
    expect(text.json<RelationshipPropertyResult>().property).toEqual({
      key: 'costCentre',
      name: 'Cost centre',
      kind: 'text',
      fromModels: false,
      version: 1,
    });
    const choice = await call(target, 'POST', '/api/properties', cookie, {
      name: 'Criticality',
      key: 'criticality',
      kind: 'choice',
      options: [' Low', 'Medium', 'High '],
    });
    expect(choice.statusCode).toBe(201);
    expect(choice.json<RelationshipPropertyResult>().property.options).toEqual([
      'Low',
      'Medium',
      'High',
    ]);
    expect((await list(target, cookie)).map((definition) => definition.name)).toEqual([
      'Cost centre',
      'Criticality',
      'region',
    ]);
    const rows = await db.query<{ action: string; user_id: string; details: object }>(
      "select action, user_id, details from audit where action = 'property-added' and user_id = $1",
      [user.oid],
    );
    expect(rows.map((row) => row.details)).toEqual([
      { key: 'costCentre', fields: ['name', 'key', 'kind'] },
      { key: 'criticality', fields: ['name', 'key', 'kind', 'options'] },
    ]);
    const text_ = JSON.stringify(rows) + logs.join('\n');
    for (const secret of ['Cost centre', 'Criticality', 'Medium'])
      expect(text_).not.toContain(secret);
  });

  it('refuses names, keys and options that break the rules, with a message per field', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    await call(target, 'POST', '/api/properties', cookie, {
      name: 'Criticality',
      key: 'criticality',
      kind: 'text',
    });
    const refused = async (body: object) => {
      const res = await call(target, 'POST', '/api/properties', cookie, {
        name: 'Fine name',
        key: 'fineKey',
        kind: 'text',
        ...body,
      });
      expect(res.statusCode).toBe(422);
      return fieldsOf(res.json());
    };
    expect(await refused({ name: '  ' })).toEqual([{ field: 'name', message: 'Enter a name.' }]);
    expect(await refused({ name: 'x'.repeat(61) })).toEqual([
      { field: 'name', message: 'Use 60 characters or fewer.' },
    ]);
    expect(await refused({ name: 'Has {braces}' })).toEqual([
      { field: 'name', message: "Names can't hold { or }." },
    ]);
    expect(await refused({ name: 'CRITICALITY' })).toEqual([
      { field: 'name', message: "There's already a property called “Criticality”." },
    ]);
    expect(await refused({ name: 'identity' })).toEqual([
      { field: 'name', message: '“Identity” is a standard property.' },
    ]);
    expect(await refused({ key: 'sourceToTargetData' })).toEqual([
      { field: 'key', message: "“sourceToTargetData” is a standard property's key." },
    ]);
    for (const key of ['type', 'simplearchitecture:x', 'data', 'informationFlow']) {
      expect(await refused({ key })).toEqual([
        { field: 'key', message: 'This key is reserved. Use another one.' },
      ]);
    }
    expect(await refused({ key: 'CRITICALITY' })).toEqual([
      { field: 'key', message: "There's already a property with the key “criticality”." },
    ]);
    expect(await refused({ kind: 'choice', options: ['Only one'] })).toEqual([
      { field: 'options', message: 'Add at least 2 options.' },
    ]);
    expect(await refused({ kind: 'choice', options: ['High', 'high'] })).toEqual([
      { field: 'options.1', message: 'high is in the list twice.' },
    ]);
    expect(await refused({ kind: 'number' })).toEqual([
      { field: 'kind', message: 'Must be text or choice.' },
    ]);
    expect(await refused({ extra: true })).toEqual([
      { field: 'extra', message: 'Is not a field of a property.' },
    ]);
  });

  it('answers 404 for a property that is gone and 409 for an older version', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const gone = await call(target, 'PATCH', keyQuery('nothing'), cookie, {
      version: 1,
      name: 'X',
    });
    expect(gone.statusCode).toBe(404);
    expect((await call(target, 'DELETE', keyQuery('nothing'), cookie)).statusCode).toBe(404);
    const saved = await call(target, 'PATCH', keyQuery('region'), cookie, {
      version: 1,
      name: 'Region',
    });
    expect(saved.statusCode).toBe(200);
    const stale = await call(target, 'PATCH', keyQuery('region'), cookie, {
      version: 1,
      name: 'Area',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ currentVersion: number }>().currentVersion).toBe(2);
  });
});

describe('key locking, kind and option changes', () => {
  it('keeps a key with values, while name, kind and options change and values stay', async () => {
    const before = await store.get(modelId);
    const { target, cookie } = await signedInAs(['Admin']);
    const moved = await call(target, 'PATCH', keyQuery('region'), cookie, {
      version: 1,
      key: 'area',
    });
    expect(moved.statusCode).toBe(422);
    expect(fieldsOf(moved.json())).toEqual([
      { field: 'key', message: "The key can't change: values use it now." },
    ]);
    const saved = await call(target, 'PATCH', keyQuery('region'), cookie, {
      version: 1,
      name: 'Region',
      kind: 'choice',
      options: ['North', 'East'],
    });
    expect(saved.statusCode).toBe(200);
    // Saving one from models marks it checked.
    expect(saved.json<RelationshipPropertyResult>().property).toEqual({
      key: 'region',
      name: 'Region',
      kind: 'choice',
      options: ['North', 'East'],
      fromModels: false,
      version: 2,
    });
    // Values outside the list stay as they are, and the model still validates.
    const after = await store.get(modelId);
    expect(after).toEqual(before);
    expect(validateJgf(after).valid).toBe(true);
    // Choice → text drops the options.
    const back = await call(target, 'PATCH', keyQuery('region'), cookie, {
      version: 2,
      kind: 'text',
    });
    expect(back.json<RelationshipPropertyResult>().property).toEqual({
      key: 'region',
      name: 'Region',
      kind: 'text',
      fromModels: false,
      version: 3,
    });
    const rows = await db.query<{ details: object }>(
      "select details from audit where action = 'property-changed' order by id",
    );
    expect(rows.map((row) => row.details)).toEqual([
      { key: 'region', fields: ['name', 'kind', 'options', 'fromModels'] },
      { key: 'region', fields: ['kind', 'options'] },
    ]);
  });

  it('changes a key nobody uses yet', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    await call(target, 'POST', '/api/properties', cookie, {
      name: 'Owner',
      key: 'owner',
      kind: 'text',
    });
    const moved = await call(target, 'PATCH', keyQuery('owner'), cookie, {
      version: 1,
      key: 'dataOwner',
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<RelationshipPropertyResult>().property.key).toBe('dataOwner');
    expect(await definitionOf('owner')).toBeUndefined();
  });
});

describe('relationships take defined keys only', () => {
  it('refuses a new custom key at create and at update, for a Modeller and an Admin', async () => {
    for (const role of ['Modeller', 'Admin']) {
      const { target, cookie } = await signedInAs([role]);
      const created = await call(target, 'POST', `/api/models/${modelId}/relationships`, cookie, {
        source: 'clerk',
        target: 'ledger',
        type: 'Relation',
        metadata: { region: 'West' },
      });
      expect(created.statusCode).toBe(422);
      expect(fieldsOf(created.json())).toEqual([
        { field: 'metadata', message: 'Is not a field of a relationship.' },
      ]);
      const updated = await call(target, 'PATCH', relationshipUrl('p2'), cookie, {
        version: 1,
        metadata: { madeUpKey: 'x' },
      });
      expect(updated.statusCode).toBe(422);
      expect(fieldsOf(updated.json())).toEqual([
        {
          field: 'metadata.madeUpKey',
          message: "“madeUpKey” isn't a property here. An Admin can add it in Admin → Properties.",
        },
      ]);
    }
  });

  it('still lets a Modeller add new custom names on an element, defining no property', async () => {
    const { target, cookie } = await signedInAs(['Modeller']);
    const before = await list(target, cookie);
    // A relationship property's key and a name no relationship has.
    const res = await call(target, 'PATCH', `/api/models/${modelId}/elements/clerk`, cookie, {
      version: 1,
      metadata: { region: 'Made-up west', deskNumber: '7' },
    });
    expect(res.statusCode).toBe(200);
    const node = (await store.get(modelId))?.graph.nodes?.clerk;
    expect(node?.metadata).toEqual({
      type: 'Stakeholder',
      badge: 'element-only',
      region: 'Made-up west',
      deskNumber: '7',
    });
    expect(await list(target, cookie)).toEqual(before);
  });

  it('sets a defined property on a Relation, checks a choice, and keeps a value outside the list', async () => {
    const service = new PropertyService(db);
    await service.create(
      { name: 'Criticality', key: 'criticality', kind: 'choice', options: ['Low', 'High'] },
      seeder,
    );
    const relationships = new RelationshipService(store);
    const set = await relationships.updateRelationship(
      modelId,
      'p2',
      { version: 1, metadata: { criticality: 'High', region: 'East' } },
      seeder,
    );
    expect(set.relationship.edge.metadata).toMatchObject({ criticality: 'High', region: 'East' });
    await expect(
      relationships.updateRelationship(
        modelId,
        'p2',
        { version: 2, metadata: { criticality: 'Medium' } },
        seeder,
      ),
    ).rejects.toMatchObject({
      fields: [{ field: 'metadata.criticality', message: 'Pick one of Low, High.' }],
    });
    // A value from before the list changed stays when other fields are saved.
    const definition = await definitionOf('criticality');
    await service.update(
      { key: 'criticality' },
      { version: definition?.version, options: ['Low', 'Medium'] },
      seeder,
    );
    const kept = await relationships.updateRelationship(
      modelId,
      'p2',
      { version: 2, metadata: { criticality: 'High' }, description: 'Made-up' },
      seeder,
    );
    expect(kept.relationship.edge.metadata).toMatchObject({ criticality: 'High' });
  });

  it('keeps defined values as custom metadata on Relation → Contains, and back', async () => {
    const relationships = new RelationshipService(store);
    const contains = await relationships.updateRelationship(
      modelId,
      'p1',
      { version: 1, type: 'Contains' },
      seeder,
    );
    expect(contains.relationship.edge.relation).toBe('Contains');
    expect(contains.relationship.edge.metadata).toMatchObject({ region: 'North' });
    // On a Contains it can change and go, but no defined key it doesn't hold can be added.
    const changed = await relationships.updateRelationship(
      modelId,
      'p1',
      { version: 2, metadata: { region: 'North-east' } },
      seeder,
    );
    expect(changed.relationship.edge.metadata).toMatchObject({ region: 'North-east' });
    await new PropertyService(db).create({ name: 'Owner', key: 'owner', kind: 'text' }, seeder);
    await expect(
      relationships.updateRelationship(
        modelId,
        'p1',
        { version: 3, metadata: { owner: 'x' } },
        seeder,
      ),
    ).rejects.toMatchObject({ fields: [{ field: 'metadata.owner' }] });
    const relation = await relationships.updateRelationship(
      modelId,
      'p1',
      { version: 3, type: 'Relation', metadata: { owner: 'Made-up owner' } },
      seeder,
    );
    expect(relation.relationship.edge.metadata).toMatchObject({
      region: 'North-east',
      owner: 'Made-up owner',
    });
  });
});

describe('import adds properties', () => {
  it('adds a JGF import’s new relationship keys as text properties, and reports them', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await call(target, 'POST', '/api/models', cookie, depotWithNewKeys);
    expect(res.statusCode).toBe(201);
    const body = res.json<SaveModelResult>();
    // `region` was defined already; element keys stay custom metadata.
    expect(body.newProperties).toEqual([
      { key: 'platform', name: 'platform', values: 2 },
      { key: 'shift', name: 'shift', values: 1 },
    ]);
    const keys = (await list(target, cookie)).map((definition) => definition.key);
    expect(keys).toEqual(['platform', 'region', 'shift']);
    const stored = (
      await call(target, 'GET', `/api/models/${body.model.id}`, cookie)
    ).json<JgfDocument>();
    expect(stored.graph.edges?.[0]?.metadata).toMatchObject({ platform: 'P1', shift: 'Night' });
    // Nothing new: no list in the answer.
    const again = await call(target, 'POST', '/api/models', cookie, depotWithNewKeys);
    expect(again.json<SaveModelResult>().newProperties).toBeUndefined();
  });

  it('adds an ArchiMate import’s relationship keys, archimateType too, and counts them apart', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await call(
      target,
      'POST',
      '/api/models/import/oef',
      cookie,
      bakeryOef,
      'application/xml',
    );
    expect(res.statusCode).toBe(201);
    const body = res.json<ImportOefModelResult>();
    expect(body.newProperties?.map((added) => added.key)).toEqual([
      'archimateType',
      'integrationType',
    ]);
    expect(body.report.properties.onRelationships.keptAsCustom).toEqual({ integrationType: 1 });
    const keys = (await list(target, cookie)).map((definition) => definition.key);
    // Element keys such as internalExternal stay custom metadata on elements.
    expect(keys).not.toContain('internalExternal');
    expect(keys).toEqual(expect.arrayContaining(['archimateType', 'integrationType']));
  });
});

const depotWithNewKeys = JSON.stringify({
  graph: {
    ...depot.graph,
    nodes: {
      ...depot.graph.nodes,
      van: { label: 'Van', metadata: { type: 'Other', plate: 'element key' } },
    },
    edges: [
      {
        id: 'd1',
        source: 'driver',
        target: 'van',
        relation: 'Relation',
        metadata: { region: 'South', platform: 'P1', shift: 'Night' },
      },
      {
        id: 'd2',
        source: 'van',
        target: 'driver',
        relation: 'Contains',
        metadata: { platform: 'P2' },
      },
    ],
  },
});

describe('deleting a property', () => {
  it('removes it and its values from every relationship in every model, with versions and audit', async () => {
    const depotId = (await store.save(depot, seeder)).id;
    const versions = async () =>
      db.query<{ id: string; version: number }>('select id::text, version from models order by id');
    const before = await versions();
    const { target, cookie } = await signedInAs(['Admin']);
    const usage = (
      await call(target, 'GET', '/api/properties/usage', cookie)
    ).json<RelationshipPropertyUsageResponse>();
    expect(usage.usage).toEqual([
      {
        key: 'region',
        relations: 2,
        contains: 1,
        models: 2,
        values: [
          { value: 'Kept on a Contains', count: 1 },
          { value: 'North', count: 1 },
          { value: 'South', count: 1 },
        ],
        labels: 1,
      },
    ]);
    const res = await call(target, 'DELETE', keyQuery('region'), cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json<DeletedRelationshipPropertyResult>()).toEqual({
      key: 'region',
      values: 3,
      models: 2,
    });
    expect(await list(target, cookie)).toEqual([]);
    for (const id of [modelId, depotId]) {
      const document = await store.get(id);
      for (const edge of document?.graph.edges ?? [])
        expect(edge.metadata ?? {}).not.toHaveProperty('region');
      expect(validateJgf(document).valid).toBe(true);
    }
    const after = await versions();
    expect(after.map((row) => row.version)).toEqual(before.map((row) => row.version + 1));
    // Each changed relationship has a new version.
    expect(
      await db.query(
        "select id, version from relationships where id in ('p1', 'p3', 'd1', 'p2') order by id",
      ),
    ).toEqual([
      { id: 'd1', version: 2 },
      { id: 'p1', version: 2 },
      { id: 'p2', version: 1 },
      { id: 'p3', version: 2 },
    ]);
    const rows = await db.query<{ action: string; model_id: string | null; details: object }>(
      `select action, model_id::text, details from audit
       where action in ('relationship-property-deleted', 'property-deleted') order by id`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          action: 'relationship-property-deleted',
          model_id: modelId,
          details: { key: 'region', relationships: 2 },
        },
        {
          action: 'relationship-property-deleted',
          model_id: depotId,
          details: { key: 'region', relationships: 1 },
        },
        {
          action: 'property-deleted',
          model_id: null,
          details: { key: 'region', values: 3, models: 2 },
        },
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toMatch(/North|South|Kept on/);
  });

  it('leaves every model as it was when it fails in the middle', async () => {
    const depotId = (await store.save(depot, seeder)).id;
    const before = await db.query('select * from relationships order by model_id, ordinal');
    // Made up: the database refuses to change the second model.
    await db.exec(`
      create function refuse_depot() returns trigger language plpgsql as $$
      begin
        if new.id = '${depotId}'::uuid then raise exception 'made-up failure'; end if;
        return new;
      end $$;
      create trigger refuse_depot before update on models for each row execute function refuse_depot();
    `);
    try {
      await expect(new PropertyService(db).delete({ key: 'region' }, seeder)).rejects.toThrow();
      expect(await db.query('select * from relationships order by model_id, ordinal')).toEqual(
        before,
      );
      expect(await definitionOf('region')).toBeDefined();
    } finally {
      await db.exec('drop trigger refuse_depot on models; drop function refuse_depot();');
    }
  });

  it('gives a relationship form opened before the delete the usual conflict', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    await call(target, 'DELETE', keyQuery('region'), cookie);
    const stale = await call(target, 'PATCH', relationshipUrl('p1'), cookie, {
      version: 1,
      description: 'Made-up',
    });
    expect(stale.statusCode).toBe(409);
    // Another Relation's form that fills it in is refused by key.
    const other = await call(target, 'PATCH', relationshipUrl('p2'), cookie, {
      version: 1,
      metadata: { region: 'West' },
    });
    expect(other.statusCode).toBe(422);
    expect(fieldsOf(other.json())[0]?.field).toBe('metadata.region');
  });
});

describe('the MCP tools', () => {
  it('show a Relation’s defined properties by name, and labels by name or by old key', async () => {
    const properties = new PropertyService(db);
    const region = await definitionOf('region');
    await properties.update(
      { key: 'region' },
      { version: region?.version, name: 'Sorting region' },
      seeder,
    );
    await new RelationshipService(store).updateRelationship(
      modelId,
      'p2',
      { version: 1, label: 'In {Sorting region}', metadata: { region: 'West' } },
      seeder,
    );
    const mcp = new McpReadService(store, properties);
    const scanner = await mcp.element(modelId, 'scanner');
    const byId = new Map(
      scanner.relationships.map((relationship) => [relationship.id, relationship]),
    );
    expect(byId.get('p1')).toMatchObject({
      label: 'Scans at {region}',
      displayLabel: 'Scans at North',
      definedProperties: { 'Sorting region': 'North' },
    });
    expect(byId.get('p2')).toMatchObject({
      displayLabel: 'In West',
      definedProperties: { 'Sorting region': 'West' },
    });
    // A Contains keeps such a value as custom metadata, not as a defined property.
    expect(byId.get('p3')).not.toHaveProperty('definedProperties');
    const near = await mcp.neighbours(modelId, 'clerk', 1);
    expect(near.relationships[0]).toMatchObject({
      definedProperties: { 'Sorting region': 'North' },
    });
  });
});

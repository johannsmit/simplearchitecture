import type {
  DeletedElementPropertyResult,
  ElementPropertyDefinition,
  ElementPropertyRejected,
  ElementPropertyResult,
  JgfDocument,
  ModelAuthor,
  RelationshipPropertyListResponse,
  RelationshipPropertyUsageResponse,
  SaveModelResult,
} from '@simplearchitecture/shared';
import { referenceKey } from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { ElementRejectedError, ElementService } from '../src/editing/element-service.js';
import { validateJgf } from '../src/jgf/validate.js';
import { McpReadService } from '../src/mcp/read-service.js';
import { PropertyService } from '../src/properties/property-service.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { ViewService } from '../src/views/view-service.js';
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

// Element properties an Admin defines (Admin → Properties, `for=element`), the server's rules for
// element metadata that follow from them, import, delete and the MCP tools. Made-up data only.

const user = { oid: '9f0c4f8e-0000-4000-8000-00000000e1e1', name: 'Made-up Element Admin' };
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const seeder: ModelAuthor = { id: 'oid-seed', name: 'Made-up Seeder' };
const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };
const ref = (...ids: string[]) => ({ [referenceKey]: ids });

// Made up: a bakery whose oven room holds the oven. `costCentre` is text, `feeds` a Reference,
// `sourcing` on the Stakeholder was a property of another type.
const bakery: JgfDocument = {
  graph: {
    label: 'Made-up bakery',
    nodes: {
      baker: {
        label: 'Baker',
        metadata: { type: 'Stakeholder', costCentre: 'CC-1', sourcing: 'Build' },
      },
      oven: {
        label: 'Oven',
        metadata: { type: 'Infrastructure', costCentre: 'CC-2', feeds: ref('till') },
      },
      till: { label: 'Till', metadata: { type: 'Application', sourcing: 'Buy' } },
    },
    edges: [{ id: 'b1', source: 'baker', target: 'oven', relation: 'Relation' }],
  },
};

// Made up: a second model with the same text key.
const mill: JgfDocument = {
  graph: {
    label: 'Made-up mill',
    nodes: {
      wheel: { label: 'Wheel', metadata: { type: 'Other', costCentre: 'CC-1' } },
      stone: { label: 'Stone', metadata: { type: 'Other' } },
    },
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
  modelId = (await store.save(bakery, seeder)).id;
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

const elementQuery = (key?: string) =>
  `/api/properties?for=element${key === undefined ? '' : `&key=${encodeURIComponent(key)}`}`;

const lists = async (target: FastifyInstance, cookie: string) =>
  (await call(target, 'GET', '/api/properties', cookie)).json<RelationshipPropertyListResponse>();

const fromModels = (
  key: string,
  kind: ElementPropertyDefinition['kind'] = 'text',
): ElementPropertyDefinition => ({ key, name: key, kind, fromModels: true, version: 1 });

const elementUrl = (id: string, model = modelId) => `/api/models/${model}/elements/${id}`;

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ElementRejectedError)) throw new Error(`not rejected: ${String(error)}`);
  return error.fields;
}

describe('reading the element properties', () => {
  it('lists both lists for every role; the save defined the model’s element keys', async () => {
    for (const role of ['Viewer', 'Modeller', 'Admin']) {
      const { target, cookie } = await signedInAs([role]);
      const body = await lists(target, cookie);
      expect(body.properties).toEqual([]);
      // A standard property of another type (`sourcing` on the Stakeholder) is none.
      expect(body.elementProperties).toEqual([
        fromModels('costCentre'),
        fromModels('feeds', 'reference'),
      ]);
    }
  });

  it('gives an Admin the usage per element property: elements, models and values by shape', async () => {
    await store.save(mill, seeder);
    await db.query(`update elements set metadata = metadata || $1::jsonb where id = 'stone'`, [
      JSON.stringify({ costCentre: ref('wheel'), feeds: ['a list'] }),
    ]);
    const { target, cookie } = await signedInAs(['Admin']);
    const usage = (
      await call(target, 'GET', '/api/properties/usage', cookie)
    ).json<RelationshipPropertyUsageResponse>();
    expect(usage.usage).toEqual([]);
    expect(usage.elementUsage).toEqual([
      {
        key: 'costCentre',
        elements: 4,
        models: 2,
        shapes: { text: 3, reference: 1, other: 0 },
        values: [
          { value: 'CC-1', count: 2 },
          { value: 'CC-2', count: 1 },
        ],
      },
      {
        key: 'feeds',
        elements: 2,
        models: 2,
        shapes: { text: 0, reference: 1, other: 1 },
        values: [],
      },
    ]);
    for (const role of ['Viewer', 'Modeller']) {
      const signed = await signedInAs([role]);
      const refused = await call(signed.target, 'GET', '/api/properties/usage', signed.cookie);
      expect(refused.statusCode).toBe(403);
    }
  });
});

describe('Admin-only element property changes', () => {
  it('refuses a Viewer and a Modeller, and changes nothing', async () => {
    for (const role of ['Viewer', 'Modeller']) {
      const { target, cookie } = await signedInAs([role]);
      const create = { name: 'Lifecycle', key: 'lifecycle', kind: 'text' };
      expect((await call(target, 'POST', elementQuery(), cookie, create)).statusCode).toBe(403);
      const patch = { version: 1, name: 'Cost centre' };
      expect(
        (await call(target, 'PATCH', elementQuery('costCentre'), cookie, patch)).statusCode,
      ).toBe(403);
      expect((await call(target, 'DELETE', elementQuery('costCentre'), cookie)).statusCode).toBe(
        403,
      );
    }
    expect((await new PropertyService(db).listElements()).map((d) => d.key)).toEqual([
      'costCentre',
      'feeds',
    ]);
  });

  it('lets an Admin create each kind, by name; audit rows hold keys and field names only', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const logs = captureLogs(target);
    const created = async (body: object) => {
      const res = await call(target, 'POST', elementQuery(), cookie, body);
      expect(res.statusCode).toBe(201);
      return res.json<ElementPropertyResult>().property;
    };
    expect(await created({ name: ' Hosted on ', key: ' hostedOn ', kind: 'reference' })).toEqual({
      key: 'hostedOn',
      name: 'Hosted on',
      kind: 'reference',
      fromModels: false,
      version: 1,
    });
    expect(
      (await created({ name: 'Lifecycle', key: 'lifecycle', kind: 'choice', options: ['A', 'B'] }))
        .options,
    ).toEqual(['A', 'B']);
    expect((await created({ name: 'Notes', key: 'notes', kind: 'text' })).kind).toBe('text');
    // Unique per list: a relationship property may have the same name and key.
    await call(target, 'POST', '/api/properties', cookie, {
      name: 'Region',
      key: 'region',
      kind: 'text',
    });
    expect((await created({ name: 'Region', key: 'region', kind: 'text' })).key).toBe('region');
    const body = await lists(target, cookie);
    expect(body.properties.map((d) => d.key)).toEqual(['region']);
    expect(body.elementProperties.map((d) => d.name)).toEqual([
      'costCentre',
      'feeds',
      'Hosted on',
      'Lifecycle',
      'Notes',
      'Region',
    ]);
    const rows = await db.query<{ details: object }>(
      "select details from audit where action = 'element-property-added' and user_id = $1",
      [user.oid],
    );
    expect(rows.map((row) => row.details)).toEqual([
      { key: 'hostedOn', fields: ['name', 'key', 'kind'] },
      { key: 'lifecycle', fields: ['name', 'key', 'kind', 'options'] },
      { key: 'notes', fields: ['name', 'key', 'kind'] },
      { key: 'region', fields: ['name', 'key', 'kind'] },
    ]);
    const text = JSON.stringify(rows) + logs.join('\n');
    for (const secret of ['Hosted on', 'Lifecycle']) expect(text).not.toContain(secret);
  });

  it('refuses any element type’s standard name or key, Name, Type, reserved keys and __proto__', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const refused = async (body: object) => {
      const res = await call(target, 'POST', elementQuery(), cookie, {
        name: 'Fine name',
        key: 'fineKey',
        kind: 'text',
        ...body,
      });
      expect(res.statusCode).toBe(422);
      return res.json<ElementPropertyRejected>().fields;
    };
    // Standard on some type only (Owning team, Sourcing, Kind): refused all the same.
    for (const name of ['Description', 'owning  team', 'Sourcing', 'KIND', 'Supplier HQ country']) {
      expect((await refused({ name }))[0]?.field).toBe('name');
    }
    expect(await refused({ name: 'Sourcing' })).toEqual([
      { field: 'name', message: '“Sourcing” is a standard property of an element type.' },
    ]);
    for (const name of ['Name', 'type', 'Referenced by']) {
      expect((await refused({ name }))[0]?.message).toMatch(/is used on the element form/);
    }
    for (const key of ['owningTeam', 'stakeholderKind', 'functions', 'description']) {
      expect(await refused({ key })).toEqual([
        { field: 'key', message: `“${key}” is the key of an element type's standard property.` },
      ]);
    }
    expect(await refused({ key: '__proto__' })).toEqual([
      {
        field: 'key',
        message: "“__proto__” is reserved and can't be a property name. Use another name.",
      },
    ]);
    for (const key of ['type', 'simplearchitecture:x']) {
      expect(await refused({ key })).toEqual([
        { field: 'key', message: 'This key is reserved. Use another one.' },
      ]);
    }
    expect(await refused({ key: 'COSTCENTRE' })).toEqual([
      { field: 'key', message: "There's already an element property with the key “costCentre”." },
    ]);
    expect(await refused({ kind: 'number' })).toEqual([
      { field: 'kind', message: 'Must be text, choice or reference.' },
    ]);
    const badList = await call(target, 'POST', '/api/properties?for=nodes', cookie, {
      name: 'X',
      key: 'x',
      kind: 'text',
    });
    expect(badList.statusCode).toBe(422);
  });

  it('changes kind freely, keeps the values, and a key only while no element holds it', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const before = await store.get(modelId);
    const toChoice = await call(target, 'PATCH', elementQuery('costCentre'), cookie, {
      version: 1,
      name: 'Cost centre',
      kind: 'choice',
      options: ['CC-1', 'CC-9'],
    });
    expect(toChoice.statusCode).toBe(200);
    expect(toChoice.json<ElementPropertyResult>().property).toEqual({
      key: 'costCentre',
      name: 'Cost centre',
      kind: 'choice',
      options: ['CC-1', 'CC-9'],
      fromModels: false,
      version: 2,
    });
    const toReference = await call(target, 'PATCH', elementQuery('costCentre'), cookie, {
      version: 2,
      kind: 'reference',
    });
    expect(toReference.json<ElementPropertyResult>().property).not.toHaveProperty('options');
    expect(await store.get(modelId)).toEqual(before);
    const inUse = await call(target, 'PATCH', elementQuery('costCentre'), cookie, {
      version: 3,
      key: 'centre',
    });
    expect(inUse.statusCode).toBe(422);
    expect(inUse.json<ElementPropertyRejected>().fields).toEqual([
      { field: 'key', message: "The key can't change: values use it now." },
    ]);
    await call(target, 'POST', elementQuery(), cookie, {
      name: 'Unused',
      key: 'unused',
      kind: 'text',
    });
    const renamed = await call(target, 'PATCH', elementQuery('unused'), cookie, {
      version: 1,
      key: 'spare',
    });
    expect(renamed.json<ElementPropertyResult>().property.key).toBe('spare');
  });
});

describe('element metadata takes defined keys only', () => {
  it('refuses a new key on an element from a Modeller and from an Admin, and stores nothing', async () => {
    for (const role of ['Modeller', 'Admin']) {
      const { target, cookie } = await signedInAs([role]);
      const before = await store.get(modelId);
      const changed = await call(target, 'PATCH', elementUrl('till'), cookie, {
        version: 1,
        metadata: { vendor: 'Made-up vendor' },
      });
      expect(changed.statusCode).toBe(422);
      expect(changed.json<ElementPropertyRejected>().fields).toEqual([
        {
          field: 'metadata.vendor',
          message: "“vendor” isn't a property here. An Admin can add it in Admin → Properties.",
        },
      ]);
      const added = await call(target, 'POST', `/api/models/${modelId}/elements`, cookie, {
        type: 'Other',
        name: 'Scale',
        metadata: { vendor: 'Made-up vendor' },
      });
      expect(added.statusCode).toBe(422);
      // Another type's standard property can't be added either.
      const standard = await call(target, 'PATCH', elementUrl('oven'), cookie, {
        version: 1,
        metadata: { sourcing: 'Buy' },
      });
      expect(standard.statusCode).toBe(422);
      expect(standard.json<ElementPropertyRejected>().fields).toEqual([
        {
          field: 'metadata.sourcing',
          message: "Sourcing isn't a property of the type Infrastructure.",
        },
      ]);
      expect(await store.get(modelId)).toEqual(before);
    }
  });

  it('checks each kind: text, a choice’s options, and a Reference', async () => {
    const properties = new PropertyService(db);
    await properties.create(
      { name: 'Stage', key: 'stage', kind: 'choice', options: ['Draft', 'Live'] },
      seeder,
      { for: 'element' },
    );
    const service = new ElementService(store);
    expect(
      await refusal(
        service.updateElement(
          modelId,
          'till',
          { version: 1, metadata: { stage: 'Gone', costCentre: ref('oven'), feeds: 'text' } },
          modeller,
        ),
      ),
    ).toEqual([
      { field: 'metadata.stage', message: 'Pick one of Draft, Live.' },
      { field: 'metadata.costCentre', message: 'Must be text.' },
      {
        field: 'metadata.feeds',
        message: `Must be a reference: {"${referenceKey}": [element ids]}.`,
      },
    ]);
    const set = await service.updateElement(
      modelId,
      'till',
      { version: 1, metadata: { stage: 'Live', costCentre: 'CC-3', feeds: ref('oven', 'baker') } },
      modeller,
    );
    expect(set.element.node.metadata).toMatchObject({
      stage: 'Live',
      costCentre: 'CC-3',
      feeds: ref('oven', 'baker'),
    });
    // A value outside the list, stored before the options changed, may be sent back as it is.
    await db.query(
      `update elements set metadata = metadata || '{"stage": "Old"}'::jsonb where id = 'baker'`,
    );
    const kept = await service.updateElement(
      modelId,
      'baker',
      { version: 1, name: 'Head baker', metadata: { stage: 'Old' } },
      modeller,
    );
    expect(kept.element.node.metadata?.stage).toBe('Old');
  });

  it('keeps standard properties the new type lacks as Was a property values, editable and removable', async () => {
    const service = new ElementService(store);
    const changed = await service.updateElement(
      modelId,
      'till',
      { version: 1, type: 'Other' },
      modeller,
    );
    expect(changed.element.node.metadata).toEqual({ type: 'Other', sourcing: 'Buy' });
    const edited = await service.updateElement(
      modelId,
      'till',
      { version: 2, metadata: { sourcing: 'Bought in' } },
      modeller,
    );
    expect(edited.element.node.metadata?.sourcing).toBe('Bought in');
    const removed = await service.updateElement(
      modelId,
      'till',
      { version: 3, metadata: { sourcing: null } },
      modeller,
    );
    expect(removed.element.node.metadata).toEqual({ type: 'Other' });
    // Back to a type with the property: a standard value again, checked as one.
    const stakeholder = await service.updateElement(
      modelId,
      'baker',
      { version: 1, type: 'Application' },
      modeller,
    );
    expect(stakeholder.element.node.metadata).toMatchObject({ sourcing: 'Build' });
  });
});

describe('import adds element properties', () => {
  it('adds new element keys as From models properties, a Reference when every value is one', async () => {
    const { target, cookie } = await signedInAs(['Admin']);
    const file = {
      graph: {
        label: 'Made-up kiosk',
        nodes: {
          stand: {
            label: 'Stand',
            metadata: { type: 'Other', costCentre: 'CC-5', opens: '07:00', next: ref('cart') },
          },
          cart: {
            label: 'Cart',
            metadata: { type: 'Other', opens: ref('stand'), next: ref('stand') },
          },
        },
      },
    };
    const res = await call(target, 'POST', '/api/models', cookie, file);
    expect(res.statusCode).toBe(201);
    const body = res.json<SaveModelResult>();
    // `costCentre` was defined already.
    expect(body.newElementProperties).toEqual([
      { key: 'next', name: 'next', kind: 'reference', values: 2 },
      { key: 'opens', name: 'opens', kind: 'text', values: 2 },
    ]);
    expect(body.newProperties).toBeUndefined();
    expect((await lists(target, cookie)).elementProperties).toEqual([
      fromModels('costCentre'),
      fromModels('feeds', 'reference'),
      fromModels('next', 'reference'),
      fromModels('opens'),
    ]);
    const again = await call(target, 'POST', '/api/models', cookie, file);
    expect(again.json<SaveModelResult>().newElementProperties).toBeUndefined();
    const rows = await db.query<{ details: object }>(
      "select details from audit where action = 'element-property-added' and user_id = $1",
      [user.oid],
    );
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('07:00');
  });
});

describe('deleting an element property', () => {
  it('removes its values from every element in every model, with versions and audit counts only', async () => {
    const millId = (await store.save(mill, seeder)).id;
    const versions = () => db.query<{ version: number }>('select version from models order by id');
    const before = await versions();
    const { target, cookie } = await signedInAs(['Admin']);
    const res = await call(target, 'DELETE', elementQuery('costCentre'), cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json<DeletedElementPropertyResult>()).toEqual({
      key: 'costCentre',
      values: 3,
      models: 2,
    });
    expect((await lists(target, cookie)).elementProperties.map((d) => d.key)).toEqual(['feeds']);
    for (const id of [modelId, millId]) {
      const document = await store.get(id);
      for (const node of Object.values(document?.graph.nodes ?? {})) {
        expect(node.metadata ?? {}).not.toHaveProperty('costCentre');
      }
      expect(validateJgf(document).valid).toBe(true);
    }
    expect((await versions()).map((row) => row.version)).toEqual(
      before.map((row) => row.version + 1),
    );
    expect(
      await db.query(
        "select id, version from elements where id in ('baker', 'oven', 'till', 'wheel', 'stone') order by id",
      ),
    ).toEqual([
      { id: 'baker', version: 2 },
      { id: 'oven', version: 2 },
      { id: 'stone', version: 1 },
      { id: 'till', version: 1 },
      { id: 'wheel', version: 2 },
    ]);
    const rows = await db.query<{ action: string; model_id: string | null; details: object }>(
      `select action, model_id::text, details from audit
       where action in ('element-property-values-deleted', 'element-property-deleted') order by id`,
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          action: 'element-property-values-deleted',
          model_id: modelId,
          details: { key: 'costCentre', elements: 2 },
        },
        {
          action: 'element-property-values-deleted',
          model_id: millId,
          details: { key: 'costCentre', elements: 1 },
        },
        {
          action: 'element-property-deleted',
          model_id: null,
          details: { key: 'costCentre', values: 3, models: 2 },
        },
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(JSON.stringify(rows)).not.toMatch(/CC-/);
    // A form opened before the delete gets the usual conflict, and the key is refused after.
    const stale = await call(target, 'PATCH', elementUrl('baker'), cookie, {
      version: 1,
      name: 'Late',
    });
    expect(stale.statusCode).toBe(409);
    const late = await call(target, 'PATCH', elementUrl('till'), cookie, {
      version: 1,
      metadata: { costCentre: 'CC-4' },
    });
    expect(late.statusCode).toBe(422);
  });

  it('leaves the relationship list and its values alone', async () => {
    const service = new PropertyService(db);
    await service.create({ name: 'Region', key: 'region', kind: 'text' }, seeder);
    await service.create({ name: 'Region', key: 'region', kind: 'text' }, seeder, {
      for: 'element',
    });
    await service.delete({ key: 'region', for: 'element' }, seeder);
    expect((await service.list()).map((d) => d.key)).toEqual(['region']);
    expect((await service.listElements()).map((d) => d.key)).toEqual(['costCentre', 'feeds']);
  });
});

describe('the MCP tools', () => {
  it('give an element’s defined properties by name under definedProperties, References with names', async () => {
    const properties = new PropertyService(db);
    await properties.update(
      { key: 'costCentre', for: 'element' },
      { version: 1, name: 'Cost centre' },
      seeder,
    );
    const mcp = new McpReadService(store, properties);
    const oven = await mcp.element(modelId, 'oven');
    expect(oven.definedProperties).toEqual({
      'Cost centre': 'CC-2',
      feeds: [{ id: 'till', name: 'Till' }],
    });
    // The values as stored stay in `properties`.
    expect(oven.properties).toMatchObject({ costCentre: 'CC-2', feeds: ref('till') });
    const found = await mcp.searchElements(modelId, { query: 'Baker' });
    expect(found.elements[0]?.definedProperties).toEqual({ 'Cost centre': 'CC-1' });
    const till = await mcp.element(modelId, 'till');
    expect(till).not.toHaveProperty('definedProperties');
  });
});

describe('Group by in views', () => {
  it('takes a Text or Choice element property, archimateType too, and never a Reference one', async () => {
    await db.query(
      `update elements set metadata = metadata || '{"archimateType": "Node"}'::jsonb where id = 'oven'`,
    );
    const properties = new PropertyService(db);
    const views = new ViewService(store, properties);
    const view = (name: string, groupBy: string) =>
      views.createView(modelId, { name, elementIds: ['oven'], groupBy }, modeller);
    expect((await view('By cost centre', 'costCentre')).view.groupBy).toBe('costCentre');
    await expect(view('By feeds', 'feeds')).rejects.toThrow();
    // Undefined, archimateType is no Group by; defined, it is.
    await expect(view('By ArchiMate type', 'archimateType')).rejects.toThrow();
    await properties.create(
      { name: 'ArchiMate type', key: 'archimateType', kind: 'text' },
      seeder,
      { for: 'element' },
    );
    expect((await view('By ArchiMate type', 'archimateType')).view.groupBy).toBe('archimateType');
  });
});

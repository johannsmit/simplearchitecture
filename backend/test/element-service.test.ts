import {
  keptAsCustomOnTypeChange,
  storedModelKey,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EditingUnavailableError,
  ElementConflictError,
  ElementNotFoundError,
  ElementRejectedError,
  ElementService,
} from '../src/editing/element-service.js';
import { validateJgf } from '../src/jgf/validate.js';
import { FileModelStore } from '../src/storage/file-model-store.js';
import { ModelTooLargeError, ModelUnreadableError } from '../src/storage/model-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { tempDataDir } from './helpers.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };
const other: ModelAuthor = { id: 'oid-made-up-other', name: 'Made-up Colleague' };

// Made up: a shop with a container (platform) holding two applications.
const shop: JgfDocument = {
  graph: {
    id: 'made-up-shop',
    label: 'Made-up shop',
    directed: true,
    nodes: {
      buyer: { label: 'Buyer', metadata: { type: 'Stakeholder' } },
      platform: { label: 'Platform', metadata: { type: 'Infrastructure' } },
      shop: {
        label: 'Shop',
        metadata: {
          type: 'Application',
          description: 'Sells things.',
          sourcing: 'Build',
          owningTeam: 'Team A',
          colour: 'teal',
        },
      },
      stock: { label: 'Stock', metadata: { type: 'Application' } },
    },
    edges: [
      {
        id: 'e1',
        source: 'buyer',
        target: 'shop',
        relation: 'Relation',
        metadata: { informationFlow: true },
      },
      { id: 'e2', source: 'platform', target: 'shop', relation: 'Contains' },
      { source: 'platform', target: 'stock', relation: 'Contains' },
      { id: 'e4', source: 'shop', target: 'stock', relation: 'Relation' },
    ],
  },
};

interface AuditRow {
  action: string;
  user_id: string;
  user_name: string;
  model_id: string;
  element_id: string;
  details: { fields: string[]; deletedRelationships?: number };
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetTestDb(db);
});

async function setup(options: { maxModelBytes?: number; model?: JgfDocument } = {}) {
  const { model = shop, ...storeOptions } = options;
  const store = await PostgresModelStore.open(db, {
    log: { warn: () => undefined },
    ...storeOptions,
  });
  const summary = await store.save(model, other);
  return { store, service: new ElementService(store), modelId: summary.id };
}

const audit = () =>
  db.query<AuditRow>(
    'select action, user_id, user_name, model_id, element_id, details from audit order by id',
  );

async function stored(store: PostgresModelStore, modelId: string): Promise<JgfDocument> {
  const document = await store.get(modelId);
  if (!document) throw new Error('model gone');
  return document;
}

async function rejection(promise: Promise<unknown>): Promise<ElementRejectedError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ElementRejectedError)) throw new Error(`not rejected: ${String(error)}`);
  return error;
}

describe('ElementService without a database', () => {
  it('is not editable, and every call says so', async () => {
    const store = await FileModelStore.open(tempDataDir(), { log: { warn: () => undefined } });
    const service = new ElementService(store);
    expect(service.editable).toBe(false);
    const id = '0b6f8d55-1c1e-4b7e-9a51-6c1c2f4f2d10';
    await expect(service.getElement(id, 'x')).rejects.toThrow(EditingUnavailableError);
    await expect(service.addElement(id, { type: 'Other', name: 'A' }, modeller)).rejects.toThrow(
      EditingUnavailableError,
    );
    await expect(service.updateElement(id, 'x', { version: 1 }, modeller)).rejects.toThrow(
      EditingUnavailableError,
    );
    await expect(service.deleteElement(id, 'x', { version: 1 }, modeller)).rejects.toThrow(
      EditingUnavailableError,
    );
  });
});

describe('ElementService on PostgreSQL: add', () => {
  it('adds an element last, with a server id and version 1, and one audit row', async () => {
    const { store, service, modelId } = await setup();
    expect(service.editable).toBe(true);
    const result = await service.addElement(
      modelId,
      {
        type: 'Application',
        name: '  Billing  ',
        description: 'Sends bills.',
        metadata: { sourcing: 'Buy', functions: ['Invoicing'], vendor: 'Made-up vendor' },
        // Keys the client can't choose are not accepted, so the id is always the server's.
      },
      modeller,
    );
    expect(result.element.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.element.version).toBe(1);
    expect(result.element.node).toEqual({
      label: 'Billing',
      metadata: {
        type: 'Application',
        description: 'Sends bills.',
        sourcing: 'Buy',
        functions: ['Invoicing'],
        vendor: 'Made-up vendor',
      },
    });
    const document = await stored(store, modelId);
    expect(Object.keys(document.graph.nodes ?? {}).at(-1)).toBe(result.element.id);
    expect(document.graph.nodes?.[result.element.id]).toEqual(result.element.node);
    expect(validateJgf(document).valid).toBe(true);
    // The summary counts follow, in the list and in the stored data.
    const [summary] = await store.list();
    expect(summary?.nodeCount).toBe(5);
    expect(document.graph.metadata?.[storedModelKey]).toMatchObject({ nodeCount: 5, edgeCount: 4 });
    expect(await audit()).toEqual([
      {
        action: 'element-added',
        user_id: modeller.id,
        user_name: modeller.name,
        model_id: modelId,
        element_id: result.element.id,
        details: {
          fields: [
            'name',
            'type',
            'description',
            'metadata.sourcing',
            'metadata.functions',
            'metadata.vendor',
          ],
        },
      },
    ]);
    const read = await service.getElement(modelId, result.element.id);
    expect(read.element).toEqual(result.element);
  });

  it.each([
    ['no name', { type: 'Other', name: '   ' }, 'name'],
    ['an unknown type', { type: 'Secret', name: 'A' }, 'type'],
    ['an unknown field', { type: 'Other', name: 'A', id: 'mine' }, 'id'],
    ['a long name', { type: 'Other', name: 'n'.repeat(201) }, 'name'],
    [
      'a long description',
      { type: 'Other', name: 'A', description: 'd'.repeat(10_001) },
      'description',
    ],
    [
      'a non-text custom value',
      { type: 'Other', name: 'A', metadata: { size: 3 } },
      'metadata.size',
    ],
    [
      'a long custom value',
      { type: 'Other', name: 'A', metadata: { note: 'v'.repeat(2001) } },
      'metadata.note',
    ],
    [
      'a long custom key',
      { type: 'Other', name: 'A', metadata: { ['k'.repeat(101)]: 'v' } },
      `metadata.${'k'.repeat(101)}`,
    ],
    [
      'the type as a custom key',
      { type: 'Other', name: 'A', metadata: { type: 'Business' } },
      'metadata.type',
    ],
    [
      'an internal key',
      { type: 'Other', name: 'A', metadata: { 'simplearchitecture:x': 'v' } },
      'metadata.simplearchitecture:x',
    ],
    [
      'the description in metadata',
      { type: 'Other', name: 'A', metadata: { description: 'D' } },
      'metadata.description',
    ],
    [
      'a list as a custom value',
      { type: 'Business', name: 'A', metadata: { functions: ['Pay'] } },
      'metadata.functions',
    ],
    [
      'a bad property value',
      { type: 'Application', name: 'A', metadata: { sourcing: 'Lease' } },
      'metadata.sourcing',
    ],
    [
      'text for a list property',
      { type: 'Application', name: 'A', metadata: { functions: 'Pay' } },
      'metadata.functions',
    ],
    [
      'a long property value',
      { type: 'Business', name: 'A', metadata: { owningTeam: 't'.repeat(2001) } },
      'metadata.owningTeam',
    ],
    [
      'too many custom entries',
      {
        type: 'Other',
        name: 'A',
        metadata: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 'v'])),
      },
      'metadata',
    ],
    ['not an object', 'just text', ''],
  ])('refuses %s with a field message and stores nothing', async (_name, input, field) => {
    const { store, service, modelId } = await setup();
    const before = await stored(store, modelId);
    const error = await rejection(service.addElement(modelId, input, modeller));
    expect(error.fields.map((issue) => issue.field)).toContain(field);
    for (const issue of error.fields) expect(issue.message).toMatch(/^[A-Z].*[.)]$/);
    expect(await stored(store, modelId)).toEqual(before);
    expect(await audit()).toEqual([]);
  });

  it('refuses a __proto__ key', async () => {
    const { service, modelId } = await setup();
    const input = JSON.parse('{"type":"Other","name":"A","metadata":{"__proto__":"x"}}') as unknown;
    const error = await rejection(service.addElement(modelId, input, modeller));
    expect(error.fields).toEqual([
      { field: 'metadata.__proto__', message: expect.any(String) as string },
    ]);
  });

  it('lets warnings through and returns them', async () => {
    const { service, modelId } = await setup();
    const result = await service.addElement(
      modelId,
      { type: 'Application', name: 'Mail', metadata: { supplierHqCountry: 'Atlantis' } },
      modeller,
    );
    expect(result.warnings.map((issue) => issue.code)).toEqual(['non-iso-country']);
  });

  it('says not found for an unknown model, and refuses a model too large to store', async () => {
    const { service } = await setup();
    await expect(
      service.addElement(
        '0b6f8d55-1c1e-4b7e-9a51-6c1c2f4f2d10',
        { type: 'Other', name: 'A' },
        modeller,
      ),
    ).rejects.toThrow(ElementNotFoundError);
    await expect(
      service.addElement('not-a-uuid', { type: 'Other', name: 'A' }, modeller),
    ).rejects.toThrow(ElementNotFoundError);
    await resetTestDb(db);
    const small = await setup({ maxModelBytes: JSON.stringify(shop).length + 400 });
    await expect(
      small.service.addElement(
        small.modelId,
        { type: 'Other', name: 'A', description: 'd'.repeat(900) },
        modeller,
      ),
    ).rejects.toThrow(ModelTooLargeError);
    expect(Object.keys((await stored(small.store, small.modelId)).graph.nodes ?? {})).toHaveLength(
      4,
    );
  });
});

describe('ElementService on PostgreSQL: update', () => {
  it('changes only what is sent, bumps the version and audits the field names', async () => {
    const { store, service, modelId } = await setup();
    const result = await service.updateElement(
      modelId,
      'shop',
      {
        version: 1,
        name: 'Web shop',
        description: null,
        metadata: {
          owningTeam: 'Team B',
          architectureState: 'Target',
          colour: null,
          region: 'North',
        },
      },
      modeller,
    );
    expect(result.element).toEqual({
      id: 'shop',
      version: 2,
      node: {
        label: 'Web shop',
        metadata: {
          type: 'Application',
          sourcing: 'Build',
          owningTeam: 'Team B',
          architectureState: 'Target',
          region: 'North',
        },
      },
    });
    const document = await stored(store, modelId);
    expect(document.graph.nodes?.shop).toEqual(result.element.node);
    expect(Object.keys(document.graph.nodes ?? {})).toEqual(['buyer', 'platform', 'shop', 'stock']);
    const rows = await audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'element-updated',
      element_id: 'shop',
      user_name: modeller.name,
    });
    expect(rows[0]?.details.fields).toEqual([
      'name',
      'description',
      'metadata.owningTeam',
      'metadata.architectureState',
      'metadata.colour',
      'metadata.region',
    ]);
    // No values in the audit row.
    expect(JSON.stringify(rows)).not.toContain('Team B');
  });

  it('saves one field on its own, as a catalog cell sends it', async () => {
    const { store, service, modelId } = await setup();
    const before = (await service.getElement(modelId, 'shop')).element.node;
    const team = await service.updateElement(
      modelId,
      'shop',
      { version: 1, metadata: { owningTeam: 'Team B' } },
      modeller,
    );
    expect(team.element.node).toEqual({
      ...before,
      metadata: { ...before.metadata, owningTeam: 'Team B' },
    });
    const named = await service.updateElement(
      modelId,
      'shop',
      { version: 2, name: 'Web shop' },
      modeller,
    );
    expect(named.element).toMatchObject({ version: 3, node: { label: 'Web shop' } });
    // A country outside ISO is a warning: stored, and returned for the cell to show.
    const country = await service.updateElement(
      modelId,
      'shop',
      { version: 3, metadata: { supplierHqCountry: 'Holland' } },
      modeller,
    );
    expect(country.element.version).toBe(4);
    expect(country.warnings.map((issue) => issue.field)).toEqual(['metadata.supplierHqCountry']);

    const unchanged = await stored(store, modelId);
    const error = await rejection(
      service.updateElement(
        modelId,
        'shop',
        { version: 4, metadata: { architectureState: 'Retired' } },
        modeller,
      ),
    );
    expect(error.fields).toEqual([
      {
        field: 'metadata.architectureState',
        message: expect.stringMatching(/^Must be one of Deprecate, Current, Target/) as string,
      },
    ]);
    const empty = await rejection(
      service.updateElement(modelId, 'shop', { version: 4, name: '  ' }, modeller),
    );
    expect(empty.fields).toEqual([{ field: 'name', message: 'Enter a name.' }]);
    expect(await stored(store, modelId)).toEqual(unchanged);
  });

  it('refuses a stale version with the current one, and stores nothing', async () => {
    const { store, service, modelId } = await setup();
    await service.updateElement(modelId, 'stock', { version: 1, name: 'Stock 2' }, modeller);
    const before = await stored(store, modelId);
    const error = await service
      .updateElement(modelId, 'stock', { version: 1, name: 'Mine' }, other)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ElementConflictError);
    expect((error as ElementConflictError).currentVersion).toBe(2);
    expect(await stored(store, modelId)).toEqual(before);
    expect(await audit()).toHaveLength(1);
  });

  it('lets one of two changes from the same version through', async () => {
    const { service, modelId } = await setup();
    const results = await Promise.allSettled([
      service.updateElement(modelId, 'stock', { version: 1, name: 'First' }, modeller),
      service.updateElement(modelId, 'stock', { version: 1, name: 'Second' }, other),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected');
    expect(failed?.reason).toBeInstanceOf(ElementConflictError);
    expect(await audit()).toHaveLength(1);
  });

  it('keeps standard values the new type lacks as custom metadata, and back again', async () => {
    const { service, modelId } = await setup();
    const { node } = (await service.getElement(modelId, 'shop')).element;
    expect(keptAsCustomOnTypeChange(node.metadata ?? {}, 'Application', 'Business')).toEqual([
      'sourcing',
    ]);
    const business = await service.updateElement(
      modelId,
      'shop',
      { version: 1, type: 'Business' },
      modeller,
    );
    expect(business.element.node.metadata).toEqual({ ...node.metadata, type: 'Business' });
    expect(business.warnings.map((issue) => `${issue.code} ${issue.field}`)).toEqual([
      'not-standard-for-type metadata.sourcing',
    ]);
    const back = await service.updateElement(
      modelId,
      'shop',
      { version: 2, type: 'Application' },
      modeller,
    );
    expect(back.element.node.metadata).toEqual(node.metadata);
    expect(back.warnings).toEqual([]);
  });

  it('refuses a type change that would give an error at the property', async () => {
    const { store, service, modelId } = await setup();
    await service.updateElement(
      modelId,
      'buyer',
      { version: 1, metadata: { sourcing: 'Lease' } },
      modeller,
    );
    const before = await stored(store, modelId);
    const error = await rejection(
      service.updateElement(modelId, 'buyer', { version: 2, type: 'Application' }, modeller),
    );
    expect(error.fields).toEqual([
      {
        field: 'metadata.sourcing',
        message: expect.stringMatching(/^Must be one of Build, Buy/) as string,
      },
    ]);
    expect(await stored(store, modelId)).toEqual(before);
  });

  it('needs a name after every change, even for an element imported without one', async () => {
    const model: JgfDocument = {
      graph: { nodes: { quiet: { metadata: { type: 'Other', note: 'Kept' } } } },
    };
    const { service, modelId } = await setup({ model });
    for (const input of [
      { version: 1, metadata: { note: 'Changed' } },
      { version: 1, name: '  ' },
    ]) {
      const error = await rejection(service.updateElement(modelId, 'quiet', input, modeller));
      expect(error.fields).toEqual([{ field: 'name', message: 'Enter a name.' }]);
    }
    const named = await service.updateElement(
      modelId,
      'quiet',
      { version: 1, name: 'Quiet' },
      modeller,
    );
    expect(named.element.node).toEqual({
      label: 'Quiet',
      metadata: { type: 'Other', note: 'Kept' },
    });
  });

  it('keeps custom lists, objects and long values exactly, also when sent back unchanged', async () => {
    const long = 'l'.repeat(3000);
    const metadata = {
      type: 'Business',
      tags: ['a', 'b'],
      contact: { team: 'Made-up team', on: [1, 2] },
      owningTeam: long,
    };
    const model: JgfDocument = { graph: { nodes: { rich: { label: 'n'.repeat(250), metadata } } } };
    const { store, service, modelId } = await setup({ model });
    const untouched = await service.updateElement(
      modelId,
      'rich',
      { version: 1, metadata: { extra: 'x' } },
      modeller,
    );
    expect(untouched.element.node.metadata).toEqual({ ...metadata, extra: 'x' });
    // The form sends everything back as it read it (but the type), with one change.
    const readBack = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'type'));
    const sentBack = await service.updateElement(
      modelId,
      'rich',
      { version: 2, name: 'n'.repeat(250), metadata: { ...readBack, extra: 'y' } },
      modeller,
    );
    expect(sentBack.element.node).toEqual({
      label: 'n'.repeat(250),
      metadata: { ...metadata, extra: 'y' },
    });
    expect((await stored(store, modelId)).graph.nodes?.rich).toEqual(sentBack.element.node);
    const changedList = await rejection(
      service.updateElement(modelId, 'rich', { version: 3, metadata: { tags: ['c'] } }, modeller),
    );
    expect(changedList.fields).toEqual([{ field: 'metadata.tags', message: 'Must be text.' }]);
  });

  it('stores and audits nothing when nothing changes', async () => {
    const { service, modelId } = await setup();
    const result = await service.updateElement(
      modelId,
      'shop',
      { version: 1, name: 'Shop', metadata: { colour: 'teal', gone: null } },
      modeller,
    );
    expect(result.element.version).toBe(1);
    expect(await audit()).toEqual([]);
  });

  it('says not found for an unknown element or model, and refuses a bad version', async () => {
    const { service, modelId } = await setup();
    await expect(service.updateElement(modelId, 'nope', { version: 1 }, modeller)).rejects.toThrow(
      ElementNotFoundError,
    );
    await expect(
      service.updateElement(
        '0b6f8d55-1c1e-4b7e-9a51-6c1c2f4f2d10',
        'shop',
        { version: 1 },
        modeller,
      ),
    ).rejects.toThrow(ElementNotFoundError);
    const error = await rejection(service.updateElement(modelId, 'shop', { name: 'X' }, modeller));
    expect(error.fields.map((issue) => issue.field)).toEqual(['version']);
    const removeType = await rejection(
      service.updateElement(modelId, 'shop', { version: 1, metadata: { type: null } }, modeller),
    );
    expect(removeType.fields.map((issue) => issue.field)).toEqual(['metadata.type']);
  });
});

describe('ElementService on PostgreSQL: delete', () => {
  it('deletes a container with its relationships; the contained elements stay, un-nested', async () => {
    const { store, service, modelId } = await setup();
    const result = await service.deleteElement(modelId, 'platform', { version: '1' }, modeller);
    expect(result).toEqual({
      id: 'platform',
      deletedRelationshipCount: 2,
      deletedRelationshipIds: ['e2'],
      unnestedElementIds: ['shop', 'stock'],
    });
    const document = await stored(store, modelId);
    expect(Object.keys(document.graph.nodes ?? {})).toEqual(['buyer', 'shop', 'stock']);
    expect(document.graph.edges?.map((edge) => edge.id)).toEqual(['e1', 'e4']);
    expect(validateJgf(document).valid).toBe(true);
    const [summary] = await store.list();
    expect(summary).toMatchObject({ nodeCount: 3, edgeCount: 2 });
    expect(await audit()).toEqual([
      expect.objectContaining({
        action: 'element-deleted',
        element_id: 'platform',
        details: { fields: [], deletedRelationships: 2 },
      }),
    ]);
    await expect(service.getElement(modelId, 'platform')).rejects.toThrow(ElementNotFoundError);
  });

  it('refuses a stale or missing version and stores nothing', async () => {
    const { store, service, modelId } = await setup();
    await service.updateElement(modelId, 'buyer', { version: 1, name: 'Customer' }, modeller);
    const before = await stored(store, modelId);
    await expect(service.deleteElement(modelId, 'buyer', { version: '1' }, other)).rejects.toThrow(
      ElementConflictError,
    );
    for (const query of [{}, { version: 'two' }, { version: '2', extra: '1' }]) {
      await rejection(service.deleteElement(modelId, 'buyer', query, other));
    }
    expect(await stored(store, modelId)).toEqual(before);
    expect(await audit()).toHaveLength(1);
  });

  it('adds after a delete without reusing a place in the order', async () => {
    const { store, service, modelId } = await setup();
    await service.deleteElement(modelId, 'buyer', { version: 1 }, modeller);
    const added = await service.addElement(modelId, { type: 'Other', name: 'Later' }, modeller);
    const document = await stored(store, modelId);
    expect(Object.keys(document.graph.nodes ?? {})).toEqual([
      'platform',
      'shop',
      'stock',
      added.element.id,
    ]);
  });
});

describe('ElementService on PostgreSQL: damaged models', () => {
  it('refuses to edit a damaged model and leaves it as it is', async () => {
    const { store, service, modelId } = await setup();
    await db.query(
      "update relationships set relation = 'Secret relation' where model_id = $1::uuid and ordinal = 0",
      [modelId],
    );
    await expect(
      service.updateElement(modelId, 'shop', { version: 1, name: 'X' }, modeller),
    ).rejects.toThrow(ModelUnreadableError);
    await expect(service.getElement(modelId, 'shop')).rejects.toThrow(ModelUnreadableError);
    // The damage was done behind the store's back (no new version), so a fresh store finds it.
    const fresh = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    expect(await fresh.listDamaged()).toEqual([modelId]);
    expect(await store.get(modelId).catch((error: unknown) => error)).toBeInstanceOf(
      ModelUnreadableError,
    );
    expect(await audit()).toEqual([]);
  });
});

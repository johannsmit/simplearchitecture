import {
  maxViewElements,
  maxViewNameLength,
  maxViewRelationships,
  maxViewsPerModel,
  viewConflictMessage,
  type JgfDocument,
  type JgfEdge,
  type JgfNode,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConflictError,
  EditingUnavailableError,
  NotFoundError,
  RejectedError,
} from '../src/editing/common.js';
import { ElementService } from '../src/editing/element-service.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { FileModelStore } from '../src/storage/file-model-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { ViewLimitError, ViewService } from '../src/views/view-service.js';
import { tempDataDir } from './helpers.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };
const other: ModelAuthor = { id: 'oid-made-up-other', name: 'Made-up Colleague' };
const quiet = { log: { warn: () => undefined } };

// Made up: a bakery with an oven inside a kitchen, an order app and a till.
const bakery: JgfDocument = {
  graph: {
    label: 'Made-up bakery',
    directed: true,
    nodes: {
      baker: { label: 'Baker', metadata: { type: 'Stakeholder' } },
      kitchen: { label: 'Kitchen', metadata: { type: 'Infrastructure' } },
      oven: { label: 'Oven', metadata: { type: 'Infrastructure' } },
      orders: { label: 'Orders', metadata: { type: 'Application' } },
      till: { label: 'Till', metadata: { type: 'Application' } },
    },
    edges: [
      { id: 'r1', source: 'baker', target: 'orders', relation: 'Relation' },
      { id: 'r2', source: 'kitchen', target: 'oven', relation: 'Contains' },
      { id: 'r3', source: 'orders', target: 'till', relation: 'Relation' },
      // No id: it can't be named, so it can't be in a view.
      { source: 'oven', target: 'till', relation: 'Relation' },
    ],
  },
};

interface AuditRow {
  action: string;
  user_id: string;
  user_name: string;
  model_id: string;
  view_id: string | null;
  element_id: string | null;
  relationship_id: string | null;
  details: { fields: string[]; elements?: number; relationships?: number };
}

let db: TestDb;
let store: PostgresModelStore;
let service: ViewService;
let modelId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetTestDb(db);
  store = await PostgresModelStore.open(db, quiet);
  service = new ViewService(store);
  modelId = (await store.save(bakery, modeller)).id;
});

/** The error a call is refused with. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  );
}

async function fieldsOf(promise: Promise<unknown>) {
  const error = await refusal(promise);
  expect(error).toBeInstanceOf(RejectedError);
  return (error as RejectedError).fields;
}

const audits = () =>
  db.query<AuditRow>(
    "select action, user_id, user_name, model_id, view_id, element_id, relationship_id, details from audit where action like 'view-%' order by id",
  );

const tableCount = async (table: string) => {
  const [row] = await db.query<{ count: number }>(`select count(*)::int as count from ${table}`);
  return row?.count;
};

describe('creating and reading views', () => {
  it('stores a named set of elements and relationships, read back in model order', async () => {
    const { view } = await service.createView(
      modelId,
      {
        name: '  Baking  ',
        elementIds: ['till', 'orders', 'baker', 'orders'],
        relationshipIds: ['r3', 'r1', 'r3'],
      },
      modeller,
    );
    expect(view).toMatchObject({
      name: 'Baking',
      version: 1,
      elementIds: ['baker', 'orders', 'till'],
      relationshipIds: ['r1', 'r3'],
      elementCount: 3,
      relationshipCount: 2,
      createdBy: modeller,
      updatedBy: modeller,
    });
    expect(view.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(view.createdAt).toISOString()).toBe(view.createdAt);
    expect(view.updatedAt).toBe(view.createdAt);

    expect((await service.getView(modelId, view.id)).view).toEqual(view);
    const { views } = await service.listViews(modelId);
    const summary: Partial<typeof view> = { ...view };
    delete summary.elementIds;
    delete summary.relationshipIds;
    delete summary.layout;
    expect(views).toEqual([summary]);
  });

  it('never changes the model', async () => {
    const before = await store.get(modelId);
    await service.createView(modelId, { name: 'All', elementIds: ['baker'] }, modeller);
    expect(await store.get(modelId)).toEqual(before);
    expect((await store.list())[0]).toMatchObject({ nodeCount: 5, edgeCount: 4 });
  });

  it('allows an empty view and leaves relationships out when none are sent', async () => {
    const empty = await service.createView(modelId, { name: 'Empty', elementIds: [] }, modeller);
    expect(empty.view).toMatchObject({ elementIds: [], relationshipIds: [], elementCount: 0 });
    const plain = await service.createView(
      modelId,
      { name: 'Plain', elementIds: ['baker', 'orders'] },
      modeller,
    );
    expect(plain.view.relationshipIds).toEqual([]);
  });

  it('lists views by name', async () => {
    for (const name of ['beta', 'Alpha', 'Gamma']) {
      await service.createView(modelId, { name, elementIds: [] }, modeller);
    }
    const names = (await service.listViews(modelId)).views.map((view) => view.name);
    expect(names).toEqual(['Alpha', 'beta', 'Gamma']);
  });

  it('refuses a name another view of the model has, ignoring case and spaces at the ends', async () => {
    await service.createView(modelId, { name: 'Baking', elementIds: [] }, modeller);
    for (const name of ['Baking', 'baking', '  BAKING ']) {
      const fields = await fieldsOf(
        service.createView(modelId, { name, elementIds: [] }, modeller),
      );
      expect(fields).toEqual([
        {
          field: 'name',
          message: 'This model already has a view called \u201cBaking\u201d. Choose another name.',
        },
      ]);
    }
    expect((await service.listViews(modelId)).views).toHaveLength(1);
    // Another model may use the name.
    const second = (await store.save(bakery, modeller)).id;
    await service.createView(second, { name: 'baking', elementIds: [] }, modeller);
  });
  it('keeps each model to its own views', async () => {
    const second = (await store.save(bakery, modeller)).id;
    const { view } = await service.createView(modelId, { name: 'Mine', elementIds: [] }, modeller);
    expect((await service.listViews(second)).views).toEqual([]);
    const missing = await refusal(service.getView(second, view.id));
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((missing as NotFoundError).what).toBe('view');
  });

  it('refuses to rename, change or delete a view through another model, and leaves it as it was', async () => {
    const second = (await store.save(bakery, modeller)).id;
    const { view } = await service.createView(
      modelId,
      { name: 'Mine', elementIds: ['baker', 'orders'], relationshipIds: ['r1'] },
      modeller,
    );
    for (const promise of [
      service.renameView(second, view.id, { version: 1, name: 'Taken over' }, other),
      service.replaceContents(second, view.id, { version: 1, elementIds: ['baker'] }, other),
      service.deleteView(second, view.id, { version: '1' }, other),
    ]) {
      const error = await refusal(promise);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).what).toBe('view');
    }
    const { view: after } = await service.getView(modelId, view.id);
    expect(after).toMatchObject({
      name: 'Mine',
      version: 1,
      elementIds: ['baker', 'orders'],
      relationshipIds: ['r1'],
    });
    expect((await audits()).map((row) => row.action)).toEqual(['view-added']);
  });

  it('says which is missing: the model or the view', async () => {
    const unknown = '0b6f8d55-1c1e-4b7e-9a51-6c1c2f4f2d10';
    for (const [promise, what] of [
      [service.listViews(unknown), 'model'],
      [service.getView(unknown, unknown), 'model'],
      [service.getView(modelId, unknown), 'view'],
      [service.getView(modelId, 'not-a-uuid'), 'view'],
      [service.createView(unknown, { name: 'X', elementIds: [] }, modeller), 'model'],
      [service.renameView(modelId, unknown, { version: 1, name: 'X' }, modeller), 'view'],
      [service.deleteView(modelId, 'not-a-uuid', { version: '1' }, modeller), 'view'],
    ] as const) {
      const error = await refusal(promise);
      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).what).toBe(what);
    }
  });
});

describe('validation', () => {
  it('refuses a missing, blank, too long or unstorable name', async () => {
    for (const name of [undefined, '', '   ', 7, 'x'.repeat(maxViewNameLength + 1), 'a\u0000b']) {
      const fields = await fieldsOf(
        service.createView(modelId, { name, elementIds: [] }, modeller),
      );
      expect(fields.map((issue) => issue.field)).toEqual(['name']);
    }
    const longest = 'x'.repeat(maxViewNameLength);
    const { view } = await service.createView(modelId, { name: longest, elementIds: [] }, modeller);
    expect(view.name).toBe(longest);
  });

  it('refuses unknown fields and ids that are not text', async () => {
    expect(
      await fieldsOf(
        service.createView(modelId, { name: 'X', elementIds: [], extra: 1 }, modeller),
      ),
    ).toEqual([{ field: 'extra', message: 'Is not a field of a view.' }]);
    expect(
      await fieldsOf(service.createView(modelId, { name: 'X', elementIds: [1, '', 2] }, modeller)),
    ).toEqual([{ field: 'elementIds', message: 'Must be a list of ids.' }]);
    expect(await fieldsOf(service.createView(modelId, { name: 'X' }, modeller))).toEqual([
      { field: 'elementIds', message: 'Must be a list of ids.' },
    ]);
    expect(await fieldsOf(service.createView(modelId, null, modeller))).toEqual([
      { field: '', message: 'Send the view as a JSON object.' },
    ]);
  });

  it('refuses ids that are not in the model, naming them', async () => {
    const fields = await fieldsOf(
      service.createView(
        modelId,
        { name: 'X', elementIds: ['baker', 'ghost', 'a\u0000b'], relationshipIds: ['r9'] },
        modeller,
      ),
    );
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({ field: 'elementIds' });
    expect(fields[0]?.message).toContain('"ghost"');
    expect(fields[1]).toMatchObject({ field: 'relationshipIds' });
    expect(fields[1]?.message).toContain('"r9"');
    expect(await tableCount('views')).toBe(0);
  });

  it('refuses ids of another model', async () => {
    const otherModel: JgfDocument = {
      graph: {
        label: 'Made-up other',
        nodes: { elsewhere: { label: 'Elsewhere', metadata: { type: 'Other' } } },
        edges: [],
      },
    };
    await store.save(otherModel, modeller);
    const fields = await fieldsOf(
      service.createView(modelId, { name: 'X', elementIds: ['elsewhere'] }, modeller),
    );
    expect(fields[0]?.field).toBe('elementIds');
  });

  it('refuses a relationship without both of its elements, with a clear message', async () => {
    const fields = await fieldsOf(
      service.createView(
        modelId,
        { name: 'X', elementIds: ['baker'], relationshipIds: ['r1'] },
        modeller,
      ),
    );
    expect(fields).toEqual([
      {
        field: 'relationshipIds',
        message:
          'A relationship can be in a view only with both of its elements. Add them to the view, or leave out: "r1".',
      },
    ]);
  });

  it('shortens a long list of ids in a message', async () => {
    const ghosts = Array.from({ length: 8 }, (_, index) => `ghost-${index}`);
    const [issue] = await fieldsOf(
      service.createView(modelId, { name: 'X', elementIds: ghosts }, modeller),
    );
    expect(issue?.message).toContain('"ghost-4" and 3 more.');
    expect(issue?.message).not.toContain('ghost-5');
  });

  it('refuses more than the most elements or relationships a view holds', async () => {
    const elements = await fieldsOf(
      service.createView(
        modelId,
        { name: 'X', elementIds: Array.from({ length: maxViewElements + 1 }, () => 'baker') },
        modeller,
      ),
    );
    expect(elements).toEqual([
      { field: 'elementIds', message: `A view can hold at most ${maxViewElements} elements.` },
    ]);
    const relationships = await fieldsOf(
      service.createView(
        modelId,
        {
          name: 'X',
          elementIds: [],
          relationshipIds: Array.from({ length: maxViewRelationships + 1 }, () => 'r1'),
        },
        modeller,
      ),
    );
    expect(relationships[0]?.field).toBe('relationshipIds');
  });

  it('refuses a new view when the model has the most views it may', async () => {
    await db.query(
      `insert into views (id, model_id, name, created_at, created_by_id, created_by_name,
         updated_at, updated_by_id, updated_by_name)
       select gen_random_uuid(), $1::uuid, 'Made-up ' || n, now(), 'oid', 'Made-up', now(), 'oid',
         'Made-up'
       from generate_series(1, $2::int) as n`,
      [modelId, maxViewsPerModel],
    );
    const error = await refusal(
      service.createView(modelId, { name: 'One more', elementIds: [] }, modeller),
    );
    expect(error).toBeInstanceOf(ViewLimitError);
    expect((error as Error).message).toContain(String(maxViewsPerModel));
    expect(await tableCount('views')).toBe(maxViewsPerModel);
  });
});

describe('renaming, new contents and deleting', () => {
  const create = () =>
    service.createView(
      modelId,
      { name: 'Baking', elementIds: ['baker', 'orders', 'till'], relationshipIds: ['r1', 'r3'] },
      modeller,
    );

  it('renames, with the version as read', async () => {
    const { view } = await create();
    const renamed = await service.renameView(
      modelId,
      view.id,
      { version: 1, name: ' Selling ' },
      other,
    );
    expect(renamed.view).toMatchObject({
      name: 'Selling',
      version: 2,
      createdBy: modeller,
      updatedBy: other,
      elementCount: 3,
    });
    // The same name again changes nothing.
    const same = await service.renameView(modelId, view.id, { version: 2, name: 'Selling' }, other);
    expect(same.view.version).toBe(2);
  });

  it("refuses a rename to another view's name in any case, and allows its own in another case", async () => {
    const { view } = await create();
    await service.createView(modelId, { name: 'Selling', elementIds: [] }, modeller);
    const fields = await fieldsOf(
      service.renameView(modelId, view.id, { version: 1, name: 'SELLING' }, modeller),
    );
    expect(fields).toEqual([
      {
        field: 'name',
        message: 'This model already has a view called \u201cSelling\u201d. Choose another name.',
      },
    ]);
    const renamed = await service.renameView(
      modelId,
      view.id,
      { version: 1, name: 'BAKING' },
      modeller,
    );
    expect(renamed.view).toMatchObject({ name: 'BAKING', version: 2 });
  });

  it('refuses an older version with the current one, and stores nothing', async () => {
    const { view } = await create();
    await service.renameView(modelId, view.id, { version: 1, name: 'Second' }, other);
    for (const promise of [
      service.renameView(modelId, view.id, { version: 1, name: 'Third' }, modeller),
      service.replaceContents(modelId, view.id, { version: 1, elementIds: [] }, modeller),
      service.deleteView(modelId, view.id, { version: '1' }, modeller),
    ]) {
      const error = await refusal(promise);
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).currentVersion).toBe(2);
      expect((error as Error).message).toBe(viewConflictMessage);
    }
    expect((await service.getView(modelId, view.id)).view).toMatchObject({
      name: 'Second',
      elementCount: 3,
    });
  });

  it('refuses a request without a version', async () => {
    const { view } = await create();
    expect(
      (await fieldsOf(service.renameView(modelId, view.id, { name: 'X' }, modeller)))[0]?.field,
    ).toBe('version');
    expect((await fieldsOf(service.deleteView(modelId, view.id, {}, modeller)))[0]?.field).toBe(
      'version',
    );
  });

  it('replaces the contents with exactly what is sent', async () => {
    const { view } = await create();
    const { view: changed } = await service.replaceContents(
      modelId,
      view.id,
      { version: 1, elementIds: ['kitchen', 'oven', 'baker'], relationshipIds: ['r2'] },
      other,
    );
    expect(changed).toMatchObject({
      version: 2,
      elementIds: ['baker', 'kitchen', 'oven'],
      relationshipIds: ['r2'],
      updatedBy: other,
      name: 'Baking',
    });
  });

  it('removes an element with its relationships when no relationships are sent', async () => {
    const { view } = await create();
    const { view: changed } = await service.replaceContents(
      modelId,
      view.id,
      { version: 1, elementIds: ['orders', 'till', 'kitchen'] },
      modeller,
    );
    // r1 needed the baker; r3 stays. Nothing new is added.
    expect(changed).toMatchObject({
      elementIds: ['kitchen', 'orders', 'till'],
      relationshipIds: ['r3'],
    });
  });

  it('refuses new contents with a relationship whose element is removed', async () => {
    const { view } = await create();
    const fields = await fieldsOf(
      service.replaceContents(
        modelId,
        view.id,
        { version: 1, elementIds: ['orders', 'till'], relationshipIds: ['r1', 'r3'] },
        modeller,
      ),
    );
    expect(fields[0]?.message).toContain('"r1"');
    expect((await service.getView(modelId, view.id)).view.version).toBe(1);
  });

  it('saves one card at a time, each with the version before', async () => {
    const { view } = await create();
    const steps: [string[], string[], string[]][] = [
      // Sent elements and relationships, then the relationships the view holds.
      [
        ['baker', 'orders', 'till', 'kitchen'],
        ['r1', 'r3'],
        ['r1', 'r3'],
      ],
      [
        ['baker', 'orders', 'till', 'kitchen', 'oven'],
        ['r1', 'r2', 'r3'],
        ['r1', 'r2', 'r3'],
      ],
      [
        ['orders', 'till', 'kitchen', 'oven'],
        ['r2', 'r3'],
        ['r2', 'r3'],
      ],
    ];
    let version = view.version;
    for (const [elementIds, relationshipIds, expected] of steps) {
      const { view: saved } = await service.replaceContents(
        modelId,
        view.id,
        { version, elementIds, relationshipIds },
        modeller,
      );
      expect(saved.version).toBe(version + 1);
      expect([...saved.elementIds].sort()).toEqual([...elementIds].sort());
      expect(saved.relationshipIds).toEqual(expected);
      version = saved.version;
    }
    expect(await tableCount('view_elements')).toBe(4);
    expect(await tableCount('view_relationships')).toBe(2);
  });

  it('changes nothing when the contents are the same', async () => {
    const { view } = await create();
    const same = await service.replaceContents(
      modelId,
      view.id,
      { version: 1, elementIds: ['till', 'baker', 'orders'], relationshipIds: ['r3', 'r1'] },
      modeller,
    );
    expect(same.view.version).toBe(1);
    expect((await audits()).map((row) => row.action)).toEqual(['view-added']);
  });

  it('deletes a view and leaves the model alone', async () => {
    const { view } = await create();
    const before = await store.get(modelId);
    expect(await service.deleteView(modelId, view.id, { version: '1' }, modeller)).toEqual({
      id: view.id,
    });
    expect(await tableCount('views')).toBe(0);
    expect(await tableCount('view_elements')).toBe(0);
    expect(await tableCount('view_relationships')).toBe(0);
    expect(await store.get(modelId)).toEqual(before);
    const error = await refusal(service.getView(modelId, view.id));
    expect((error as NotFoundError).what).toBe('view');
  });
});

describe('audit', () => {
  it('records who, the action, the ids and field names, never the name', async () => {
    const { view } = await service.createView(
      modelId,
      { name: 'Secret plans', elementIds: ['baker', 'orders'], relationshipIds: ['r1'] },
      modeller,
    );
    await service.renameView(modelId, view.id, { version: 1, name: 'Other plans' }, other);
    await service.replaceContents(modelId, view.id, { version: 2, elementIds: ['baker'] }, other);
    await service.deleteView(modelId, view.id, { version: 3 }, modeller);
    const rows = await audits();
    expect(
      rows.map(({ action, user_id, user_name, model_id, view_id, details }) => ({
        action,
        user_id,
        user_name,
        model_id,
        view_id,
        details,
      })),
    ).toEqual([
      {
        action: 'view-added',
        ...{ user_id: modeller.id, user_name: modeller.name, model_id: modelId, view_id: view.id },
        details: {
          fields: ['name', 'elementIds', 'relationshipIds'],
          elements: 2,
          relationships: 1,
        },
      },
      {
        action: 'view-renamed',
        ...{ user_id: other.id, user_name: other.name, model_id: modelId, view_id: view.id },
        details: { fields: ['name'] },
      },
      {
        action: 'view-changed',
        ...{ user_id: other.id, user_name: other.name, model_id: modelId, view_id: view.id },
        details: { fields: ['elementIds', 'relationshipIds'], elements: 1, relationships: 0 },
      },
      {
        action: 'view-deleted',
        ...{ user_id: modeller.id, user_name: modeller.name, model_id: modelId, view_id: view.id },
        details: { fields: [] },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('plans');
  });

  it('writes no audit row for a refused change', async () => {
    await refusal(service.createView(modelId, { name: 'X', elementIds: ['ghost'] }, modeller));
    expect(await audits()).toEqual([]);
  });
});

describe('deletes in the model keep views consistent', () => {
  const create = async (name = 'Everything') =>
    (
      await service.createView(
        modelId,
        {
          name,
          elementIds: ['baker', 'kitchen', 'oven', 'orders', 'till'],
          relationshipIds: ['r1', 'r2', 'r3'],
        },
        modeller,
      )
    ).view;

  it('removes a deleted element and its relationships from every view, silently', async () => {
    const first = await create();
    const second = await create('Everything again');
    const elements = new ElementService(store);
    await elements.deleteElement(modelId, 'orders', { version: '1' }, modeller);
    for (const view of [first, second]) {
      expect((await service.getView(modelId, view.id)).view).toMatchObject({
        version: 1,
        elementIds: ['baker', 'kitchen', 'oven', 'till'],
        relationshipIds: ['r2'],
        elementCount: 4,
        relationshipCount: 1,
      });
    }
  });

  it('removes a deleted relationship from every view and keeps its elements', async () => {
    const view = await create();
    const relationships = new RelationshipService(store);
    await relationships.deleteRelationship(modelId, 'r3', { version: '1' }, modeller);
    expect((await service.getView(modelId, view.id)).view).toMatchObject({
      elementIds: ['baker', 'kitchen', 'oven', 'orders', 'till'],
      relationshipIds: ['r1', 'r2'],
    });
    expect((await service.listViews(modelId)).views[0]?.relationshipCount).toBe(2);
  });

  it('keeps a relationship that is changed or reversed', async () => {
    const view = await create();
    const relationships = new RelationshipService(store);
    await relationships.updateRelationship(
      modelId,
      'r1',
      { version: 1, reverse: true, label: 'Takes' },
      modeller,
    );
    expect((await service.getView(modelId, view.id)).view.relationshipIds).toEqual([
      'r1',
      'r2',
      'r3',
    ]);
  });

  it('never puts a new relationship in a view in the place of a deleted one', async () => {
    // Deleting the till takes the last two relationships, so the next one added gets the
    // position r3 had.
    const view = await create();
    await new ElementService(store).deleteElement(modelId, 'till', { version: '1' }, modeller);
    const [before] = await db.query<{ ordinal: number }>(
      'select coalesce(max(ordinal), -1) + 1 as ordinal from relationships where model_id = $1::uuid',
      [modelId],
    );
    expect(before?.ordinal).toBe(2);
    const added = await new RelationshipService(store).addRelationship(
      modelId,
      { source: 'orders', target: 'baker', type: 'Relation' },
      modeller,
    );
    const { view: after } = await service.getView(modelId, view.id);
    expect(after.relationshipIds).not.toContain(added.relationship.id);
    expect(after).toMatchObject({ relationshipIds: ['r1', 'r2'], relationshipCount: 2 });
  });

  it('deletes the views of a deleted model, and no one else', async () => {
    const view = await create();
    const second = (await store.save(bakery, modeller)).id;
    const kept = await service.createView(
      second,
      { name: 'Kept', elementIds: ['baker'] },
      modeller,
    );
    await store.delete(modelId);
    expect(await tableCount('views')).toBe(1);
    expect(await tableCount('view_elements')).toBe(1);
    expect(await tableCount('view_relationships')).toBe(0);
    const error = await refusal(service.getView(modelId, view.id));
    expect((error as NotFoundError).what).toBe('model');
    expect((await service.getView(second, kept.view.id)).view.elementIds).toEqual(['baker']);
  });

  it('can be saved again after its element was deleted, without it', async () => {
    const view = await create();
    await new ElementService(store).deleteElement(modelId, 'till', { version: '1' }, modeller);
    const { view: changed } = await service.replaceContents(
      modelId,
      view.id,
      { version: 1, elementIds: ['baker', 'orders'] },
      modeller,
    );
    expect(changed).toMatchObject({ elementIds: ['baker', 'orders'], relationshipIds: ['r1'] });
  });
});

describe('layouts', () => {
  const create = async () =>
    (
      await service.createView(
        modelId,
        {
          name: 'Baking',
          elementIds: ['baker', 'kitchen', 'oven', 'orders'],
          relationshipIds: ['r1', 'r2'],
        },
        modeller,
      )
    ).view;
  const layout = (version: number, cards: unknown) => ({ version, cards });

  it('starts with no layout, and stores where each card is, read back in model order', async () => {
    const view = await create();
    expect(view.layout).toEqual([]);
    const { view: laid } = await service.replaceLayout(
      modelId,
      view.id,
      layout(1, [
        { elementId: 'orders', x: 412.5, y: -36.25 },
        { elementId: 'baker', x: 0, y: 0, width: 240 },
        { elementId: 'oven', x: -1_000_000, y: 1_000_000, width: 168 },
      ]),
      other,
    );
    expect(laid).toMatchObject({
      version: 2,
      updatedBy: other,
      elementIds: ['baker', 'kitchen', 'oven', 'orders'],
      relationshipIds: ['r1', 'r2'],
      layout: [
        { elementId: 'baker', x: 0, y: 0, width: 240 },
        { elementId: 'oven', x: -1_000_000, y: 1_000_000, width: 168 },
        { elementId: 'orders', x: 412.5, y: -36.25 },
      ],
    });
    expect(laid.layout[2]).not.toHaveProperty('width');
    expect((await service.getView(modelId, view.id)).view).toEqual(laid);
  });

  it('keeps a position exactly as sent', async () => {
    const view = await create();
    const x = 0.1 + 0.2;
    const y = -123.456789012345;
    const { view: laid } = await service.replaceLayout(
      modelId,
      view.id,
      layout(1, [{ elementId: 'baker', x, y }]),
      modeller,
    );
    expect(laid.layout).toEqual([{ elementId: 'baker', x, y }]);
  });

  it('replaces the whole layout: a card not sent has no position afterwards', async () => {
    const view = await create();
    await service.replaceLayout(
      modelId,
      view.id,
      layout(1, [
        { elementId: 'baker', x: 1, y: 2 },
        { elementId: 'orders', x: 3, y: 4, width: 300 },
      ]),
      modeller,
    );
    const { view: laid } = await service.replaceLayout(
      modelId,
      view.id,
      layout(2, [{ elementId: 'orders', x: 5, y: 6 }]),
      modeller,
    );
    expect(laid).toMatchObject({ version: 3, layout: [{ elementId: 'orders', x: 5, y: 6 }] });
    const { view: cleared } = await service.replaceLayout(
      modelId,
      view.id,
      layout(3, []),
      modeller,
    );
    expect(cleared).toMatchObject({ version: 4, layout: [] });
  });

  it('changes nothing, and keeps the version, when the layout is the same', async () => {
    const view = await create();
    const cards = [
      { elementId: 'orders', x: 3, y: 4, width: 300 },
      { elementId: 'baker', x: 1, y: 2 },
    ];
    await service.replaceLayout(modelId, view.id, layout(1, cards), modeller);
    const before = await audits();
    const { view: same } = await service.replaceLayout(
      modelId,
      view.id,
      layout(2, [...cards].reverse()),
      other,
    );
    expect(same).toMatchObject({ version: 2, updatedBy: modeller });
    expect(await audits()).toEqual(before);
    const fresh = (await service.createView(modelId, { name: 'Empty', elementIds: [] }, modeller))
      .view;
    const { view: empty } = await service.replaceLayout(modelId, fresh.id, layout(1, []), other);
    expect(empty).toMatchObject({ version: 1, updatedBy: modeller });
  });

  it('keeps the layout when the contents change, and drops the position of a card taken out', async () => {
    const view = await create();
    await service.replaceLayout(
      modelId,
      view.id,
      layout(1, [
        { elementId: 'baker', x: 1, y: 2 },
        { elementId: 'orders', x: 3, y: 4, width: 200 },
      ]),
      modeller,
    );
    const { view: fewer } = await service.replaceContents(
      modelId,
      view.id,
      { version: 2, elementIds: ['kitchen', 'oven', 'orders', 'till'] },
      modeller,
    );
    expect(fewer.layout).toEqual([{ elementId: 'orders', x: 3, y: 4, width: 200 }]);
    const { view: back } = await service.replaceContents(
      modelId,
      view.id,
      { version: 3, elementIds: ['baker', 'kitchen', 'oven', 'orders', 'till'] },
      modeller,
    );
    expect(back.layout).toEqual([{ elementId: 'orders', x: 3, y: 4, width: 200 }]);
  });

  it('drops the position of an element deleted from the model', async () => {
    const view = await create();
    await service.replaceLayout(
      modelId,
      view.id,
      layout(1, [
        { elementId: 'baker', x: 1, y: 2 },
        { elementId: 'orders', x: 3, y: 4 },
      ]),
      modeller,
    );
    await new ElementService(store).deleteElement(modelId, 'orders', { version: '1' }, modeller);
    expect((await service.getView(modelId, view.id)).view.layout).toEqual([
      { elementId: 'baker', x: 1, y: 2 },
    ]);
  });

  it('refuses cards that are not in the view, or in it twice, naming them', async () => {
    const view = await create();
    const fields = await fieldsOf(
      service.replaceLayout(
        modelId,
        view.id,
        layout(1, [
          { elementId: 'baker', x: 1, y: 2 },
          { elementId: 'baker', x: 3, y: 4 },
          { elementId: 'till', x: 0, y: 0 },
          { elementId: 'ghost', x: 0, y: 0 },
        ]),
        modeller,
      ),
    );
    expect(fields).toEqual([
      { field: 'cards', message: expect.stringContaining('"baker"') as string },
      {
        field: 'cards',
        message: expect.stringMatching(/not in the view.*"till", "ghost"/) as string,
      },
    ]);
    expect((await service.getView(modelId, view.id)).view).toMatchObject({
      version: 1,
      layout: [],
    });
  });

  it('refuses a card of another model, through that model', async () => {
    const view = await create();
    const second = (await store.save(bakery, modeller)).id;
    const error = await refusal(
      service.replaceLayout(
        second,
        view.id,
        layout(1, [{ elementId: 'baker', x: 0, y: 0 }]),
        modeller,
      ),
    );
    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).what).toBe('view');
  });

  it('refuses positions and widths that are not finite numbers within bounds', async () => {
    const view = await create();
    for (const card of [
      { elementId: 'baker', x: 1_000_001, y: 0 },
      { elementId: 'baker', x: 0, y: -1_000_001 },
      { elementId: 'baker', x: Number.NaN, y: 0 },
      { elementId: 'baker', x: Number.POSITIVE_INFINITY, y: 0 },
      { elementId: 'baker', x: '12', y: 0 },
      { elementId: 'baker', x: 0 },
      { elementId: 'baker', x: 0, y: 0, width: 167 },
      { elementId: 'baker', x: 0, y: 0, width: 481 },
      { elementId: 'baker', x: 0, y: 0, width: 200.5 },
      { elementId: 'baker', x: 0, y: 0, width: null },
      { elementId: '', x: 0, y: 0 },
      { elementId: 7, x: 0, y: 0 },
      { elementId: 'baker', x: 0, y: 0, height: 80 },
      'baker',
    ]) {
      const fields = await fieldsOf(
        service.replaceLayout(modelId, view.id, layout(1, [card]), modeller),
      );
      expect(fields.map((issue) => issue.field)).toEqual(['cards']);
    }
    for (const body of [
      { version: 1 },
      { version: 1, cards: {} },
      { cards: [] },
      { version: 1, cards: [], extra: true },
      null,
    ]) {
      expect(await refusal(service.replaceLayout(modelId, view.id, body, modeller))).toBeInstanceOf(
        RejectedError,
      );
    }
    expect((await service.getView(modelId, view.id)).view).toMatchObject({
      version: 1,
      layout: [],
    });
  });

  it('refuses more cards than a view holds', async () => {
    const view = await create();
    const cards = Array.from({ length: maxViewElements + 1 }, (_, index) => ({
      elementId: `e${index}`,
      x: 0,
      y: 0,
    }));
    const fields = await fieldsOf(
      service.replaceLayout(modelId, view.id, layout(1, cards), modeller),
    );
    expect(fields).toEqual([
      { field: 'cards', message: expect.stringContaining(`${maxViewElements}`) as string },
    ]);
  });

  it('refuses an older version with the current one, and stores nothing', async () => {
    const view = await create();
    await service.renameView(modelId, view.id, { version: 1, name: 'Renamed' }, other);
    const error = await refusal(
      service.replaceLayout(
        modelId,
        view.id,
        layout(1, [{ elementId: 'baker', x: 0, y: 0 }]),
        modeller,
      ),
    );
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).currentVersion).toBe(2);
    expect((error as ConflictError).message).toBe(viewConflictMessage);
    expect((await service.getView(modelId, view.id)).view.layout).toEqual([]);
  });

  it('audits a new layout with its field name and count only, never a position', async () => {
    const view = await create();
    await service.replaceLayout(
      modelId,
      view.id,
      layout(1, [
        { elementId: 'baker', x: 17, y: 23, width: 211 },
        { elementId: 'oven', x: 5, y: 6 },
      ]),
      other,
    );
    const rows = await audits();
    expect(rows.at(-1)).toEqual({
      action: 'view-changed',
      user_id: other.id,
      user_name: other.name,
      model_id: modelId,
      view_id: view.id,
      element_id: null,
      relationship_id: null,
      details: { fields: ['layout'], cards: 2 },
    });
    expect(JSON.stringify(rows.at(-1)?.details)).not.toMatch(/17|23|211|baker|oven/);
  });
});

describe('without a database', () => {
  it('refuses every call: views need PostgreSQL', async () => {
    const files = await FileModelStore.open(tempDataDir(), quiet);
    const id = (await files.save(bakery, modeller)).id;
    const withoutDb = new ViewService(files);
    expect(withoutDb.available).toBe(false);
    for (const promise of [
      withoutDb.listViews(id),
      withoutDb.getView(id, id),
      withoutDb.createView(id, { name: 'X', elementIds: [] }, modeller),
      withoutDb.renameView(id, id, { version: 1, name: 'X' }, modeller),
      withoutDb.replaceContents(id, id, { version: 1, elementIds: [] }, modeller),
      withoutDb.replaceLayout(id, id, { version: 1, cards: [] }, modeller),
      withoutDb.deleteView(id, id, { version: '1' }, modeller),
    ]) {
      expect(await refusal(promise)).toBeInstanceOf(EditingUnavailableError);
    }
  });
});

describe('a large view', () => {
  it('holds the most elements and relationships a view may', async () => {
    const nodes: Record<string, JgfNode> = {};
    for (let index = 0; index < maxViewElements; index += 1) {
      nodes[`element-${index}`] = { label: `Made-up ${index}`, metadata: { type: 'Application' } };
    }
    const edges: JgfEdge[] = Array.from({ length: maxViewRelationships }, (_, index) => ({
      id: `relationship-${index}`,
      source: `element-${index % maxViewElements}`,
      target: `element-${(index * 7 + 1) % maxViewElements}`,
      relation: 'Relation',
    }));
    const large = (await store.save({ graph: { label: 'Made-up large', nodes, edges } }, modeller))
      .id;
    const elementIds = Object.keys(nodes);
    const relationshipIds = edges.map((edge) => edge.id ?? '');

    const { view } = await service.createView(
      large,
      { name: 'Everything', elementIds, relationshipIds },
      modeller,
    );
    expect(view).toMatchObject({
      elementCount: maxViewElements,
      relationshipCount: maxViewRelationships,
    });
    expect(view.elementIds).toEqual(elementIds);
    expect(view.relationshipIds).toEqual(relationshipIds);

    // Half the elements: the relationships that lose an end go with them.
    const half = elementIds.slice(0, maxViewElements / 2);
    const { view: changed } = await service.replaceContents(
      large,
      view.id,
      { version: 1, elementIds: half },
      modeller,
    );
    const inHalf = new Set(half);
    expect(changed.elementCount).toBe(half.length);
    expect(changed.relationshipIds).toEqual(
      edges
        .filter((edge) => inHalf.has(edge.source) && inHalf.has(edge.target))
        .map((edge) => edge.id),
    );
    expect((await service.listViews(large)).views[0]?.relationshipCount).toBe(
      changed.relationshipIds.length,
    );

    await store.delete(large);
    expect(await tableCount('view_elements')).toBe(0);
  }, 120_000);
});

import { PGlite } from '@electric-sql/pglite';
import {
  maxViewFolderLength,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { ViewService } from '../src/views/view-service.js';
import { pgliteDb, type TestDb } from './pglite.js';

// View folders come with migration 015, on a database that has run 001 to 014 with a made-up model
// and two views, one with a layout and a line route.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '015');
const through014 = all.filter((migration) => migration.version <= '014');
const quiet = { log: { warn: () => undefined } };

const model: JgfDocument = {
  graph: {
    label: 'Made-up dairy',
    nodes: {
      farmer: { label: 'Farmer', metadata: { type: 'Stakeholder' } },
      milking: { label: 'Milking', metadata: { type: 'Application' } },
      shed: { label: 'Shed', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      { id: 'd1', source: 'farmer', target: 'milking', relation: 'Relation' },
      { id: 'd2', source: 'milking', target: 'shed', relation: 'Relation' },
    ],
  },
};

let db: TestDb | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const milkingId = '6d3f8b2c-4e5a-4b7c-9d0e-1f2a3b4c5d6e';
const cleaningId = '7e4a9c3d-5f6b-4c8d-8e1f-2a3b4c5d6e7f';

/** A database at 014 with one model and two views, in SQL as an older app left them. */
async function at014(): Promise<{ db: TestDb; modelId: string }> {
  db = pgliteDb(new PGlite());
  await migrate(db, through014);
  const store = await PostgresModelStore.open(db, quiet);
  const modelId = (await store.save(model, author)).id;
  for (const [id, name, version] of [
    [milkingId, 'Milking', 3],
    [cleaningId, 'Cleaning', 1],
  ] as const) {
    await db.query(
      `insert into views (id, model_id, name, version, created_at, created_by_id, created_by_name,
         updated_at, updated_by_id, updated_by_name)
       values ($1::uuid, $2::uuid, $3, $4, now(), 'oid', 'Made-up', now(), 'oid', 'Made-up')`,
      [id, modelId, name, version],
    );
  }
  await db.query(
    `insert into view_elements (view_id, model_id, element_id, x, y)
     select $1::uuid, $2::uuid, id, ordinal * 300, 0 from elements where model_id = $2::uuid`,
    [milkingId, modelId],
  );
  await db.query(
    `insert into view_relationships (view_id, model_id, relationship_ordinal, route_x, route_y)
     select $1::uuid, $2::uuid, ordinal, '{168,300}', '{22,22}'
     from relationships where model_id = $2::uuid and ordinal = 0`,
    [milkingId, modelId],
  );
  return { db, modelId };
}

const dump = async (target: TestDb) => ({
  models: await target.query('select * from models order by id'),
  elements: await target.query('select * from elements order by model_id, ordinal'),
  relationships: await target.query('select * from relationships order by model_id, ordinal'),
  views: await target.query(
    `select id, model_id, name, version, created_at, created_by_id, created_by_name, updated_at,
       updated_by_id, updated_by_name from views order by id`,
  ),
  viewElements: await target.query('select * from view_elements order by view_id, element_id'),
  viewRelationships: await target.query(
    'select * from view_relationships order by view_id, relationship_ordinal',
  ),
  audit: await target.query('select id, action, user_id, model_id, details from audit order by id'),
});

const setFolder = (target: TestDb, folder: string | null) =>
  target.query('update views set folder = $2 where id = $1::uuid', [milkingId, folder]);

describe('migration 015', () => {
  it('leaves every model, view, layout, route and audit row as it was, with no view in a folder', async () => {
    const { db: target, modelId } = await at014();
    const before = await dump(target);
    await migrate(target, all);
    expect(await dump(target)).toEqual(before);
    expect(await target.query('select folder from views')).toEqual([
      { folder: null },
      { folder: null },
    ]);
    const service = new ViewService(await PostgresModelStore.open(target, quiet));
    const { views } = await service.listViews(modelId);
    expect(views.map((view) => [view.name, view.folder, view.version])).toEqual([
      ['Cleaning', null, 1],
      ['Milking', null, 3],
    ]);
    const { view } = await service.getView(modelId, milkingId);
    expect(view).toMatchObject({
      folder: null,
      version: 3,
      layout: [
        { elementId: 'farmer', x: 0, y: 0 },
        { elementId: 'milking', x: 300, y: 0 },
        { elementId: 'shed', x: 600, y: 0 },
      ],
      routes: [{ relationshipId: 'd1' }],
    });
  });

  it('holds the same length as the app', () => {
    const sql = all.find((each) => each.version === '015')?.sql ?? '';
    expect(sql).toContain(`char_length(folder) between 1 and ${maxViewFolderLength}`);
  });

  it('refuses an empty folder name, one too long, and one with a line break', async () => {
    const { db: target } = await at014();
    await migrate(target, all);
    await setFolder(target, 'f'.repeat(maxViewFolderLength));
    await setFolder(target, 'Morning milking');
    await setFolder(target, null);
    for (const folder of ['', 'f'.repeat(maxViewFolderLength + 1), 'Two\nlines', 'Two\rlines']) {
      await expect(setFolder(target, folder)).rejects.toThrow();
    }
    expect(await target.query('select folder from views where id = $1::uuid', [milkingId])).toEqual(
      [{ folder: null }],
    );
  });

  it("keeps a view's folder through its other changes, and drops it with the view", async () => {
    const { db: target, modelId } = await at014();
    await migrate(target, all);
    await setFolder(target, 'Mornings');
    const service = new ViewService(await PostgresModelStore.open(target, quiet));
    await service.renameView(modelId, milkingId, { version: 3, name: 'Milking at dawn' }, author);
    await service.replaceContents(
      modelId,
      milkingId,
      { version: 4, elementIds: ['farmer', 'milking'] },
      author,
    );
    const { view } = await service.getView(modelId, milkingId);
    expect(view).toMatchObject({ name: 'Milking at dawn', folder: 'Mornings', version: 5 });
    await service.deleteView(modelId, milkingId, { version: '5' }, author);
    expect(await target.query('select folder from views')).toEqual([{ folder: null }]);
  });
});

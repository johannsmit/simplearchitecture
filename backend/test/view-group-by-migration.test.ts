import { PGlite } from '@electric-sql/pglite';
import {
  maxGroupByKeyLength,
  maxViewGroupValueLength,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { ViewService } from '../src/views/view-service.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Group by in views comes with migration 019, on a database that has run 001 to 018 with a
// made-up model and a view with a layout.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '019');
const through018 = all.filter((migration) => migration.version <= '018');
const quiet = { log: { warn: () => undefined } };

const model: JgfDocument = {
  graph: {
    label: 'Made-up orchard',
    nodes: {
      picker: { label: 'Picker', metadata: { type: 'Stakeholder' } },
      scale: { label: 'Scale', metadata: { type: 'Application', owningTeam: 'Yard' } },
      store: { label: 'Cold store', metadata: { type: 'Infrastructure' } },
    },
    edges: [{ id: 'o1', source: 'picker', target: 'scale', relation: 'Relation' }],
  },
};

let db: TestDb | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const viewId = '4c1d2e3f-5a6b-4c7d-8e9f-a0b1c2d3e4f5';

/** A database at 018 with one model and one view, two of its cards placed, in SQL. */
async function at018(): Promise<{ db: TestDb; modelId: string }> {
  db = pgliteDb(new PGlite());
  await migrate(db, through018);
  const store = await PostgresModelStore.open(db, quiet);
  const modelId = (await store.save(model, author)).id;
  await db.query(
    `insert into views (id, model_id, name, version, created_at, created_by_id, created_by_name,
       updated_at, updated_by_id, updated_by_name)
     values ($1::uuid, $2::uuid, 'Harvest', 3, now(), 'oid', 'Made-up', now(), 'oid', 'Made-up')`,
    [viewId, modelId],
  );
  await db.query(
    `insert into view_elements (view_id, model_id, element_id, x, y)
     select $1::uuid, $2::uuid, id,
       case when ordinal < 2 then ordinal * 400 end, case when ordinal < 2 then 20 end
     from elements where model_id = $2::uuid`,
    [viewId, modelId],
  );
  return { db, modelId };
}

const dump = async (target: TestDb) => ({
  models: await target.query('select * from models order by id'),
  elements: await target.query('select * from elements order by model_id, ordinal'),
  views: await target.query(
    'select id, name, folder, version, created_at, updated_at from views order by id',
  ),
  viewElements: await target.query(
    'select view_id, element_id, x, y, width from view_elements order by view_id, element_id',
  ),
  audit: await target.query('select id, action, user_id, model_id, details from audit order by id'),
});

const setGroupBy = (target: TestDb, groupBy: unknown) =>
  target.query('update views set group_by = $2 where id = $1::uuid', [viewId, groupBy]);

const setGroup = (target: TestDb, element: string, group: unknown) =>
  target.query(
    'update view_elements set group_value = $3 where view_id = $1::uuid and element_id = $2',
    [viewId, element, group],
  );

describe('migration 019', () => {
  it('keeps every model, view, layout and audit row, with no Group by and no groups', async () => {
    const { db: target, modelId } = await at018();
    const before = await dump(target);
    await migrate(target, all);
    expect(await dump(target)).toEqual(before);
    expect(await target.query('select group_by from views')).toEqual([{ group_by: null }]);
    expect(await target.query('select group_value from view_elements order by element_id')).toEqual(
      [{ group_value: null }, { group_value: null }, { group_value: null }],
    );
    // Read by today's app, on today's schema: it opens as it did, ungrouped.
    await migrate(target, loadMigrations());
    const { view } = await new ViewService(await PostgresModelStore.open(target, quiet)).getView(
      modelId,
      viewId,
    );
    expect(view).toMatchObject({ version: 3, groupBy: null });
    expect(view.layout).toEqual([
      { elementId: 'picker', x: 0, y: 20 },
      { elementId: 'scale', x: 400, y: 20 },
    ]);
  });

  it('holds the same bounds as the app', () => {
    const sql = all.find((each) => each.version === '019')?.sql ?? '';
    expect(sql).toContain(`char_length(group_by) between 1 and ${maxGroupByKeyLength}`);
    expect(sql).toContain(`char_length(group_value) <= ${maxViewGroupValueLength}`);
  });

  it('refuses an empty or overlong Group by and __proto__, and a group without a position', async () => {
    const { db: target } = await at018();
    await migrate(target, all);
    for (const groupBy of ['type', 'owningTeam', 'k'.repeat(maxGroupByKeyLength), null]) {
      await setGroupBy(target, groupBy);
    }
    for (const groupBy of ['', 'k'.repeat(maxGroupByKeyLength + 1), '__proto__']) {
      await expect(setGroupBy(target, groupBy)).rejects.toThrow();
    }
    // '' is Not set; a value up to the cap.
    await setGroup(target, 'picker', '');
    await setGroup(target, 'scale', 'v'.repeat(maxViewGroupValueLength));
    await expect(
      setGroup(target, 'scale', 'v'.repeat(maxViewGroupValueLength + 1)),
    ).rejects.toThrow();
    // The cold store has no position, so it can't have a group.
    await expect(setGroup(target, 'store', 'Yard')).rejects.toThrow();
    // Clearing a card's position needs its group gone too.
    await expect(
      target.query(
        "update view_elements set x = null, y = null where view_id = $1::uuid and element_id = 'picker'",
        [viewId],
      ),
    ).rejects.toThrow();
  });
});

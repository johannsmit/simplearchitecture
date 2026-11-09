import { PGlite } from '@electric-sql/pglite';
import {
  maxViewCardCoordinate,
  maxViewCardWidth,
  minViewCardWidth,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { ViewService } from '../src/views/view-service.js';
import { pgliteDb, type TestDb } from './pglite.js';

// View layouts come with migration 011, on a database that has run 001 to 010 with made-up models
// and views.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '011');
const through010 = all.filter((migration) => migration.version <= '010');
const quiet = { log: { warn: () => undefined } };

const model: JgfDocument = {
  graph: {
    label: 'Made-up orchard',
    nodes: {
      picker: { label: 'Picker', metadata: { type: 'Stakeholder' } },
      crates: { label: 'Crates', metadata: { type: 'Application' } },
      barn: { label: 'Barn', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      { id: 'o1', source: 'picker', target: 'crates', relation: 'Relation' },
      { id: 'o2', source: 'crates', target: 'barn', relation: 'Relation' },
    ],
  },
};

let db: TestDb | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const viewId = '7a1e0c3d-2b4f-4c6a-9d8e-1f2a3b4c5d6e';

/** A database at 010 with one model and one view of all three elements, written in SQL. */
async function at010(): Promise<{ db: TestDb; modelId: string }> {
  db = pgliteDb(new PGlite());
  await migrate(db, through010);
  const store = await PostgresModelStore.open(db, quiet);
  const modelId = (await store.save(model, author)).id;
  await db.query(
    `insert into views (id, model_id, name, created_at, created_by_id, created_by_name,
       updated_at, updated_by_id, updated_by_name)
     values ($1::uuid, $2::uuid, 'Harvest', now(), 'oid', 'Made-up', now(), 'oid', 'Made-up')`,
    [viewId, modelId],
  );
  await db.query(
    `insert into view_elements (view_id, model_id, element_id)
     select $1::uuid, $2::uuid, id from elements where model_id = $2::uuid`,
    [viewId, modelId],
  );
  return { db, modelId };
}

const dump = async (target: TestDb) => ({
  models: await target.query('select * from models order by id'),
  elements: await target.query('select * from elements order by model_id, ordinal'),
  relationships: await target.query('select * from relationships order by model_id, ordinal'),
  views: await target.query('select * from views order by id'),
  viewElements: await target.query(
    'select view_id, model_id, element_id from view_elements order by view_id, element_id',
  ),
  viewRelationships: await target.query('select * from view_relationships order by view_id'),
  audit: await target.query('select id, action, user_id, model_id, details from audit order by id'),
});

describe('migration 011', () => {
  it('is the only one to run on a database at 010, and is plain ASCII', async () => {
    const { db: target } = await at010();
    const migration = all.find((each) => each.version === '011');
    expect(migration?.name).toBe('view_layouts');
    expect(migration?.sql).toMatch(/^[\t\n\x20-\x7e]*$/);
    expect(await migrate(target, all)).toBe(1);
    expect(await migrate(target, all)).toBe(0);
  });

  it('leaves every model, view and audit row as it was, with no card positioned', async () => {
    const { db: target, modelId } = await at010();
    const before = await dump(target);
    await migrate(target, all);
    expect(await dump(target)).toEqual(before);
    const { view } = await new ViewService(await PostgresModelStore.open(target, quiet)).getView(
      modelId,
      viewId,
    );
    expect(view).toMatchObject({
      version: 1,
      elementIds: ['picker', 'crates', 'barn'],
      layout: [],
    });
  });

  it('holds the same bounds as the app', async () => {
    const sql = all.find((each) => each.version === '011')?.sql ?? '';
    expect(sql).toContain(`width between ${minViewCardWidth} and ${maxViewCardWidth}`);
    expect(sql).toContain(
      `x between -${maxViewCardCoordinate} and ${maxViewCardCoordinate} and y between -${maxViewCardCoordinate} and ${maxViewCardCoordinate}`,
    );
  });

  it('refuses half a position, a width without one, and values out of bounds', async () => {
    const { db: target, modelId } = await at010();
    await migrate(target, all);
    const set = (x: unknown, y: unknown, width: unknown = null) =>
      target.query(
        `update view_elements set x = $3, y = $4, width = $5
         where view_id = $1::uuid and model_id = $2::uuid and element_id = 'picker'`,
        [viewId, modelId, x, y, width],
      );
    await set(-12.5, 40.25, 200);
    await set(0, 0);
    for (const [x, y, width] of [
      [10, null, null],
      [null, 10, null],
      [null, null, 200],
      [1_000_001, 0, null],
      [0, -1_000_001, null],
      ['NaN', 0, null],
      ['Infinity', 0, null],
      [0, 0, 167],
      [0, 0, 481],
    ]) {
      await expect(set(x, y, width)).rejects.toThrow();
    }
    const [row] = await target.query<{ x: number; y: number; width: number | null }>(
      "select x, y, width from view_elements where element_id = 'picker'",
    );
    expect(row).toEqual({ x: 0, y: 0, width: null });
  });

  it('drops a position with its card: out of the view, or its element deleted', async () => {
    const { db: target, modelId } = await at010();
    await migrate(target, all);
    await target.query(
      `update view_elements set x = 1, y = 2 where view_id = $1::uuid and model_id = $2::uuid`,
      [viewId, modelId],
    );
    await target.query("delete from elements where model_id = $1::uuid and id = 'barn'", [modelId]);
    await target.query("delete from view_elements where element_id = 'crates'");
    const rows = await target.query<{ element_id: string }>(
      'select element_id from view_elements where x is not null',
    );
    expect(rows).toEqual([{ element_id: 'picker' }]);
  });
});

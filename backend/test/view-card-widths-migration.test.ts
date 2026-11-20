import { PGlite } from '@electric-sql/pglite';
import {
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

// Wider cards come with migration 017, on a database that has run 001 to 016 with a made-up model
// and a view whose cards have widths set by hand.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '017');
const through016 = all.filter((migration) => migration.version <= '016');
const quiet = { log: { warn: () => undefined } };

const model: JgfDocument = {
  graph: {
    label: 'Made-up vineyard',
    nodes: {
      grower: { label: 'Grower', metadata: { type: 'Stakeholder' } },
      press: { label: 'Press', metadata: { type: 'Application' } },
      cellar: { label: 'Cellar', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      { id: 'v1', source: 'grower', target: 'press', relation: 'Relation' },
      { id: 'v2', source: 'press', target: 'cellar', relation: 'Relation' },
    ],
  },
};

let db: TestDb | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

const viewId = '8b2f1d4e-3c5a-4d7b-8e9f-0a1b2c3d4e5f';

/** A database at 016 with one model and one view, its cards 168, 300 and 480 wide, in SQL. */
async function at016(): Promise<{ db: TestDb; modelId: string }> {
  db = pgliteDb(new PGlite());
  await migrate(db, through016);
  const store = await PostgresModelStore.open(db, quiet);
  const modelId = (await store.save(model, author)).id;
  await db.query(
    `insert into views (id, model_id, name, version, created_at, created_by_id, created_by_name,
       updated_at, updated_by_id, updated_by_name)
     values ($1::uuid, $2::uuid, 'Harvest', 2, now(), 'oid', 'Made-up', now(), 'oid', 'Made-up')`,
    [viewId, modelId],
  );
  await db.query(
    `insert into view_elements (view_id, model_id, element_id, x, y, width)
     select $1::uuid, $2::uuid, id, ordinal * 600, 0,
       case ordinal when 0 then 168 when 1 then 300 else 480 end
     from elements where model_id = $2::uuid`,
    [viewId, modelId],
  );
  return { db, modelId };
}

const dump = async (target: TestDb) => ({
  models: await target.query('select * from models order by id'),
  elements: await target.query('select * from elements order by model_id, ordinal'),
  views: await target.query('select * from views order by id'),
  viewElements: await target.query('select * from view_elements order by view_id, element_id'),
  audit: await target.query('select id, action, user_id, model_id, details from audit order by id'),
});

const setWidth = (target: TestDb, width: unknown) =>
  target.query(
    `update view_elements set width = $2 where view_id = $1::uuid and element_id = 'press'`,
    [viewId, width],
  );

describe('migration 017', () => {
  it('keeps every model, view, width and audit row as it was', async () => {
    const { db: target, modelId } = await at016();
    const before = await dump(target);
    await migrate(target, all);
    expect(await dump(target)).toEqual(before);
    // Read by today's app, on today's schema.
    await migrate(target, loadMigrations());
    const { view } = await new ViewService(await PostgresModelStore.open(target, quiet)).getView(
      modelId,
      viewId,
    );
    expect(view).toMatchObject({
      version: 2,
      layout: [
        { elementId: 'grower', x: 0, y: 0, width: 168 },
        { elementId: 'press', x: 600, y: 0, width: 300 },
        { elementId: 'cellar', x: 1200, y: 0, width: 480 },
      ],
    });
  });

  it('holds the same bounds as the app', () => {
    const sql = all.find((each) => each.version === '017')?.sql ?? '';
    expect(maxViewCardWidth).toBe(20_000);
    expect(sql).toContain(`width between ${minViewCardWidth} and ${maxViewCardWidth}`);
  });

  it('takes widths from 168 to 20,000, and refuses one narrower or wider', async () => {
    const { db: target } = await at016();
    await migrate(target, all);
    for (const width of [168, 481, 1600, 20_000, null]) await setWidth(target, width);
    for (const width of [167, 20_001, -1]) {
      await expect(setWidth(target, width)).rejects.toThrow();
    }
    // A width still needs a position.
    await expect(
      target.query(
        `update view_elements set x = null, y = null, width = 400 where element_id = 'grower'`,
      ),
    ).rejects.toThrow();
    const rows = await target.query<{ width: number | null }>(
      "select width from view_elements where element_id = 'press'",
    );
    expect(rows).toEqual([{ width: null }]);
  });
});

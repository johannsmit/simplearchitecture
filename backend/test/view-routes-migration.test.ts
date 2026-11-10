import { PGlite } from '@electric-sql/pglite';
import {
  maxViewCardCoordinate,
  maxViewLineBends,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { ViewService } from '../src/views/view-service.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Line routes in views come with migration 014, on a database that has run 001 to 013 with a
// made-up model and a view with a stored layout.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '014');
const through013 = all.filter((migration) => migration.version <= '013');
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

const viewId = '5c2e7a1b-3d4f-4a6b-8c9d-0e1f2a3b4c5d';

/** A database at 013 with one model and one view of everything, its cards laid out, in SQL. */
async function at013(): Promise<{ db: TestDb; modelId: string }> {
  db = pgliteDb(new PGlite());
  await migrate(db, through013);
  const store = await PostgresModelStore.open(db, quiet);
  const modelId = (await store.save(model, author)).id;
  await db.query(
    `insert into views (id, model_id, name, created_at, created_by_id, created_by_name,
       updated_at, updated_by_id, updated_by_name)
     values ($1::uuid, $2::uuid, 'Harvest', now(), 'oid', 'Made-up', now(), 'oid', 'Made-up')`,
    [viewId, modelId],
  );
  await db.query(
    `insert into view_elements (view_id, model_id, element_id, x, y)
     select $1::uuid, $2::uuid, id, ordinal * 300, 0 from elements where model_id = $2::uuid`,
    [viewId, modelId],
  );
  await db.query(
    `insert into view_relationships (view_id, model_id, relationship_ordinal)
     select $1::uuid, $2::uuid, ordinal from relationships where model_id = $2::uuid`,
    [viewId, modelId],
  );
  return { db, modelId };
}

const dump = async (target: TestDb) => ({
  models: await target.query('select * from models order by id'),
  elements: await target.query('select * from elements order by model_id, ordinal'),
  relationships: await target.query('select * from relationships order by model_id, ordinal'),
  views: await target.query('select * from views order by id'),
  viewElements: await target.query('select * from view_elements order by view_id, element_id'),
  viewRelationships: await target.query(
    'select view_id, model_id, relationship_ordinal from view_relationships order by view_id, relationship_ordinal',
  ),
  audit: await target.query('select id, action, user_id, model_id, details from audit order by id'),
});

/** Sets the route of the line with this ordinal, as array literals (or null). */
const setRoute = (target: TestDb, ordinal: number, xs: string | null, ys: string | null) =>
  target.query(
    `update view_relationships set route_x = $2::double precision[], route_y = $3::double precision[]
     where view_id = $1::uuid and relationship_ordinal = $4`,
    [viewId, xs, ys, ordinal],
  );

describe('migration 014', () => {
  it('is the only one to run on a database at 013, and is plain ASCII', async () => {
    const { db: target } = await at013();
    const migration = all.find((each) => each.version === '014');
    expect(migration?.name).toBe('view_line_routes');
    expect(migration?.sql).toMatch(/^[\t\n\x20-\x7e]*$/);
    expect(await migrate(target, all)).toBe(1);
    expect(await migrate(target, all)).toBe(0);
  });

  it('leaves every model, view, layout and audit row as it was, with no line routed', async () => {
    const { db: target, modelId } = await at013();
    const before = await dump(target);
    await migrate(target, all);
    expect(await dump(target)).toEqual(before);
    const { view } = await new ViewService(await PostgresModelStore.open(target, quiet)).getView(
      modelId,
      viewId,
    );
    expect(view).toMatchObject({
      version: 1,
      relationshipIds: ['o1', 'o2'],
      layout: [
        { elementId: 'picker', x: 0, y: 0 },
        { elementId: 'crates', x: 300, y: 0 },
        { elementId: 'barn', x: 600, y: 0 },
      ],
      routes: [],
    });
  });

  it('holds the same bounds as the app', async () => {
    const sql = all.find((each) => each.version === '014')?.sql ?? '';
    expect(sql).toContain(`cardinality(route_x) between 2 and ${maxViewLineBends + 2}`);
    expect(sql).toContain(
      `-${maxViewCardCoordinate} <= all (route_x) and ${maxViewCardCoordinate} >= all (route_x)`,
    );
    expect(sql).toContain(
      `-${maxViewCardCoordinate} <= all (route_y) and ${maxViewCardCoordinate} >= all (route_y)`,
    );
  });

  it('refuses half a route, too few or too many points, gaps, and values out of bounds', async () => {
    const { db: target } = await at013();
    await migrate(target, all);
    const most = Array.from({ length: maxViewLineBends + 2 }, (_, index) => index).join(',');
    const tooMany = Array.from({ length: maxViewLineBends + 3 }, (_, index) => index).join(',');
    await setRoute(target, 0, '{168,250.5,250.5,300}', '{22,22,60,60}');
    await setRoute(target, 0, `{${most}}`, `{${most}}`);
    await setRoute(target, 0, null, null);
    for (const [xs, ys] of [
      ['{1,2}', null],
      [null, '{1,2}'],
      ['{1}', '{1}'],
      [`{${tooMany}}`, `{${tooMany}}`],
      ['{1,2,3}', '{1,2}'],
      ['{1,NULL}', '{1,2}'],
      ['{1,2}', '{NULL,2}'],
      ['{{1,2},{3,4}}', '{{1,2},{3,4}}'],
      ['{0,1000001}', '{0,0}'],
      ['{0,0}', '{-1000001,0}'],
      ['{0,NaN}', '{0,0}'],
      ['{0,0}', '{Infinity,0}'],
    ]) {
      await expect(setRoute(target, 0, xs ?? null, ys ?? null)).rejects.toThrow();
    }
    const [row] = await target.query<{ route_x: unknown; route_y: unknown }>(
      'select route_x, route_y from view_relationships where relationship_ordinal = 0',
    );
    expect(row).toEqual({ route_x: null, route_y: null });
  });

  it('drops a route with its line: out of the view, or its relationship deleted', async () => {
    const { db: target, modelId } = await at013();
    await migrate(target, all);
    await setRoute(target, 0, '{168,300}', '{22,22}');
    await setRoute(target, 1, '{468,600}', '{22,22}');
    await target.query("delete from relationships where model_id = $1::uuid and id = 'o1'", [
      modelId,
    ]);
    let rows = await target.query<{ relationship_ordinal: number }>(
      'select relationship_ordinal from view_relationships where route_x is not null',
    );
    expect(rows).toEqual([{ relationship_ordinal: 1 }]);
    await target.query('delete from view_relationships where relationship_ordinal = 1');
    rows = await target.query('select relationship_ordinal from view_relationships');
    expect(rows).toEqual([]);
  });
});

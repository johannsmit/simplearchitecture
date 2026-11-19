import { PGlite } from '@electric-sql/pglite';
import type { JgfDocument, ModelAuthor } from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { ViewService } from '../src/views/view-service.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Views on a database from before them (it had run 001 to 009), brought up to date. Made-up models.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations();
const through009 = all.filter((migration) => migration.version <= '009');
const quiet = { log: { warn: () => undefined } };

const model: JgfDocument = {
  graph: {
    label: 'Made-up harbour',
    nodes: {
      crane: { label: 'Crane', metadata: { type: 'Infrastructure' } },
      ledger: { label: 'Ledger', metadata: { type: 'Application' } },
      clerk: { label: 'Clerk', metadata: { type: 'Stakeholder' } },
    },
    edges: [
      { id: 'h1', source: 'clerk', target: 'ledger', relation: 'Relation', label: 'Books' },
      { id: 'h2', source: 'ledger', target: 'crane', relation: 'Relation' },
      { source: 'crane', target: 'ledger', relation: 'Relation' },
    ],
  },
};

let db: TestDb | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function at009(): Promise<{ db: TestDb; ids: string[] }> {
  db = pgliteDb(new PGlite());
  await migrate(db, through009);
  const store = await PostgresModelStore.open(db, quiet);
  const ids = [(await store.save(model, author)).id, (await store.save(model, author)).id];
  return { db, ids };
}

describe('views on an older database', () => {
  it('starts every model with no views, and views work on the migrated models', async () => {
    const { db: target, ids } = await at009();
    await migrate(target, all);
    const store = await PostgresModelStore.open(target, quiet);
    const service = new ViewService(store);
    const [first = '', second = ''] = ids;
    expect((await service.listViews(first)).views).toEqual([]);
    const { view } = await service.createView(
      first,
      { name: 'Booking', elementIds: ['clerk', 'ledger', 'crane'], relationshipIds: ['h1', 'h2'] },
      author,
    );
    expect(view).toMatchObject({
      elementIds: ['crane', 'ledger', 'clerk'],
      relationshipIds: ['h1', 'h2'],
    });
    await service.createView(second, { name: 'Other', elementIds: ['crane'] }, author);

    // The cascades, straight in SQL: a relationship, an element, then a model.
    await target.query("delete from relationships where model_id = $1::uuid and id = 'h2'", [
      first,
    ]);
    expect((await service.getView(first, view.id)).view.relationshipIds).toEqual(['h1']);
    await target.query("delete from elements where model_id = $1::uuid and id = 'clerk'", [first]);
    expect((await service.getView(first, view.id)).view.elementIds).toEqual(['crane', 'ledger']);
    await target.query('delete from models where id = $1::uuid', [first]);
    const [left] = await target.query<{ views: number; elements: number }>(
      `select (select count(*)::int from views) as views,
              (select count(*)::int from view_elements) as elements`,
    );
    expect(left).toEqual({ views: 1, elements: 1 });
  });

  it('refuses a view row that names another model, or an element not in its model', async () => {
    const { db: target, ids } = await at009();
    await migrate(target, all);
    const [first = '', second = ''] = ids;
    const viewId = '5d0c2a7e-7c55-4a1b-9a6e-0d4f3e2b1a10';
    await target.query(
      `insert into views (id, model_id, name, created_at, created_by_id, created_by_name,
         updated_at, updated_by_id, updated_by_name)
       values ($1::uuid, $2::uuid, 'Made-up', now(), 'oid', 'Made-up', now(), 'oid', 'Made-up')`,
      [viewId, first],
    );
    await expect(
      target.query(
        `insert into view_elements (view_id, model_id, element_id) values ($1::uuid, $2::uuid, 'crane')`,
        [viewId, second],
      ),
    ).rejects.toThrow();
    await expect(
      target.query(
        `insert into view_elements (view_id, model_id, element_id) values ($1::uuid, $2::uuid, 'ghost')`,
        [viewId, first],
      ),
    ).rejects.toThrow();
    await expect(
      target.query(
        `insert into view_relationships (view_id, model_id, relationship_ordinal)
         values ($1::uuid, $2::uuid, 99)`,
        [viewId, first],
      ),
    ).rejects.toThrow();
  });
});

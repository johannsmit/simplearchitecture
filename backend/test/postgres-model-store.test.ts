import type { ModelAuthor } from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { sampleModel } from '../src/jgf/sample.js';
import { ModelNotStorableError, ModelStoreFullError } from '../src/storage/model-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { describeModelStoreContract, model } from './model-store-contract.js';
import { createTestDb, pgliteDb, resetTestDb, type TestDb } from './pglite.js';
import { PGlite } from '@electric-sql/pglite';

const author: ModelAuthor = { id: 'oid-0002', name: 'Made-up Admin' };

// One in-process database for the whole file, emptied before each test.
let db: TestDb;
let warnings: { details: object; message: string }[] = [];

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await resetTestDb(db);
  warnings = [];
});

function open(options: { now?: () => number; maxModels?: number; maxBytes?: number } = {}) {
  return PostgresModelStore.open(db, {
    log: { warn: (details, message) => warnings.push({ details, message }) },
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxModels === undefined ? {} : { maxModels: options.maxModels }),
    ...(options.maxBytes === undefined ? {} : { maxModelBytes: options.maxBytes }),
  });
}

describeModelStoreContract('PostgresModelStore', () => ({
  open,
  damage: async (id) => {
    await db.query(
      "update relationships set relation = 'Secret relation' where model_id = $1::uuid and ordinal = 0",
      [id],
    );
  },
  warnings: () => warnings,
}));

describe('PostgresModelStore rows', () => {
  it('stores one row per element and relationship, with the type in its own column', async () => {
    const store = await open();
    const summary = await store.save(sampleModel, author);
    const elements = await db.query<{ id: string; type: string; ordinal: number }>(
      'select id, type, ordinal from elements where model_id = $1::uuid order by ordinal',
      [summary.id],
    );
    expect(elements.map((row) => row.id)).toEqual(Object.keys(sampleModel.graph.nodes ?? {}));
    expect(elements[0]?.type).toBe('Stakeholder');
    const [counted] = await db.query<{ count: number }>(
      'select count(*)::int as count from relationships where model_id = $1::uuid',
      [summary.id],
    );
    expect(counted?.count).toBe(sampleModel.graph.edges?.length);
  });

  it('replaces nothing on a failed save: a full store keeps no partial rows', async () => {
    const store = await open({ maxModels: 1 });
    await store.save(sampleModel, author);
    await expect(store.save(sampleModel, author)).rejects.toThrow(ModelStoreFullError);
    const [counted] = await db.query<{ count: number }>(
      'select count(*)::int as count from elements',
    );
    expect(counted?.count).toBe(Object.keys(sampleModel.graph.nodes ?? {}).length);
  });

  it.each([
    ['a NUL character', 'Made-up\u0000label'],
    ['half a surrogate pair', 'Made-up \uD83D label'],
  ])('refuses text with %s (PostgreSQL cannot store it), storing nothing', async (_name, text) => {
    const store = await open();
    const nodes = structuredClone(sampleModel.graph.nodes ?? {});
    const first = Object.values(nodes)[0];
    if (first) first.label = text;
    await expect(store.save({ graph: { ...sampleModel.graph, nodes } }, author)).rejects.toThrow(
      ModelNotStorableError,
    );
    await expect(
      store.save(model('x', { metadata: { [`key${text}`]: 1 } }), author),
    ).rejects.toThrow(ModelNotStorableError);
    expect(await store.list()).toEqual([]);
  });

  it('keeps a damaged model as it is: a later fix of the rule shows it again', async () => {
    const store = await open();
    const saved = await store.save(sampleModel, author);
    await db.query("update elements set type = 'Not a type' where model_id = $1::uuid", [saved.id]);
    expect(await (await open()).listDamaged()).toEqual([saved.id]);
    await db.query("update elements set type = 'Application' where model_id = $1::uuid", [
      saved.id,
    ]);
    expect((await (await open()).list()).map((summary) => summary.id)).toEqual([saved.id]);
  });
});

describe('migrations', () => {
  async function schema(target: TestDb): Promise<string> {
    const columns = await target.query(
      `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns where table_schema = 'public'
       order by table_name, column_name`,
    );
    const indexes = await target.query(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname",
    );
    return JSON.stringify({ columns, indexes });
  }

  it('creates the schema from the migrations alone, and re-running changes nothing', async () => {
    const fresh = pgliteDb(new PGlite());
    try {
      expect(await migrate(fresh, loadMigrations())).toBe(loadMigrations().length);
      const before = await schema(fresh);
      expect(await migrate(fresh, loadMigrations())).toBe(0);
      expect(await schema(fresh)).toBe(before);
      expect(before).toContain('relationships_model_source');
      expect(before).toContain('relationships_model_target');
      const applied = await fresh.query<{ version: string }>(
        'select version from schema_migrations order by version',
      );
      expect(applied.map((row) => row.version)).toEqual(loadMigrations().map((m) => m.version));
    } finally {
      await fresh.close();
    }
  });

  it('has indexes for loading a model, its neighbourhood and containment', async () => {
    const indexes = await db.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where schemaname = 'public'",
    );
    const defs = indexes.map((row) => row.indexdef).join('\n');
    expect(defs).toMatch(/ON public\.elements USING btree \(model_id, id\)/);
    expect(defs).toMatch(/ON public\.relationships USING btree \(model_id, source, relation\)/);
    expect(defs).toMatch(/ON public\.relationships USING btree \(model_id, target, relation\)/);
  });

  it('refuses a changed migration and one the API does not know', async () => {
    const [first, ...rest] = loadMigrations();
    if (!first) throw new Error('no migrations');
    await expect(migrate(db, [{ ...first, checksum: 'changed' }, ...rest])).rejects.toThrow(
      /Migration 001 was changed after it was applied/,
    );
    await expect(migrate(db, [])).rejects.toThrow(/doesn't know/);
  });

  it('runs only the missing ones: each on the database before it runs alone, once', async () => {
    const all = loadMigrations();
    const fresh = pgliteDb(new PGlite());
    try {
      for (let count = 1; count <= all.length; count += 1) {
        expect(await migrate(fresh, all.slice(0, count)), all[count - 1]?.name).toBe(1);
      }
      expect(await migrate(fresh, all)).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  // These have run on real databases: the API refuses to start if an applied migration changes, so
  // a change is caught here first. Add a migration's checksum once it has run on a live database.
  it('keeps the migrations that have run on live databases byte for byte', () => {
    expect(
      Object.fromEntries(
        loadMigrations()
          .filter((migration) => migration.version <= '010')
          .map((migration) => [migration.version, migration.checksum]),
      ),
    ).toEqual({
      '001': '884ce0e35691243ced77707d4f8123fa8339ec1254b103fa8a9b2e0627099bbf',
      '002': 'e819fde833f1a754ada6014d135e2451305a7c62b14309cd374e5b0063b1cfc8',
      '003': '238e13ee87fea6c3fffcc2d15256f493ade710d002fff1284ffe42b4109f38e0',
      '004': '792ec9ac2ccd20ee39e4a985ea9a2b22d7870cc01ec23aef4c5dbc9281492559',
      '005': '66a1fedabbb997ca83a4d788238445abc8184be214a3e75fa1aa229d27d36a54',
      '006': '385114328467c2e9f7fbeae0da3d626bb79b44ad2408a4977544463487df26a3',
      '007': '6cff1698afdaa979c5c096c3074c7afd57536d1a09b5be39369dd752958945df',
      '008': '8cc0418be59558762b22fc78392f910658f8364ab25a5b520c230985b77ff7cd',
      '009': '0cfe834707ec8d880b8d651a26fe31ba60bf307364b8d1e6f34e9b2c0d8bf03a',
      '010': '665de022cca5d739207dc7d7a94ec0c4a39b79d58a389a33f470c8119669d229',
    });
  });

  // From 010 on; 004 and 008 hold an arrow and have run, so they can't change.
  it('keeps every migration file from 010 on plain ASCII', () => {
    const later = loadMigrations().filter((migration) => migration.version >= '010');
    expect(later.length).toBeGreaterThan(0);
    for (const migration of later)
      expect(migration.sql, migration.name).toMatch(/^[\t\n\x20-\x7e]*$/);
  });

  it('rolls back every pending migration when a later one fails, and runs clean afterwards', async () => {
    const all = loadMigrations();
    const fresh = pgliteDb(new PGlite());
    try {
      await migrate(fresh, all.slice(0, 5));
      await fresh.query(
        `insert into models (id, name, created_at, created_by_id, created_by_name, node_count,
         edge_count, graph, metadata, has_nodes, has_edges)
       values ('11111111-1111-4111-8111-111111111111', 'Made-up', '2026-10-01', 'oid-1', 'Made-up',
         0, 0, '{}', '{}', false, false)`,
      );
      const failing = { version: '999', name: 'made_up_failure', sql: 'select 1/0', checksum: 'x' };
      await expect(migrate(fresh, [...all, failing])).rejects.toThrow();
      const applied = await fresh.query('select version from schema_migrations');
      expect(applied).toHaveLength(5);
      const [licence] = await fresh.query<{ present: boolean }>(
        "select to_regclass('licence') is not null as present",
      );
      expect(licence?.present).toBe(true);
      expect(await migrate(fresh, all)).toBe(all.length - 5);
      expect(await fresh.query('select id from models')).toHaveLength(1);
    } finally {
      await fresh.close();
    }
  });
});

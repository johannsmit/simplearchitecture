import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { JgfDocument, ModelAuthor } from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, MigrationError } from '../src/db/migrate.js';
import { sampleModel } from '../src/jgf/sample.js';
import { FileModelStore } from '../src/storage/file-model-store.js';
import { importFileModels } from '../src/storage/import-files.js';
import { ModelNotStorableError, ModelStoreFullError } from '../src/storage/model-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { describeModelStoreContract, model } from './model-store-contract.js';
import { createTestDb, pgliteDb, resetTestDb, type TestDb } from './pglite.js';
import { PGlite } from '@electric-sql/pglite';
import { tempDataDir } from './helpers.js';

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
    const [first] = loadMigrations();
    if (!first) throw new Error('no migrations');
    await expect(migrate(db, [{ ...first, checksum: 'changed' }])).rejects.toThrow(MigrationError);
    await expect(migrate(db, [])).rejects.toThrow(/doesn't know/);
  });
});

describe('moving the file store into PostgreSQL', () => {
  it('imports every valid model with its id and data, skips them next time, and keeps the files', async () => {
    const parent = tempDataDir();
    const dir = join(parent, 'models');
    try {
      let time = Date.UTC(2026, 5, 1);
      const files = await FileModelStore.open(dir, {
        log: { warn: () => undefined },
        now: () => (time += 1000),
      });
      const one = await files.save(sampleModel, author);
      const two = await files.save(model('Made-up second'), author);
      const store = await open();

      const counts = await importFileModels(files, store);
      expect(counts).toEqual({
        found: 2,
        imported: 2,
        skipped: 0,
        damaged: 0,
        failed: 0,
        elements: one.nodeCount + two.nodeCount,
        relationships: one.edgeCount + two.edgeCount,
      });
      expect(await store.list()).toEqual(await files.list());
      expect(await store.get(one.id)).toStrictEqual(await files.get(one.id));

      const again = await importFileModels(files, await open());
      expect(again).toMatchObject({ found: 2, imported: 0, skipped: 2, failed: 0 });
      expect(readdirSync(dir).sort()).toEqual([`${one.id}.json`, `${two.id}.json`].sort());
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('counts damaged files and models that do not fit, and imports the rest', async () => {
    const parent = tempDataDir();
    const dir = join(parent, 'models');
    try {
      const files = await FileModelStore.open(dir, { log: { warn: () => undefined } });
      await files.save(sampleModel, author);
      await files.save(model('Second'), author);
      const damaged: JgfDocument = { graph: { edges: 5 as unknown as [] } };
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, `${crypto.randomUUID()}.json`), JSON.stringify(damaged));

      const counts = await importFileModels(files, await open({ maxModels: 1 }));
      expect(counts).toMatchObject({ found: 3, imported: 1, damaged: 1, failed: 1 });
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

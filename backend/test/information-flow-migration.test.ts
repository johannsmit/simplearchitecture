import { PGlite } from '@electric-sql/pglite';
import type { JgfDocument, ModelAuthor } from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { convertOlderTypes } from '../src/jgf/older-types.js';
import { validateJgf } from '../src/jgf/validate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Information flow leaves the relationships: migration 009 on made-up data, and the same rule for
// files and imports.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '009');
const before = all.filter((migration) => migration.version < '009');
const quiet = { log: { warn: () => undefined } };

const nodes = {
  a: { label: 'A', metadata: { type: 'Application' } },
  b: { label: 'B', metadata: { type: 'Application' } },
  c: { label: 'C', metadata: { type: 'Infrastructure' } },
};
const edge = (id: string, fields: Record<string, unknown>) => ({
  id,
  source: 'a',
  target: 'b',
  relation: 'Relation',
  ...fields,
});
// Each case: the edge as stored before, and its metadata afterwards.
const cases: [Record<string, unknown>, unknown][] = [
  [
    edge('labelled-yes', {
      label: 'Orders',
      metadata: { informationFlow: true, architectureState: 'Target', zone: 'x' },
    }),
    { architectureState: 'Target', zone: 'x', data: 'Orders' },
  ],
  [edge('unlabelled-yes', { metadata: { informationFlow: true } }), {}],
  [edge('labelled-no', { label: 'Hosted on', metadata: { informationFlow: false } }), {}],
  [
    edge('has-data', { label: 'Feeds', metadata: { informationFlow: true, data: 'Existing' } }),
    { data: 'Existing' },
  ],
  [
    edge('contains', {
      source: 'c',
      target: 'a',
      relation: 'Contains',
      label: 'Holds',
      metadata: { informationFlow: true },
    }),
    {},
  ],
  [edge('blank-label', { label: '   ', metadata: { informationFlow: true } }), {}],
  [edge('odd-value', { label: 'Sends', metadata: { informationFlow: 'yes' } }), {}],
  [
    edge('two-way', { label: 'Syncs', directed: false, metadata: { informationFlow: true } }),
    {
      data: 'Syncs',
    },
  ],
  [edge('without', { label: 'Plain', metadata: { protocol: 'REST' } }), { protocol: 'REST' }],
  [edge('no-metadata', { label: 'Bare' }), null],
];
const document = (): JgfDocument =>
  ({
    graph: { label: 'Made-up', nodes, edges: cases.map(([stored]) => stored) },
  }) as unknown as JgfDocument;

interface Row {
  ordinal: number;
  id: string;
  source: string;
  target: string;
  relation: string;
  directed: boolean | null;
  label: string | null;
  metadata: Record<string, unknown> | null;
  extra: unknown;
  version: number;
}
const rowsOf = (db: TestDb, id: string) =>
  db.query<Row>(
    `select ordinal, id, source, target, relation, directed, label, metadata, extra, version
     from relationships where model_id = $1::uuid order by ordinal`,
    [id],
  );

describe('migration 009', () => {
  const opened: TestDb[] = [];

  /** A database at migration 008 holding the made-up model, as the previous API stored it. */
  const olderDatabase = async () => {
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, before);
    const store = await PostgresModelStore.open(db, quiet);
    const { id } = await store.save(document(), author);
    return { db, id };
  };

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('removes Information flow, setting Data from the label only where it was a yes on a Relation', async () => {
    const { db, id } = await olderDatabase();
    const was = await rowsOf(db, id);
    expect(was.filter((row) => row.metadata?.informationFlow !== undefined)).toHaveLength(8);

    expect(await migrate(db, all)).toBe(1);

    const now = await rowsOf(db, id);
    expect(now.map((row) => row.metadata)).toEqual(cases.map(([, after]) => after));
    // Nothing else changes: order, ids, ends, type, direction, label, extra fields and versions.
    const rest = (rows: Row[]) => rows.map((row) => ({ ...row, metadata: undefined }));
    expect(rest(now)).toEqual(rest(was));
  });

  it('leaves metadata of the wrong shape and other models alone, and runs once', async () => {
    const { db, id } = await olderDatabase();
    await db.query(
      `update relationships set metadata = '["informationFlow"]'::jsonb
       where model_id = $1::uuid and id = 'without'`,
      [id],
    );
    const [model] = await db.query<{ version: number }>(
      'select version from models where id = $1::uuid',
      [id],
    );
    expect(await migrate(db, all)).toBe(1);
    const [list] = (await rowsOf(db, id)).filter((row) => row.id === 'without');
    expect(list?.metadata).toEqual(['informationFlow']);
    expect(await db.query('select version from models where id = $1::uuid', [id])).toEqual([model]);
    expect(await migrate(db, all)).toBe(0);
  });

  it('leaves every stored model readable, with no damaged model', async () => {
    const { db, id } = await olderDatabase();
    await migrate(db, all);
    const store = await PostgresModelStore.open(db, quiet);
    expect(await store.listDamaged()).toEqual([]);
    const stored = await store.get(id);
    expect(stored).toBeDefined();
    const validation = validateJgf(stored);
    expect(validation.valid).toBe(true);
    expect(JSON.stringify(stored)).not.toContain('informationFlow');
  });
});

describe('older files and imports', () => {
  it('follow the same rule as the migration', () => {
    const { document: converted, converted: count } = convertOlderTypes(document());
    expect(count).toBe(8);
    const edges = (converted as JgfDocument).graph.edges ?? [];
    expect(edges.map((e) => e.metadata ?? null)).toEqual(cases.map(([, after]) => after));
    expect(edges.map((e) => e.label)).toEqual(cases.map(([stored]) => stored.label));
  });

  it('turn an older Information flow type into a Relation with its label as Data', () => {
    const older = {
      graph: {
        nodes,
        edges: [
          { id: 'f', source: 'a', target: 'b', relation: 'Information flow', label: 'Claims' },
          { id: 'g', source: 'a', target: 'b', relation: 'Information flow', metadata: { x: 1 } },
          { id: 'i', source: 'a', target: 'c', relation: 'Integration', label: 'API' },
        ],
      },
    };
    const edges = (convertOlderTypes(older).document as JgfDocument).graph.edges ?? [];
    expect(edges).toEqual([
      {
        id: 'f',
        source: 'a',
        target: 'b',
        relation: 'Relation',
        label: 'Claims',
        metadata: { data: 'Claims' },
      },
      { id: 'g', source: 'a', target: 'b', relation: 'Relation', metadata: { x: 1 } },
      { id: 'i', source: 'a', target: 'c', relation: 'Relation', label: 'API' },
    ]);
  });

  it('leave a document without Information flow as it is', () => {
    const plain = { graph: { nodes, edges: [cases[8]?.[0]] } };
    expect(convertOlderTypes(plain)).toEqual({ document: plain, converted: 0 });
  });
});

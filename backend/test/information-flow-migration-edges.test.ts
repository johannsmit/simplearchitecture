import { PGlite } from '@electric-sql/pglite';
import type { JgfDocument, ModelAuthor } from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { convertedEdge, convertedEdgeType } from '../src/jgf/older-types.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Migration 009 at its edges, on made-up data: rows of any shape the store can hold, and the same
// result as reading the row through the older-types conversion.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '009');
const before = all.filter((migration) => migration.version < '009');
const quiet = { log: { warn: () => undefined } };

const nodes = {
  a: { label: 'A', metadata: { type: 'Application', informationFlow: true } },
  b: { label: 'B', metadata: { type: 'Application' } },
};

interface Row {
  ordinal: number;
  id: string;
  relation: string | null;
  label: string | null;
  metadata: unknown;
}

describe('migration 009 at its edges', () => {
  const opened: TestDb[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  /** A database at migration 008 with a model of `count` plain edges, then rows set by hand. */
  const olderDatabase = async (count: number) => {
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, before);
    const store = await PostgresModelStore.open(db, quiet);
    const edges = Array.from({ length: count }, (_, index) => ({
      id: `e${String(index)}`,
      source: 'a',
      target: 'b',
      relation: 'Relation',
    }));
    const document = { graph: { label: 'Made-up', nodes, edges } } as unknown as JgfDocument;
    const { id } = await store.save(document, author);
    return { db, id };
  };

  const setRow = (
    db: TestDb,
    model: string,
    id: string,
    fields: { relation?: string | null; label?: string | null; metadata: string | null },
  ) =>
    db.query(
      `update relationships set relation = $3, label = $4, metadata = $5::jsonb
       where model_id = $1::uuid and id = $2`,
      [model, id, fields.relation ?? 'Relation', fields.label ?? null, fields.metadata],
    );

  const rowsOf = (db: TestDb, model: string) =>
    db.query<Row>(
      `select ordinal, id, relation, label, metadata from relationships
       where model_id = $1::uuid order by ordinal`,
      [model],
    );

  // [label, relation, metadata as stored]
  const shapes: [string | null, string | null, string | null][] = [
    ['Orders', 'Relation', '{"informationFlow": "true"}'],
    ['Orders', 'Relation', '{"informationFlow": 1}'],
    ['  Orders  ', 'Relation', '{"informationFlow": true}'],
    ['Orders', 'Relation', '{"informationFlow": true, "data": null}'],
    ['Orders', 'Relation', '{"informationFlow": true, "data": ""}'],
    ['Orders', 'Relation', 'null'],
    ['Orders', 'Relation', null],
    ['Orders', null, '{"informationFlow": true}'],
    ['Orders', 'Information flow', null],
    ['Orders', 'Contains', '{"informationFlow": true, "data": "Kept"}'],
    ['Orders', 'Relation', '{"informationFlow": {"nested": true}}'],
  ];

  it('gives the same result as reading the row through the older-types conversion', async () => {
    const { db, id } = await olderDatabase(shapes.length);
    for (const [index, [label, relation, metadata]] of shapes.entries()) {
      await setRow(db, id, `e${String(index)}`, { relation, label, metadata });
    }
    const was = await rowsOf(db, id);
    expect(await migrate(db, all)).toBe(1);
    const now = await rowsOf(db, id);

    const differences = was.flatMap((row, index) => {
      const edge: Record<string, unknown> = { id: row.id, source: 'a', target: 'b' };
      if (row.relation !== null) edge.relation = row.relation;
      if (row.label !== null) edge.label = row.label;
      if (row.metadata !== null) edge.metadata = row.metadata;
      const read = convertedEdge(edge) as Record<string, unknown>;
      // What reading the migrated row gives (the read conversion runs on it too).
      const after = now[index];
      const migrated: Record<string, unknown> = { id: row.id, source: 'a', target: 'b' };
      if (after?.relation !== null) migrated.relation = after?.relation;
      if (after?.label !== null) migrated.label = after?.label;
      if (after?.metadata !== null) migrated.metadata = after?.metadata;
      const readAfter = convertedEdge(migrated) as Record<string, unknown>;
      const same =
        JSON.stringify(read.metadata ?? null) === JSON.stringify(readAfter.metadata ?? null);
      if (same) return [];
      return [
        { label: row.label, stored: row.metadata, read: read.metadata, now: readAfter.metadata },
      ];
    });
    expect(differences).toEqual([]);
  });

  it('never sets Data from a label that is only white space', async () => {
    const { db, id } = await olderDatabase(3);
    await setRow(db, id, 'e0', { label: '\t', metadata: '{"informationFlow": true}' });
    await setRow(db, id, 'e1', { label: ' \n ', metadata: '{"informationFlow": true}' });
    await setRow(db, id, 'e2', { label: '\u00a0', metadata: '{"informationFlow": true}' });
    await migrate(db, all);
    expect((await rowsOf(db, id)).map((row) => row.metadata)).toEqual([{}, {}, {}]);
  });

  // Every character JavaScript's trim() removes, alone and all together.
  const trimmed = [
    ...['\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f'],
    ...['\u205f', '\u3000', '\ufeff'],
    ...Array.from({ length: 11 }, (_, index) => String.fromCharCode(0x2000 + index)),
  ];

  it('treats a label as blank exactly when trim() does', async () => {
    const labels = [...trimmed, trimmed.join(''), '\u00a0\u00a0', '\u200b', '\u0085', 'x'];
    const { db, id } = await olderDatabase(labels.length);
    for (const [index, label] of labels.entries()) {
      await setRow(db, id, `e${String(index)}`, { label, metadata: '{"informationFlow": true}' });
    }
    await migrate(db, all);
    const expected = labels.map((label) => (label.trim() === '' ? {} : { data: label }));
    expect((await rowsOf(db, id)).map((row) => row.metadata)).toEqual(expected);
  });

  it('copies a label with a real character among white space as is, untrimmed', async () => {
    const { db, id } = await olderDatabase(2);
    await setRow(db, id, 'e0', { label: '\tOrders\t', metadata: '{"informationFlow": true}' });
    await setRow(db, id, 'e1', { label: '\u00a0Orders\n', metadata: '{"informationFlow": true}' });
    await migrate(db, all);
    expect((await rowsOf(db, id)).map((row) => row.metadata)).toEqual([
      { data: '\tOrders\t' },
      { data: '\u00a0Orders\n' },
    ]);
    // The same as the read path's step for migration 009 gives for these labels.
    const read = ['\tOrders\t', '\u00a0Orders\n'].map(
      (label) =>
        (
          convertedEdgeType({
            id: 'x',
            source: 'a',
            target: 'b',
            relation: 'Relation',
            label,
            metadata: { informationFlow: true },
          }) as { metadata?: unknown }
        ).metadata,
    );
    expect(read).toEqual([{ data: '\tOrders\t' }, { data: '\u00a0Orders\n' }]);
  });

  it('leaves the string "true", other values and element metadata without Data', async () => {
    const { db, id } = await olderDatabase(2);
    await setRow(db, id, 'e0', { label: 'Orders', metadata: '{"informationFlow": "true"}' });
    await setRow(db, id, 'e1', { label: 'Orders', metadata: 'null' });
    await migrate(db, all);
    const rows = await rowsOf(db, id);
    expect(rows.map((row) => row.metadata)).toEqual([{}, null]);
    // On an element, informationFlow was always custom metadata: the migration leaves it.
    const [element] = await db.query<{ metadata: unknown }>(
      `select metadata from elements where model_id = $1::uuid and id = 'a'`,
      [id],
    );
    expect(element?.metadata).toEqual({ informationFlow: true });
  });

  it('converts a large model in one go', async () => {
    const count = 20_000;
    const { db, id } = await olderDatabase(count);
    await db.query(
      `update relationships set label = 'Flow ' || ordinal,
         metadata = '{"informationFlow": true, "architectureState": "Target"}'::jsonb
       where model_id = $1::uuid`,
      [id],
    );
    await migrate(db, all);
    const [counts] = await db.query<{ withData: number; withFlow: number }>(
      `select count(*) filter (where metadata ->> 'data' = label)::int as "withData",
              count(*) filter (where metadata ? 'informationFlow')::int as "withFlow"
       from relationships where model_id = $1::uuid`,
      [id],
    );
    expect(counts).toEqual({ withData: count, withFlow: 0 });
    const store = await PostgresModelStore.open(db, quiet);
    expect(await store.listDamaged()).toEqual([]);
    expect((await store.get(id))?.graph.edges).toHaveLength(count);
  }, 120_000);

  it('keeps a model readable whose custom metadata already used the new keys', async () => {
    const { db, id } = await olderDatabase(3);
    await setRow(db, id, 'e0', { label: 'Orders', metadata: '{"identity": 7, "data": ["x"]}' });
    await setRow(db, id, 'e1', {
      relation: 'Contains',
      metadata: '{"data": "Kept", "identityContext": {"a": 1}}',
    });
    await setRow(db, id, 'e2', {
      label: 'Orders',
      metadata: '{"informationFlow": true, "data": 5}',
    });
    await migrate(db, all);
    const store = await PostgresModelStore.open(db, quiet);
    expect(await store.listDamaged()).toEqual([]);
    expect((await store.list()).map((summary) => summary.id)).toEqual([id]);
    // Reading today also moves Data to Request Data (migration 012's rule).
    const edges = (await store.get(id))?.graph.edges ?? [];
    expect(edges.map((edge) => edge.metadata)).toEqual([
      { identity: 7, requestData: ['x'] },
      { requestData: 'Kept', identityContext: { a: 1 } },
      { requestData: 5 },
    ]);
  });
});

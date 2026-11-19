import { PGlite } from '@electric-sql/pglite';
import { buildModelGraph, type JgfDocument, type ModelAuthor } from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { withDirectionNamesInLabel } from '../src/jgf/older-types.js';
import { validateJgf } from '../src/jgf/validate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Upgrading a database whose relationships still hold Request Data and Response Data, in shapes an
// older API or a hand edit could have left, across two models. Made-up data.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '018');
const before = all.filter((migration) => migration.version < '018');
const quiet = { log: { warn: () => undefined } };

const nodes = {
  quay: { label: 'Quay', metadata: { type: 'Application' } },
  crane: { label: 'Crane', metadata: { type: 'Application' } },
  yard: { label: 'Yard', metadata: { type: 'Infrastructure' } },
};

// [id, relation, source, target, label as stored, metadata as stored, label after, metadata after]
type Case = [string, string, string, string, string | null, unknown, string | null, unknown];
const cases: Case[] = [
  [
    'contains-old',
    'Contains',
    'yard',
    'crane',
    'Holds {Request Data}',
    { requestData: ['Boxes'] },
    'Holds {Source to Target Data}',
    { sourceToTargetData: ['Boxes'] },
  ],
  [
    'list-of-objects',
    'Relation',
    'quay',
    'crane',
    null,
    [{ requestData: ['x'] }],
    null,
    [{ requestData: ['x'] }],
  ],
  [
    'nested',
    'Relation',
    'quay',
    'crane',
    null,
    { note: { requestData: ['x'] }, responseData: ['Moves'] },
    null,
    { note: { requestData: ['x'] }, targetToSourceData: ['Moves'] },
  ],
  [
    'single-text',
    'Relation',
    'quay',
    'crane',
    '{ response  data }',
    { responseData: 'Moves' },
    '{Target to Source Data}',
    { targetToSourceData: 'Moves' },
  ],
  [
    'both-pairs',
    'Relation',
    'crane',
    'quay',
    '{{Request Data}} {Request Data}',
    {
      requestData: ['Old out'],
      sourceToTargetData: ['New out'],
      responseData: ['Old back'],
      targetToSourceData: ['New back'],
    },
    '{{Request Data}} {Source to Target Data}',
    {
      requestData: ['Old out'],
      sourceToTargetData: ['New out'],
      responseData: ['Old back'],
      targetToSourceData: ['New back'],
    },
  ],
  [
    'label-only',
    'Relation',
    'quay',
    'crane',
    '{Data} {REQUEST DATA}{{ Response Data }}',
    null,
    '{Data} {Source to Target Data}{{ Response Data }}',
    null,
  ],
  [
    'two-way-null',
    'Relation',
    'quay',
    'crane',
    null,
    { requestData: null, protocol: 'AMQP' },
    null,
    { sourceToTargetData: null, protocol: 'AMQP' },
  ],
  ['text-metadata', 'Relation', 'quay', 'crane', null, 'requestData', null, 'requestData'],
];

describe('migration 018 on odd stored shapes', () => {
  const opened: TestDb[] = [];
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  const document = (label: string): JgfDocument => ({
    graph: {
      label,
      nodes,
      edges: cases.map(([id, relation, source, target]) => ({ id, source, target, relation })),
    },
  });

  async function olderDatabase() {
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, before);
    const store = await PostgresModelStore.open(db, quiet);
    const ids: string[] = [];
    for (const label of ['Made-up harbour', 'Made-up depot']) {
      const { id } = await store.save(document(label), author);
      ids.push(id);
      for (const [edgeId, , , , storedLabel, metadata] of cases) {
        await db.query(
          `update relationships set label = $3, metadata = $4::jsonb
           where model_id = $1::uuid and id = $2`,
          [id, edgeId, storedLabel, metadata === null ? null : JSON.stringify(metadata)],
        );
      }
    }
    return { db, ids };
  }

  it('renames the keys at the top of each relationship only, in every model', async () => {
    const { db, ids } = await olderDatabase();
    expect(await migrate(db, all)).toBe(1);
    for (const id of ids) {
      const rows = await db.query<{ id: string; label: string | null; metadata: unknown }>(
        'select id, label, metadata from relationships where model_id = $1::uuid order by ordinal',
        [id],
      );
      expect(rows.map((row) => [row.id, row.label, row.metadata])).toEqual(
        cases.map(([edgeId, , , , , , label, metadata]) => [edgeId, label, metadata]),
      );
    }
  });

  it('leaves every model readable, none damaged, with the lists read as lists', async () => {
    const { db, ids } = await olderDatabase();
    await migrate(db, all);
    // The odd metadata shapes are damage before and after: only those rows are put right here.
    for (const id of ids) {
      await db.query(
        `update relationships set metadata = null
         where model_id = $1::uuid and jsonb_typeof(metadata) <> 'object'`,
        [id],
      );
    }
    const store = await PostgresModelStore.open(db, quiet);
    expect(await store.listDamaged()).toEqual([]);
    for (const id of ids) {
      const stored = await store.get(id);
      expect(stored).toBeDefined();
      const validation = validateJgf(stored);
      expect(validation.valid).toBe(true);
      const graph = buildModelGraph(stored as JgfDocument);
      const byId = new Map(graph.relationships.map((r) => [r.id, r]));
      // A single text written by an older API reads as a list of that text.
      expect(byId.get('single-text')?.metadata.targetToSourceData).toEqual(['Moves']);
      expect(byId.get('contains-old')?.metadata.sourceToTargetData).toEqual(['Boxes']);
      expect(
        validation.warnings
          .filter((issue) => issue.code === 'older-data-kept')
          .map((issue) => [issue.edgeId, issue.field]),
      ).toEqual([
        ['both-pairs', 'metadata.requestData'],
        ['both-pairs', 'metadata.responseData'],
      ]);
    }
  });

  it('rewrites labels exactly as reading an older file does, for any mix of braces', async () => {
    // Random labels from pieces that meet at the edges of the names and of doubled braces.
    const pieces = [
      '{',
      '}',
      '{{',
      '}}',
      '{Request',
      '{ response',
      'Request ',
      ' DATA}',
      'data }',
      ' ',
      '\t',
      'x',
      '{Request Data}',
      '{Response  Data}',
    ];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const labels = Array.from({ length: 3000 }, () =>
      Array.from({ length: 2 + (next() % 9) }, () => pieces[next() % pieces.length]).join(''),
    ).filter((label) => /\S/.test(label));
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, before);
    const store = await PostgresModelStore.open(db, quiet);
    const { id } = await store.save({ graph: { label: 'Made-up', nodes, edges: [] } }, author);
    await db.query(
      `insert into relationships (model_id, ordinal, id, source, target, relation, label)
       select $1::uuid, n - 1, 'e' || n, 'quay', 'crane', 'Relation', label
       from unnest($2::text[]) with ordinality as t(label, n)`,
      [id, labels],
    );
    await migrate(db, all);
    const rows = await db.query<{ label: string }>(
      'select label from relationships where model_id = $1::uuid order by ordinal',
      [id],
    );
    const differences = rows.flatMap((row, index) => {
      const label = labels[index] ?? '';
      const expected = withDirectionNamesInLabel(label);
      return row.label === expected ? [] : [{ label, migrated: row.label, expected }];
    });
    expect(differences).toEqual([]);
    // The mix does hold names to rename.
    expect(rows.some((row) => row.label.includes('{Source to Target Data}'))).toBe(true);
  });
});

import { PGlite } from '@electric-sql/pglite';
import type { JgfDocument, ModelAuthor } from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { convertedDataLists, convertOlderTypes } from '../src/jgf/older-types.js';
import { validateJgf } from '../src/jgf/validate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Request Data and Response Data become lists: migration 013 on made-up data, and the same rule
// when a file or a row is read.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '013');
const before = all.filter((migration) => migration.version < '013');
const quiet = { log: { warn: () => undefined } };

const nbsp = String.fromCharCode(0xa0);
const ideographicSpace = String.fromCharCode(0x3000);

const nodes = {
  mill: {
    label: 'Mill',
    metadata: { type: 'Application', requestData: 'An element keeps its own' },
  },
  bakery: { label: 'Bakery', metadata: { type: 'Application' } },
  silo: { label: 'Silo', metadata: { type: 'Infrastructure' } },
};

const edge = (id: string, fields: Record<string, unknown>): Record<string, unknown> => ({
  id,
  source: 'mill',
  target: 'bakery',
  relation: 'Relation',
  ...fields,
});

// Each case: the edge as stored before, and its metadata afterwards.
const cases: [Record<string, unknown>, unknown][] = [
  [
    edge('both', {
      label: '{Request Data}',
      metadata: { requestData: 'Flour', responseData: 'Loaves', identity: 'svc-mill', zone: 'x' },
    }),
    { requestData: ['Flour'], responseData: ['Loaves'], identity: 'svc-mill', zone: 'x' },
  ],
  [edge('request', { metadata: { requestData: 'Flour' } }), { requestData: ['Flour'] }],
  [edge('response', { metadata: { responseData: 'Loaves' } }), { responseData: ['Loaves'] }],
  // The text is kept exactly, white space and commas included: it is one value.
  [
    edge('as-stored', { metadata: { requestData: '  Flour, sugar\n' } }),
    { requestData: ['  Flour, sugar\n'] },
  ],
  [
    edge('empty', { metadata: { requestData: '', architectureState: 'Target' } }),
    {
      architectureState: 'Target',
    },
  ],
  [
    edge('blank', {
      metadata: { requestData: ` \t\n${nbsp}`, responseData: `${ideographicSpace} ` },
    }),
    {},
  ],
  [
    edge('one-blank', { metadata: { requestData: 'Flour', responseData: '  ' } }),
    {
      requestData: ['Flour'],
    },
  ],
  [
    edge('lists', { metadata: { requestData: ['Flour', 'Sugar'], responseData: [] } }),
    { requestData: ['Flour', 'Sugar'], responseData: [] },
  ],
  [
    edge('mixed', { metadata: { requestData: ['Flour'], responseData: 'Loaves' } }),
    {
      requestData: ['Flour'],
      responseData: ['Loaves'],
    },
  ],
  [edge('number', { metadata: { requestData: 7 } }), { requestData: 7 }],
  [edge('object', { metadata: { requestData: { a: 1 } } }), { requestData: { a: 1 } }],
  [edge('null', { metadata: { requestData: null } }), { requestData: null }],
  [
    edge('on-contains', {
      source: 'silo',
      target: 'mill',
      relation: 'Contains',
      metadata: { requestData: 'Grain' },
    }),
    { requestData: ['Grain'] },
  ],
  [edge('without', { metadata: { protocol: 'REST' } }), { protocol: 'REST' }],
  [edge('no-metadata', {}), null],
];

const document = (): JgfDocument =>
  ({
    graph: { label: 'Made-up bakery', nodes, edges: cases.map(([stored]) => stored) },
  }) as unknown as JgfDocument;

interface Row {
  ordinal: number;
  id: string;
  source: string;
  target: string;
  relation: string;
  directed: boolean | null;
  label: string | null;
  metadata: unknown;
  extra: unknown;
  version: number;
}
const rowsOf = (db: TestDb, id: string) =>
  db.query<Row>(
    `select ordinal, id, source, target, relation, directed, label, metadata, extra, version
     from relationships where model_id = $1::uuid order by ordinal`,
    [id],
  );

describe('migration 013', () => {
  const opened: TestDb[] = [];

  /** A database at migration 012 holding the made-up model, as the previous API stored it. */
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

  it('turns each single text into a list of it, drops a blank one, and changes nothing else', async () => {
    const { db, id } = await olderDatabase();
    const was = await rowsOf(db, id);
    const [model] = await db.query<{ version: number }>(
      'select version from models where id = $1::uuid',
      [id],
    );

    expect(await migrate(db, all)).toBe(1);

    const now = await rowsOf(db, id);
    expect(now.map((row) => row.metadata)).toEqual(cases.map(([, after]) => after));
    // Nothing else changes: order, ids, ends, type, direction, labels, extra fields and versions.
    const rest = (rows: Row[]) => rows.map((row) => ({ ...row, metadata: 0 }));
    expect(rest(now)).toEqual(rest(was));
    expect(await db.query('select version from models where id = $1::uuid', [id])).toEqual([model]);
    // An element's own key named requestData is custom metadata: it stays.
    const [mill] = await db.query<{ metadata: unknown }>(
      `select metadata from elements where model_id = $1::uuid and id = 'mill'`,
      [id],
    );
    expect(mill?.metadata).toMatchObject({ requestData: 'An element keeps its own' });
    expect(await migrate(db, all)).toBe(0);
  });

  it('leaves metadata that is not an object alone', async () => {
    const { db, id } = await olderDatabase();
    for (const [key, value] of [
      ['without', '["requestData"]'],
      ['no-metadata', 'null'],
      ['empty', '"requestData"'],
    ] as const) {
      await db.query(
        `update relationships set metadata = $2::jsonb where model_id = $1::uuid and id = $3`,
        [id, value, key],
      );
    }
    await migrate(db, all);
    const byId = new Map((await rowsOf(db, id)).map((row) => [row.id, row.metadata]));
    expect(byId.get('without')).toEqual(['requestData']);
    expect(byId.get('no-metadata')).toBeNull();
    expect(byId.get('empty')).toBe('requestData');
  });

  it('gives what reading the stored row gives', async () => {
    const { db, id } = await olderDatabase();
    const was = await rowsOf(db, id);
    await migrate(db, all);
    const now = await rowsOf(db, id);
    const asEdge = (row: Row | undefined): Record<string, unknown> => ({
      id: row?.id,
      ...(row?.metadata === null ? {} : { metadata: row?.metadata }),
    });
    const differences = was.flatMap((row, index) => {
      const read = convertedDataLists(asEdge(row));
      const migrated = asEdge(now[index]);
      return JSON.stringify(read) === JSON.stringify(migrated) ? [] : [{ read, migrated }];
    });
    expect(differences).toEqual([]);
  });

  it('leaves every stored model readable, with no damaged model', async () => {
    const { db, id } = await olderDatabase();
    await migrate(db, all);
    const store = await PostgresModelStore.open(db, quiet);
    expect(await store.listDamaged()).toEqual([]);
    const stored = await store.get(id);
    const validation = validateJgf(stored);
    expect(validation.valid).toBe(true);
    // Only the shapes that aren't a list of texts, and the keys on a Contains, are warnings.
    expect(validation.warnings.map((issue) => [issue.edgeId, issue.code])).toEqual([
      ['number', 'invalid-property-value'],
      ['object', 'invalid-property-value'],
      ['null', 'invalid-property-value'],
      ['on-contains', 'property-not-for-type'],
    ]);
  });

  it('converts a large model in one go', async () => {
    const count = 20_000;
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, before);
    const store = await PostgresModelStore.open(db, quiet);
    const edges = Array.from({ length: count }, (_, index) =>
      edge(`e${String(index)}`, { metadata: { requestData: 'Flour', responseData: '' } }),
    );
    const { id } = await store.save(
      { graph: { label: 'Made-up', nodes, edges } } as unknown as JgfDocument,
      author,
    );
    await migrate(db, all);
    const [counts] = await db.query<{ listed: number; left: number }>(
      `select count(*) filter (where metadata -> 'requestData' = '["Flour"]'::jsonb)::int as listed,
              count(*) filter (where metadata ? 'responseData')::int as left
       from relationships where model_id = $1::uuid`,
      [id],
    );
    expect(counts).toEqual({ listed: count, left: 0 });
  }, 120_000);
});

describe('reading a file or an import', () => {
  it('follows the same rule as the migration', () => {
    const { document: converted } = convertOlderTypes(document());
    const edges = (converted as JgfDocument).graph.edges ?? [];
    expect(edges.map((e) => e.metadata ?? null)).toEqual(cases.map(([, after]) => after));
  });

  it('leaves the input unchanged, and a document of lists as it is', () => {
    const input = document();
    const copy = structuredClone(input);
    convertOlderTypes(input);
    expect(input).toEqual(copy);
    const today = { graph: { nodes, edges: [edge('t', { metadata: { requestData: ['A'] } })] } };
    expect(convertOlderTypes(today)).toEqual({ document: today, converted: 0, dataConverted: 0 });
  });
});

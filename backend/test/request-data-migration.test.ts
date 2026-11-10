import { PGlite } from '@electric-sql/pglite';
import type { JgfDocument, JgfEdge, ModelAuthor } from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import {
  convertedData,
  convertedEdge,
  convertedEdgeType,
  convertOlderTypes,
  validateImported,
  withRequestDataInLabel,
} from '../src/jgf/older-types.js';
import { validateJgf } from '../src/jgf/validate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Data becomes Request Data: migration 012 on made-up data, and the same rule for files and
// imports. Reading today also turns a single text in Request Data into a list (migration 013's
// rule, tested on its own): `asRead` gives that step for the cases here.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '012');
const before = all.filter((migration) => migration.version < '012');
const quiet = { log: { warn: () => undefined } };

const nodes = {
  mill: { label: 'Mill', metadata: { type: 'Application', data: 'An element keeps its own' } },
  bakery: { label: 'Bakery', metadata: { type: 'Application' } },
  silo: { label: 'Silo', metadata: { type: 'Infrastructure' } },
};

// [label as stored, label afterwards]
const labels: [string, string][] = [
  ['{Data}', '{Request Data}'],
  ['{data}', '{Request Data}'],
  ['{ Data }', '{Request Data}'],
  ['{\tDATA\u00a0}', '{Request Data}'],
  ['{{Data}}', '{{Data}}'],
  ['{{{Data}}}', '{{{Request Data}}}'],
  ['{{Data}', '{{Data}'],
  [
    'Sends {Data} as {Identity}, {data} again',
    'Sends {Request Data} as {Identity}, {Request Data} again',
  ],
  ['{Identity} {protocol}', '{Identity} {protocol}'],
  ['x{a{Data}', 'x{a{Request Data}'],
  ['}{Data}}', '}{Request Data}}'],
  ['{Da ta} {Datas} {Data', '{Da ta} {Datas} {Data'],
  ['Data}', 'Data}'],
  ['Plain flour', 'Plain flour'],
  // PostgreSQL takes the longest alternative at each place, JavaScript the first: the pieces must
  // still come out the same next to doubled braces and with line and wide white space inside.
  ['{Data}}', '{Request Data}}'],
  ['{{{{Data}}}}', '{{{{Data}}}}'],
  ['{{ {Data} }}', '{{ {Request Data} }}'],
  ['{ data　}{DaTa}', '{Request Data}{Request Data}'],
];

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
    edge('with-data', {
      label: 'Flour',
      metadata: { data: 'Flour', architectureState: 'Target', identity: 'svc-mill', zone: 'x' },
    }),
    { requestData: 'Flour', architectureState: 'Target', identity: 'svc-mill', zone: 'x' },
  ],
  [edge('both-ways', { directed: false, metadata: { data: 'Orders' } }), { requestData: 'Orders' }],
  [
    edge('has-request', { metadata: { data: 'Old', requestData: 'New' } }),
    { data: 'Old', requestData: 'New' },
  ],
  [
    edge('has-response', { metadata: { data: 'Old', responseData: 'Kept' } }),
    { requestData: 'Old', responseData: 'Kept' },
  ],
  [edge('not-text', { metadata: { data: 7 } }), { requestData: 7 }],
  [edge('a-list', { metadata: { data: ['a', 'b'] } }), { requestData: ['a', 'b'] }],
  [edge('empty', { metadata: { data: '' } }), { requestData: '' }],
  [
    edge('on-contains', {
      source: 'silo',
      target: 'mill',
      relation: 'Contains',
      metadata: { data: 'Grain' },
    }),
    { requestData: 'Grain' },
  ],
  [edge('without', { metadata: { protocol: 'REST' } }), { protocol: 'REST' }],
  [edge('no-metadata', {}), null],
  ...labels.map(([label], index): [Record<string, unknown>, unknown] => [
    edge(`label-${String(index)}`, { label, metadata: { requestData: 'Flour' } }),
    { requestData: 'Flour' },
  ]),
];

/**
 * Metadata as reading it today gives it: a single text in Request Data or Response Data as a list,
 * a blank one gone.
 */
const asRead = (metadata: unknown): unknown => {
  if (typeof metadata !== 'object' || metadata === null) return metadata;
  return Object.fromEntries(
    Object.entries(metadata).flatMap(([key, value]): [string, unknown][] => {
      if ((key !== 'requestData' && key !== 'responseData') || typeof value !== 'string') {
        return [[key, value]];
      }
      return value.trim() === '' ? [] : [[key, [value]]];
    }),
  );
};

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

const labelAfter = (stored: Record<string, unknown>): unknown => {
  const at = labels.findIndex(([label]) => label === stored.label);
  return at === -1 ? (stored.label ?? null) : labels[at]?.[1];
};

describe('migration 012', () => {
  const opened: TestDb[] = [];

  /** A database at migration 011 holding the made-up model, as the previous API stored it. */
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

  it('moves Data to Request Data and {Data} to {Request Data}, and nothing else', async () => {
    const { db, id } = await olderDatabase();
    const was = await rowsOf(db, id);
    const [model] = await db.query<{ version: number }>(
      'select version from models where id = $1::uuid',
      [id],
    );

    expect(await migrate(db, all)).toBe(1);

    const now = await rowsOf(db, id);
    expect(now.map((row) => row.metadata)).toEqual(cases.map(([, after]) => after));
    expect(now.map((row) => row.label)).toEqual(cases.map(([stored]) => labelAfter(stored)));
    // Nothing else changes: order, ids, ends, type, direction, extra fields and versions.
    const rest = (rows: Row[]) => rows.map((row) => ({ ...row, metadata: 0, label: 0 }));
    expect(rest(now)).toEqual(rest(was));
    expect(await db.query('select version from models where id = $1::uuid', [id])).toEqual([model]);
    // An element's own key named data is custom metadata: it stays.
    const [mill] = await db.query<{ metadata: unknown }>(
      `select metadata from elements where model_id = $1::uuid and id = 'mill'`,
      [id],
    );
    expect(mill?.metadata).toMatchObject({ data: 'An element keeps its own' });
    expect(await migrate(db, all)).toBe(0);
  });

  it('leaves metadata of the wrong shape alone', async () => {
    const { db, id } = await olderDatabase();
    for (const [key, value] of [
      ['without', '["data"]'],
      ['no-metadata', 'null'],
      ['empty', '"data"'],
    ] as const) {
      await db.query(
        `update relationships set metadata = $2::jsonb where model_id = $1::uuid and id = $3`,
        [id, value, key],
      );
    }
    await migrate(db, all);
    const byId = new Map((await rowsOf(db, id)).map((row) => [row.id, row.metadata]));
    expect(byId.get('without')).toEqual(['data']);
    expect(byId.get('no-metadata')).toBeNull();
    expect(byId.get('empty')).toBe('data');
  });

  it('gives what reading the stored row through the conversion of Data gives', async () => {
    const { db, id } = await olderDatabase();
    const was = await rowsOf(db, id);
    await migrate(db, all);
    const now = await rowsOf(db, id);
    const asEdge = (row: Row | undefined): Record<string, unknown> => ({
      id: row?.id,
      source: row?.source,
      target: row?.target,
      relation: row?.relation,
      ...(row?.label === null ? {} : { label: row?.label }),
      ...(row?.metadata === null ? {} : { metadata: row?.metadata }),
    });
    const differences = was.flatMap((row, index) => {
      const read = convertedData(convertedEdgeType(asEdge(row)));
      const migrated = asEdge(now[index]);
      return JSON.stringify(sorted(read)) === JSON.stringify(sorted(migrated))
        ? []
        : [{ read, migrated }];
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
    // Data kept beside Request Data is a warning, never an error.
    expect(
      validation.warnings
        .filter((issue) => issue.code === 'retired-property')
        .map((issue) => issue.edgeId),
    ).toEqual(['has-request']);
    const edges = stored?.graph.edges ?? [];
    expect(edges.filter((e) => e.metadata?.data !== undefined).map((e) => e.id)).toEqual([
      'has-request',
    ]);
  });

  it('converts a large model in one go', async () => {
    const count = 20_000;
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, before);
    const store = await PostgresModelStore.open(db, quiet);
    const edges = Array.from({ length: count }, (_, index) =>
      edge(`e${String(index)}`, { label: `{Data} ${String(index)}`, metadata: { data: 'Flour' } }),
    );
    const { id } = await store.save(
      { graph: { label: 'Made-up', nodes, edges } } as unknown as JgfDocument,
      author,
    );
    await migrate(db, all);
    const [counts] = await db.query<{ moved: number; left: number; labelled: number }>(
      `select count(*) filter (where metadata ->> 'requestData' = 'Flour')::int as moved,
              count(*) filter (where metadata ? 'data')::int as left,
              count(*) filter (where label like '{Request Data} %')::int as labelled
       from relationships where model_id = $1::uuid`,
      [id],
    );
    expect(counts).toEqual({ moved: count, left: 0, labelled: count });
  }, 120_000);
});

/** A copy with every object's keys in order, so two objects compare whatever their key order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, inner]) => [key, sorted(inner)]),
  );
}

describe('older files and imports', () => {
  it('follow the same rule as the migration', () => {
    const { document: converted, dataConverted } = convertOlderTypes(document());
    const edges = (converted as JgfDocument).graph.edges ?? [];
    expect(edges.map((e) => e.metadata ?? null)).toEqual(cases.map(([, after]) => asRead(after)));
    expect(edges.map((e) => e.label ?? null)).toEqual(cases.map(([stored]) => labelAfter(stored)));
    const changed = cases.filter(
      ([stored, after]) =>
        JSON.stringify(stored.metadata ?? null) !== JSON.stringify(after) ||
        labelAfter(stored) !== (stored.label ?? null),
    );
    expect(dataConverted).toBe(changed.length);
  });

  it('keep the label as stored when reading a stored model', () => {
    const stored = edge('x', { label: '{Data}', metadata: { data: 'Flour' } });
    expect(convertedEdge(stored, false)).toEqual({
      ...stored,
      metadata: { requestData: ['Flour'] },
    });
  });

  it('note the conversion in the report, once per relationship', () => {
    const older = {
      graph: {
        nodes,
        edges: [
          edge('d', { metadata: { data: 'Flour' } }),
          edge('l', { label: '{Data}' }),
          edge('f', { relation: 'Information flow', label: 'Loaves' }),
          edge('t', { metadata: { requestData: 'Flour' } }),
        ],
      },
    };
    const { document: stored, validation } = validateImported(older);
    expect(validation.valid).toBe(true);
    expect(validation.warnings.map((issue) => [issue.code, issue.message])).toEqual([
      [
        'older-relationship-types',
        'Document: 1 relationship with the older type Information flow or Integration, or with Information flow, converted to a Relation. A labelled Information flow keeps its label as Request Data.',
      ],
      [
        'older-data-property',
        'Document: 2 relationships with Data, or with {Data} in the label, converted: Data is now Request Data.',
      ],
    ]);
    const edges = (stored as JgfDocument).graph.edges ?? [];
    expect(edges.map((e: JgfEdge) => [e.id, e.label, e.metadata])).toEqual([
      ['d', undefined, { requestData: ['Flour'] }],
      ['l', '{Request Data}', undefined],
      ['f', 'Loaves', { requestData: ['Loaves'] }],
      ['t', undefined, { requestData: ['Flour'] }],
    ]);
  });

  it('leave a document without Data as it is', () => {
    const today = { graph: { nodes, edges: [edge('t', { label: '{{Data}}' })] } };
    expect(convertOlderTypes(today)).toEqual({ document: today, converted: 0, dataConverted: 0 });
  });

  it('rewrite only {Data}, in linear time', () => {
    for (const [label, after] of labels) expect(withRequestDataInLabel(label)).toBe(after);
    const long = '{Data}{a '.repeat(30_000);
    expect(withRequestDataInLabel(long)).toBe('{Request Data}{a '.repeat(30_000));
  });
});

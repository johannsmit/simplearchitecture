import { PGlite } from '@electric-sql/pglite';
import type { JgfDocument, JgfEdge, ModelAuthor } from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import {
  convertedDirections,
  convertedEdge,
  convertOlderTypes,
  validateImported,
  withDirectionNamesInLabel,
} from '../src/jgf/older-types.js';
import { validateJgf } from '../src/jgf/validate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Request Data and Response Data are named by direction: Source to target data and Target to source
// data. Migration 018 on made-up data, and the same rule for files and imports.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '018');
const before = all.filter((migration) => migration.version < '018');
const quiet = { log: { warn: () => undefined } };

const nodes = {
  mill: {
    label: 'Mill',
    metadata: { type: 'Application', requestData: 'An element keeps its own' },
  },
  bakery: { label: 'Bakery', metadata: { type: 'Application' } },
  silo: { label: 'Silo', metadata: { type: 'Infrastructure' } },
};

const forward = '{Source to Target Data}';
const backward = '{Target to Source Data}';

// [label as stored, label afterwards]
const labels: [string, string][] = [
  ['{Request Data}', forward],
  ['{Response Data}', backward],
  ['{request data}', forward],
  ['{RESPONSE DATA}', backward],
  ['{ Request Data }', forward],
  ['{Request   Data}', forward],
  ['{\tREQUEST\nData }', forward],
  ['{　response data }', backward],
  ['{{Request Data}}', '{{Request Data}}'],
  ['{{{Request Data}}}', `{{${forward}}}`],
  ['{{Response Data}', '{{Response Data}'],
  [
    'Sends {Request Data} as {Identity}, gets {response data}',
    `Sends ${forward} as {Identity}, gets ${backward}`,
  ],
  ['{Identity} {protocol} {Data list}', '{Identity} {protocol} {Data list}'],
  ['x{a{Request Data}', `x{a${forward}`],
  ['}{Response Data}}', `}${backward}}`],
  ['{RequestData} {Request Datas} {Request Data', '{RequestData} {Request Datas} {Request Data'],
  ['{Request-Data} {Re quest Data}', '{Request-Data} {Re quest Data}'],
  ['Request Data}', 'Request Data}'],
  ['Plain flour', 'Plain flour'],
  // PostgreSQL takes the longest alternative at each place, JavaScript the first: the pieces must
  // still come out the same next to doubled braces.
  ['{Request Data}}', `${forward}}`],
  ['{{{{Response Data}}}}', '{{{{Response Data}}}}'],
  ['{{ {Request Data} }}', `{{ ${forward} }}`],
  ['{Response Data}{request data}', `${backward}${forward}`],
  // Already named by direction: stays.
  [forward, forward],
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
    edge('both', {
      label: 'Flour',
      metadata: {
        requestData: ['Flour', 'Sugar'],
        responseData: ['Loaves'],
        architectureState: 'Target',
        identity: 'svc-mill',
        zone: 'x',
      },
    }),
    {
      sourceToTargetData: ['Flour', 'Sugar'],
      targetToSourceData: ['Loaves'],
      architectureState: 'Target',
      identity: 'svc-mill',
      zone: 'x',
    },
  ],
  [
    edge('two-way', { directed: false, metadata: { requestData: ['Orders'] } }),
    { sourceToTargetData: ['Orders'] },
  ],
  [
    edge('response-only', { metadata: { responseData: ['Totals'] } }),
    { targetToSourceData: ['Totals'] },
  ],
  // A relationship that has a new key already keeps both as they are.
  [
    edge('has-new', { metadata: { requestData: ['Old'], sourceToTargetData: ['New'] } }),
    { requestData: ['Old'], sourceToTargetData: ['New'] },
  ],
  [
    edge('has-other-new', {
      metadata: { requestData: ['Old'], responseData: ['Back'], targetToSourceData: ['Kept'] },
    }),
    { sourceToTargetData: ['Old'], responseData: ['Back'], targetToSourceData: ['Kept'] },
  ],
  // Any value moves as it is.
  [edge('not-a-list', { metadata: { requestData: 7 } }), { sourceToTargetData: 7 }],
  [edge('empty-list', { metadata: { responseData: [] } }), { targetToSourceData: [] }],
  [edge('null', { metadata: { requestData: null } }), { sourceToTargetData: null }],
  [
    edge('data-kept', { metadata: { data: 'Older', requestData: ['Flour'] } }),
    { data: 'Older', sourceToTargetData: ['Flour'] },
  ],
  [
    edge('on-contains', {
      source: 'silo',
      target: 'mill',
      relation: 'Contains',
      metadata: { requestData: ['Grain'] },
    }),
    { sourceToTargetData: ['Grain'] },
  ],
  [edge('without', { metadata: { protocol: 'REST' } }), { protocol: 'REST' }],
  [edge('no-metadata', {}), null],
  ...labels.map(([label], index): [Record<string, unknown>, unknown] => [
    edge(`label-${String(index)}`, { label, metadata: { requestData: ['Flour'] } }),
    { sourceToTargetData: ['Flour'] },
  ]),
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

const labelAfter = (stored: Record<string, unknown>): unknown => {
  const at = labels.findIndex(([label]) => label === stored.label);
  return at === -1 ? (stored.label ?? null) : labels[at]?.[1];
};

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

describe('migration 018', () => {
  const opened: TestDb[] = [];

  /** A database at migration 017 holding the made-up model, as the previous API stored it. */
  const olderDatabase = async () => {
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, before);
    const store = await PostgresModelStore.open(db, quiet);
    const { id } = await store.save(document(), author);
    // Stored exactly as the previous API wrote it, whatever reading converts today.
    for (const [stored] of cases) {
      await db.query(
        `update relationships set metadata = $3::jsonb, label = $4
         where model_id = $1::uuid and id = $2`,
        [
          id,
          stored.id,
          stored.metadata === undefined ? null : JSON.stringify(stored.metadata),
          stored.label ?? null,
        ],
      );
    }
    return { db, id };
  };

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('renames the two keys and their names in labels, and changes nothing else', async () => {
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
    // An element's own key named requestData is custom metadata: it stays.
    const [mill] = await db.query<{ metadata: unknown }>(
      `select metadata from elements where model_id = $1::uuid and id = 'mill'`,
      [id],
    );
    expect(mill?.metadata).toMatchObject({ requestData: 'An element keeps its own' });
    expect(await migrate(db, all)).toBe(0);
  });

  it('leaves metadata of the wrong shape alone', async () => {
    const { db, id } = await olderDatabase();
    for (const [key, value] of [
      ['without', '["requestData"]'],
      ['no-metadata', 'null'],
      ['not-a-list', '"requestData"'],
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
    expect(byId.get('not-a-list')).toBe('requestData');
  });

  it('gives what reading the stored row through the conversion gives', async () => {
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
      const read = convertedDirections(asEdge(row));
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
    // An older key kept beside a new one is a warning, never an error, as Data kept is.
    expect(
      validation.warnings
        .filter((issue) => issue.code === 'retired-property' || issue.code === 'older-data-kept')
        .map((issue) => [issue.edgeId, issue.field]),
    ).toEqual([
      ['has-new', 'metadata.requestData'],
      ['has-other-new', 'metadata.responseData'],
      ['data-kept', 'metadata.data'],
    ]);
  });

  it('converts a large model in one go', async () => {
    const count = 20_000;
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, before);
    const store = await PostgresModelStore.open(db, quiet);
    const { id } = await store.save({ graph: { label: 'Made-up', nodes, edges: [] } }, author);
    // As the previous API stored them: rows written directly, past today's reading.
    await db.query(
      `insert into relationships (model_id, ordinal, id, source, target, relation, label, metadata)
       select $1::uuid, n, 'e' || n, 'mill', 'bakery', 'Relation', '{Response Data} ' || n,
              '{"requestData": ["Flour"], "responseData": ["Loaves"]}'::jsonb
       from generate_series(0, $2::int - 1) as n`,
      [id, count],
    );
    await migrate(db, all);
    const [counts] = await db.query<{ moved: number; left: number; labelled: number }>(
      `select count(*) filter (
                where metadata -> 'sourceToTargetData' = '["Flour"]'::jsonb
                  and metadata -> 'targetToSourceData' = '["Loaves"]'::jsonb)::int as moved,
              count(*) filter (where metadata ? 'requestData' or metadata ? 'responseData')::int
                as left,
              count(*) filter (where label like '{Target to Source Data} %')::int as labelled
       from relationships where model_id = $1::uuid`,
      [id],
    );
    expect(counts).toEqual({ moved: count, left: 0, labelled: count });
  }, 120_000);
});

describe('older files and imports', () => {
  it('follow the same rule as the migration', () => {
    const { document: converted, directionConverted } = convertOlderTypes(document());
    const edges = (converted as JgfDocument).graph.edges ?? [];
    expect(edges.map((e) => e.metadata ?? null)).toEqual(cases.map(([, after]) => after));
    expect(edges.map((e) => e.label ?? null)).toEqual(cases.map(([stored]) => labelAfter(stored)));
    const changed = cases.filter(
      ([stored, after]) =>
        JSON.stringify(stored.metadata ?? null) !== JSON.stringify(after) ||
        labelAfter(stored) !== (stored.label ?? null),
    );
    expect(directionConverted).toBe(changed.length);
  });

  it('keep the label as stored when reading a stored model', () => {
    const stored = edge('x', { label: '{Request Data}', metadata: { requestData: ['Flour'] } });
    expect(convertedEdge(stored, false)).toEqual({
      ...stored,
      metadata: { sourceToTargetData: ['Flour'] },
    });
  });

  it('chain the older conversions: types, Data and single texts end in the new keys', () => {
    const older = {
      graph: {
        nodes,
        edges: [
          edge('d', { label: '{Data}', metadata: { data: 'Flour' } }),
          edge('f', { relation: 'Information flow', label: 'Loaves' }),
          edge('i', { metadata: { informationFlow: true }, label: 'Rolls' }),
          edge('t', { metadata: { requestData: 'Flour', responseData: ' ' } }),
          edge('r', { label: '{Response Data}', metadata: { responseData: 'Totals' } }),
          edge('n', { metadata: { sourceToTargetData: 'Single' } }),
        ],
      },
    };
    const { document: stored, validation } = validateImported(older);
    expect(validation.valid).toBe(true);
    const edges = (stored as JgfDocument).graph.edges ?? [];
    expect(edges.map((e: JgfEdge) => [e.id, e.relation, e.label, e.metadata])).toEqual([
      ['d', 'Relation', forward, { sourceToTargetData: ['Flour'] }],
      ['f', 'Relation', 'Loaves', { sourceToTargetData: ['Loaves'] }],
      ['i', 'Relation', 'Rolls', { sourceToTargetData: ['Rolls'] }],
      ['t', 'Relation', undefined, { sourceToTargetData: ['Flour'] }],
      ['r', 'Relation', backward, { targetToSourceData: ['Totals'] }],
      ['n', 'Relation', undefined, { sourceToTargetData: ['Single'] }],
    ]);
    expect(validation.warnings.map((issue) => [issue.code, issue.message])).toEqual([
      [
        'older-relationship-types',
        'Document: 2 relationships with the older type Information flow or Integration, or with Information flow, converted to a Relation. A labelled Information flow keeps its label as Source to target data.',
      ],
      [
        'older-data-property',
        'Document: 1 relationship with Data, or with {Data} in the label, converted: Data is now Source to target data.',
      ],
      [
        'older-data-direction',
        'Document: 2 relationships with Request Data or Response Data, or with them in the label, converted: Request Data is now Source to target data, Response Data is now Target to source data.',
      ],
    ]);
  });

  it('keep an older key beside a new one as it is, with a warning', () => {
    const { document: stored, validation } = validateImported({
      graph: {
        nodes,
        edges: [edge('k', { metadata: { requestData: ['Old'], sourceToTargetData: ['New'] } })],
      },
    });
    expect((stored as JgfDocument).graph.edges?.[0]?.metadata).toEqual({
      requestData: ['Old'],
      sourceToTargetData: ['New'],
    });
    expect(validation.valid).toBe(true);
    expect(validation.warnings.map((issue) => [issue.code, issue.field])).toEqual([
      ['older-data-kept', 'metadata.requestData'],
    ]);
  });

  it('leave a document with the new keys as it is', () => {
    const today = {
      graph: {
        nodes,
        edges: [edge('t', { label: '{{Request Data}}', metadata: { sourceToTargetData: ['a'] } })],
      },
    };
    expect(convertOlderTypes(today)).toEqual({
      document: today,
      converted: 0,
      dataConverted: 0,
      directionConverted: 0,
    });
  });

  it('rename only the two names in a label, in linear time', () => {
    for (const [label, after] of labels) expect(withDirectionNamesInLabel(label)).toBe(after);
    const long = '{Request Data}{a '.repeat(30_000);
    expect(withDirectionNamesInLabel(long)).toBe(`${forward}{a `.repeat(30_000));
  });
});

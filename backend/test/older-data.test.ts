import { PGlite } from '@electric-sql/pglite';
import {
  buildModelGraph,
  elementReferences,
  filterFields,
  referenceKey,
  withImportableReferences,
  type JgfDocument,
  type JgfEdge,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, type Migration } from '../src/db/migrate.js';
import { ElementService } from '../src/editing/element-service.js';
import { convertOlderTypes, validateImported } from '../src/jgf/older-types.js';
import { validateJgf } from '../src/jgf/validate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { createTestDb, pgliteDb, type TestDb } from './pglite.js';

// Data in the shapes older versions stored and exported, read today. One table: each row is an
// edge as an older version held it, and the edge it is today. Every row is checked three ways:
// - as an older JGF file, imported (the conversion in the import, with its note in the report);
// - as rows in a database of that version, brought up to date by every migration that follows;
// - as rows an older API still running wrote after the migrations, read by today's store.
// Made-up data only.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const quiet = { log: { warn: () => undefined } };
const migrations = loadMigrations();
/** The migrations a database had before `version` ran. */
const before = (version: string): Migration[] => migrations.filter((m) => m.version < version);

const nodes = {
  mill: { label: 'Mill', metadata: { type: 'Application' } },
  bakery: { label: 'Bakery', metadata: { type: 'Application' } },
  silo: { label: 'Silo', metadata: { type: 'Infrastructure' } },
};
const elementMetadata = { data: 'Own', requestData: 'Own', informationFlow: 'Own' };

type Edge = Record<string, unknown>;
interface Row {
  /** What the row shows. */
  name: string;
  /** The migration that converts this shape: the database is at the one before it. */
  until: '006' | '009' | '012' | '013' | '018';
  stored: Edge;
  /** The edge today. A label of its own is given when converting it changes the label. */
  today: Edge;
  /** The note the import gives, if any. */
  note?: string;
}

const edge = (id: string, fields: Edge): Edge => ({
  id,
  source: 'mill',
  target: 'bakery',
  relation: 'Relation',
  ...fields,
});
const forward = '{Source to Target Data}';
const backward = '{Target to Source Data}';

const rows: Row[] = [
  // Before migration 006: the types Information flow and Integration.
  {
    name: 'a labelled Information flow becomes a Relation with its label as data',
    until: '006',
    stored: edge('f1', { relation: 'Information flow', label: 'Orders' }),
    today: edge('f1', { label: 'Orders', metadata: { sourceToTargetData: ['Orders'] } }),
    note: 'older-relationship-types',
  },
  {
    name: 'a two-way Information flow keeps its direction and properties',
    until: '006',
    stored: edge('f2', {
      relation: 'Information flow',
      directed: false,
      metadata: { architectureState: 'Target', protocol: 'REST' },
    }),
    today: edge('f2', {
      directed: false,
      metadata: { architectureState: 'Target', protocol: 'REST' },
    }),
    note: 'older-relationship-types',
  },
  {
    name: 'an Integration becomes a plain Relation',
    until: '006',
    stored: edge('i1', { relation: 'Integration', label: 'API', metadata: { auth: 'OAuth' } }),
    today: edge('i1', { label: 'API', metadata: { auth: 'OAuth' } }),
    note: 'older-relationship-types',
  },
  {
    // A known, accepted limit: the custom text is lost, as migration 006 can't change.
    name: 'a custom text under informationFlow on an old flow is dropped',
    until: '006',
    stored: edge('f3', { relation: 'Information flow', metadata: { informationFlow: 'Made-up' } }),
    today: edge('f3', { metadata: {} }),
    note: 'older-relationship-types',
  },
  {
    name: 'a Contains stays, and drops informationFlow',
    until: '006',
    stored: edge('c1', {
      source: 'silo',
      target: 'mill',
      relation: 'Contains',
      label: 'Holds',
      metadata: { informationFlow: 1 },
    }),
    today: edge('c1', {
      source: 'silo',
      target: 'mill',
      relation: 'Contains',
      label: 'Holds',
      metadata: {},
    }),
    note: 'older-relationship-types',
  },
  // Before migration 009: Information flow as a yes or no on a Relation.
  {
    name: 'a labelled yes keeps its label as data, beside its other properties',
    until: '009',
    stored: edge('y1', {
      label: 'Orders',
      metadata: { informationFlow: true, architectureState: 'Target', zone: 'x' },
    }),
    today: edge('y1', {
      label: 'Orders',
      metadata: { architectureState: 'Target', zone: 'x', sourceToTargetData: ['Orders'] },
    }),
    note: 'older-relationship-types',
  },
  {
    name: 'a yes without a label, a no, and a blank label leave no data',
    until: '009',
    stored: edge('y2', { label: '   ', metadata: { informationFlow: true } }),
    today: edge('y2', { label: '   ', metadata: {} }),
    note: 'older-relationship-types',
  },
  {
    name: 'a no keeps its label only',
    until: '009',
    stored: edge('y3', { label: 'Hosted on', metadata: { informationFlow: false } }),
    today: edge('y3', { label: 'Hosted on', metadata: {} }),
    note: 'older-relationship-types',
  },
  {
    name: 'a yes with data keeps that data, not the label',
    until: '009',
    stored: edge('y4', { label: 'Feeds', metadata: { informationFlow: true, data: 'Existing' } }),
    today: edge('y4', { label: 'Feeds', metadata: { sourceToTargetData: ['Existing'] } }),
    note: 'older-relationship-types',
  },
  {
    name: 'a label with white space around it is kept as it is',
    until: '009',
    stored: edge('y5', { label: '  Orders  ', metadata: { informationFlow: true } }),
    today: edge('y5', { label: '  Orders  ', metadata: { sourceToTargetData: ['  Orders  '] } }),
    note: 'older-relationship-types',
  },
  {
    name: 'a value that is not true is not a yes',
    until: '009',
    stored: edge('y6', { label: 'Sends', metadata: { informationFlow: 'yes' } }),
    today: edge('y6', { label: 'Sends', metadata: {} }),
    note: 'older-relationship-types',
  },
  {
    name: 'a two-way yes',
    until: '009',
    stored: edge('y7', { label: 'Syncs', directed: false, metadata: { informationFlow: true } }),
    today: edge('y7', {
      label: 'Syncs',
      directed: false,
      metadata: { sourceToTargetData: ['Syncs'] },
    }),
    note: 'older-relationship-types',
  },
  // Before migration 012: one Data property.
  {
    name: 'Data and {Data} in the label become Source to target data',
    until: '012',
    stored: edge('d1', {
      label: 'Sends {Data} as {Identity}, {data} again',
      metadata: { data: 'Flour', identity: 'svc-mill', zone: 'x' },
    }),
    today: edge('d1', {
      label: `Sends ${forward} as {Identity}, ${forward} again`,
      metadata: { sourceToTargetData: ['Flour'], identity: 'svc-mill', zone: 'x' },
    }),
    note: 'older-data-property',
  },
  {
    name: 'Data beside Request Data stays as it is',
    until: '012',
    stored: edge('d2', { metadata: { data: 'Old', requestData: 'New' } }),
    today: edge('d2', { metadata: { data: 'Old', sourceToTargetData: ['New'] } }),
    note: 'older-data-direction',
  },
  {
    name: 'blank Data leaves nothing',
    until: '012',
    stored: edge('d3', { metadata: { data: '' } }),
    today: edge('d3', { metadata: {} }),
    note: 'older-data-property',
  },
  {
    name: 'Data on a Contains moves too',
    until: '012',
    stored: edge('d4', {
      source: 'silo',
      target: 'mill',
      relation: 'Contains',
      metadata: { data: 'Grain' },
    }),
    today: edge('d4', {
      source: 'silo',
      target: 'mill',
      relation: 'Contains',
      metadata: { sourceToTargetData: ['Grain'] },
    }),
    note: 'older-data-property',
  },
  {
    name: '{{Data}} is literal text and stays',
    until: '012',
    stored: edge('d5', { label: '{{Data}} {Data', metadata: { protocol: 'REST' } }),
    today: edge('d5', { label: '{{Data}} {Data', metadata: { protocol: 'REST' } }),
  },
  {
    name: 'Data that is not text moves as it is, for the validation to warn about',
    until: '012',
    stored: edge('d6', { metadata: { data: 7 } }),
    today: edge('d6', { metadata: { sourceToTargetData: 7 } }),
    note: 'older-data-property',
  },
  {
    name: 'Data as a list moves as it is',
    until: '012',
    stored: edge('d7', { metadata: { data: ['a', 'b'] } }),
    today: edge('d7', { metadata: { sourceToTargetData: ['a', 'b'] } }),
    note: 'older-data-property',
  },
  {
    name: 'Data beside Response Data',
    until: '012',
    stored: edge('d8', { metadata: { data: 'Old', responseData: 'Kept' } }),
    today: edge('d8', { metadata: { sourceToTargetData: ['Old'], targetToSourceData: ['Kept'] } }),
    note: 'older-data-property',
  },
  // Before migration 013: Request Data and Response Data as single texts.
  {
    name: 'single texts become lists, and the label names them by direction',
    until: '013',
    stored: edge('t1', {
      label: '{Request Data} / {response data}',
      metadata: { requestData: 'Flour', responseData: 'Loaves' },
    }),
    today: edge('t1', {
      label: `${forward} / ${backward}`,
      metadata: { sourceToTargetData: ['Flour'], targetToSourceData: ['Loaves'] },
    }),
    note: 'older-data-direction',
  },
  {
    name: 'a text is kept exactly, white space and commas included',
    until: '013',
    stored: edge('t2', { metadata: { requestData: '  Flour, sugar\n' } }),
    today: edge('t2', { metadata: { sourceToTargetData: ['  Flour, sugar\n'] } }),
    note: 'older-data-direction',
  },
  {
    name: 'a blank text is removed',
    until: '013',
    stored: edge('t3', { metadata: { requestData: 'Flour', responseData: ' \t\n' } }),
    today: edge('t3', { metadata: { sourceToTargetData: ['Flour'] } }),
    note: 'older-data-direction',
  },
  {
    name: 'a list and a single text together',
    until: '013',
    stored: edge('t4', { metadata: { requestData: ['Flour'], responseData: 'Loaves' } }),
    today: edge('t4', {
      metadata: { sourceToTargetData: ['Flour'], targetToSourceData: ['Loaves'] },
    }),
    note: 'older-data-direction',
  },
  {
    name: 'a value that is not text stays as it is',
    until: '013',
    stored: edge('t5', { metadata: { requestData: 7, responseData: null } }),
    today: edge('t5', { metadata: { sourceToTargetData: 7, targetToSourceData: null } }),
    note: 'older-data-direction',
  },
  {
    name: 'a single text on a Contains becomes a list too',
    until: '013',
    stored: edge('t6', {
      source: 'silo',
      target: 'mill',
      relation: 'Contains',
      metadata: { requestData: 'Grain' },
    }),
    today: edge('t6', {
      source: 'silo',
      target: 'mill',
      relation: 'Contains',
      metadata: { sourceToTargetData: ['Grain'] },
    }),
    note: 'older-data-direction',
  },
  // Before migration 018: Request Data and Response Data as lists.
  {
    name: 'the lists are named by direction',
    until: '018',
    stored: edge('l1', {
      label: '{Response Data}{request data} {{Request Data}}',
      directed: false,
      metadata: { requestData: ['Flour', 'Sugar'], responseData: ['Loaves'], zone: 'x' },
    }),
    today: edge('l1', {
      label: `${backward}${forward} {{Request Data}}`,
      directed: false,
      metadata: {
        sourceToTargetData: ['Flour', 'Sugar'],
        targetToSourceData: ['Loaves'],
        zone: 'x',
      },
    }),
    note: 'older-data-direction',
  },
  {
    name: 'an older list beside a new one stays as it is',
    until: '018',
    stored: edge('l2', { metadata: { requestData: ['Old'], sourceToTargetData: ['New'] } }),
    today: edge('l2', { metadata: { requestData: ['Old'], sourceToTargetData: ['New'] } }),
  },
  {
    name: 'a key inside another value stays',
    until: '018',
    stored: edge('l3', { metadata: { note: { requestData: ['x'] }, responseData: ['Moves'] } }),
    today: edge('l3', {
      metadata: { note: { requestData: ['x'] }, targetToSourceData: ['Moves'] },
    }),
    note: 'older-data-direction',
  },
];

/** A copy with every object's keys in order, so two edges compare whatever their key order. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, inner]) => [key, sorted(inner)]),
  );
}

/** An edge as stored rows hold it, with the metadata the store leaves out when empty. */
const comparable = (value: object | undefined): unknown =>
  sorted(value === undefined ? undefined : { metadata: {}, ...value });

/**
 * A model as an older API stored it: plain rows, which the tables have held in the same columns
 * since migration 001. Elements carry custom keys named like the older properties: those stay.
 */
async function storeRows(db: TestDb, edges: Edge[]): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into models (id, name, created_at, created_by_id, created_by_name, node_count,
       edge_count, graph, metadata, has_nodes, has_edges)
     values ($1::uuid, 'Made-up', '2026-10-01T00:00:00.000Z', $2, $3, $4, $5,
       '{"label":"Made-up"}'::jsonb, '{}'::jsonb, true, true)`,
    [id, author.id, author.name, Object.keys(nodes).length, edges.length],
  );
  for (const [ordinal, [key, node]] of Object.entries(nodes).entries()) {
    await db.query(
      `insert into elements (model_id, id, ordinal, type, label, metadata)
       values ($1::uuid, $2, $3, $4, $5, $6::jsonb)`,
      [id, key, ordinal, node.metadata.type, node.label, JSON.stringify(elementMetadata)],
    );
  }
  for (const [ordinal, stored] of edges.entries()) {
    await db.query(
      `insert into relationships (model_id, ordinal, id, source, target, relation, directed, label,
         metadata)
       values ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        id,
        ordinal,
        stored.id,
        stored.source,
        stored.target,
        stored.relation,
        stored.directed ?? null,
        stored.label ?? null,
        stored.metadata === undefined ? null : JSON.stringify(stored.metadata),
      ],
    );
  }
  return id;
}

const eras = [...new Set(rows.map((row) => row.until))];
/** Per era: the edges after every migration, as the rows hold them and as the store reads them. */
const upgraded = new Map<string, { rows: Map<string, Edge>; read: Map<string, JgfEdge> }>();
let current: TestDb;
const opened: TestDb[] = [];

beforeAll(async () => {
  for (const era of eras) {
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, before(era));
    const id = await storeRows(
      db,
      rows.filter((row) => row.until === era).map((row) => row.stored),
    );
    expect(await migrate(db, migrations)).toBe(migrations.length - before(era).length);
    const stored = await db.query<Edge & { metadata: unknown }>(
      `select id, source, target, relation, directed, label, metadata from relationships
       where model_id = $1::uuid order by ordinal`,
      [id],
    );
    const store = await PostgresModelStore.open(db, quiet);
    expect(await store.listDamaged()).toEqual([]);
    const read = (await store.get(id)) as JgfDocument;
    expect(validateJgf(read).valid).toBe(true);
    // Elements keep their own keys named like the older properties: they are custom metadata.
    const elements = await db.query<{ metadata: unknown }>(
      'select metadata from elements where model_id = $1::uuid',
      [id],
    );
    expect(elements.map((row) => row.metadata)).toEqual(
      Object.keys(nodes).map(() => elementMetadata),
    );
    upgraded.set(era, {
      rows: new Map(
        stored.map((row) => [
          String(row.id),
          Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)),
        ]),
      ),
      read: new Map((read.graph.edges ?? []).map((e) => [String(e.id), e])),
    });
  }
  current = await createTestDb();
  opened.push(current);
}, 120_000);

afterAll(async () => {
  await Promise.all(opened.map((db) => db.close()));
});

describe('older data, read today', () => {
  describe.each(rows)('$name (before migration $until)', (row) => {
    it('imports from an older file as today’s edge, with a note in the report', () => {
      const input = { graph: { label: 'Made-up', nodes, edges: [row.stored] } };
      const copy = structuredClone(input);
      const { document, validation } = validateImported(input);
      expect(input).toEqual(copy);
      expect(validation.valid).toBe(true);
      const [converted] = (document as JgfDocument).graph.edges ?? [];
      expect(comparable(converted)).toEqual(comparable(row.today));
      const notes = validation.warnings.filter((issue) => issue.code.startsWith('older-'));
      expect(notes.map((issue) => issue.code).filter((code) => code !== 'older-data-kept')).toEqual(
        row.note === undefined ? [] : [row.note],
      );
    });

    it('is today’s edge in a database brought up to date by the migrations', () => {
      const era = upgraded.get(row.until);
      expect(comparable(era?.rows.get(String(row.stored.id)))).toEqual(comparable(row.today));
      expect(comparable(era?.read.get(String(row.stored.id)))).toEqual(comparable(row.today));
    });

    it('reads as today’s edge, its label as stored, when an older API wrote it later', async () => {
      const id = await storeRows(current, [row.stored]);
      const store = await PostgresModelStore.open(current, quiet);
      const [read] = ((await store.get(id)) as JgfDocument).graph.edges ?? [];
      const label = row.stored.label;
      expect(comparable(read)).toEqual(
        comparable({ ...row.today, ...(label === undefined ? {} : { label }) }),
      );
      expect(await store.listDamaged()).toEqual([]);
    });
  });
});

describe('older files', () => {
  it('converts every older shape in one document, counting each relationship once', () => {
    const { converted, dataConverted, directionConverted } = convertOlderTypes({
      graph: { nodes, edges: rows.map((row) => row.stored) },
    });
    const count = (note: string) => rows.filter((row) => row.note === note).length;
    expect([converted, dataConverted, directionConverted]).toEqual([
      count('older-relationship-types'),
      count('older-data-property'),
      count('older-data-direction'),
    ]);
  });

  it('leaves today’s JGF as it is, and copes with any shape', () => {
    const today = { graph: { nodes, edges: rows.map((row) => row.today) } };
    expect(convertOlderTypes(today).document).toBe(today);
    for (const odd of [null, 3, 'x', [], {}, { graph: 1 }, { graph: { edges: 'x' } }]) {
      expect(convertOlderTypes(odd)).toEqual({
        document: odd,
        converted: 0,
        dataConverted: 0,
        directionConverted: 0,
      });
    }
    const bad = { graph: { edges: [7, null, { relation: 'Information flow', metadata: [1] }] } };
    expect((convertOlderTypes(bad).document as typeof bad).graph.edges[2]).toEqual({
      relation: 'Relation',
      metadata: [1],
    });
  });

  it('warns about an older key kept beside a new one, and never refuses it', () => {
    const { validation } = validateImported({
      graph: {
        nodes,
        edges: rows.filter((row) => row.name.includes('beside')).map((r) => r.stored),
      },
    });
    expect(validation.valid).toBe(true);
    expect(
      validation.warnings
        .filter((issue) => issue.code === 'older-data-kept' || issue.code === 'retired-property')
        .map((issue) => [issue.edgeId, issue.field]),
    ).toEqual([
      ['d2', 'metadata.data'],
      ['l2', 'metadata.requestData'],
    ]);
  });

  it('only an import converts: the plain check refuses the older types', () => {
    const older = {
      graph: { nodes, edges: rows.filter((row) => row.until === '006').map((r) => r.stored) },
    };
    expect(validateJgf(older).valid).toBe(false);
    expect(validateImported(older).validation.valid).toBe(true);
  });
});

describe('a database from before the licence was dropped (migration 007)', () => {
  it('loses only the licence table: its audit rows and the models stay', async () => {
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, before('007'));
    await db.query('update licence set licence_file = $1, latest_time_seen_ms = $2 where id = 1', [
      '{"payload":"bWFkZS11cA==","signature":"bWFkZS11cA=="}',
      1_000,
    ]);
    await db.query(
      `insert into audit (action, user_id, user_name, details)
       values ('licence-uploaded', 'oid-1', 'Made-up', $1)`,
      [JSON.stringify({ licenceId: 'made-up', type: 'annual', expiresAt: '2099-01-01' })],
    );
    const id = await storeRows(db, [edge('k', { label: 'Kept' })]);
    const audit = await db.query(
      'select id, action, user_id, user_name, details from audit order by id',
    );

    await migrate(db, migrations);

    const [licence] = await db.query<{ present: boolean }>(
      "select to_regclass('licence') is not null as present",
    );
    expect(licence?.present).toBe(false);
    expect(
      await db.query('select id, action, user_id, user_name, details from audit order by id'),
    ).toEqual(audit);
    expect(await db.query('select id from models')).toEqual([{ id }]);
    const store = await PostgresModelStore.open(db, quiet);
    expect(await store.listDamaged()).toEqual([]);
  });
});

describe('custom values from before references', () => {
  // Lists and objects a model could hold as custom metadata before references existed, some close
  // to the reference shape: each stays ordinary custom metadata, exactly as stored.
  const older = {
    list: ['bakery'],
    named: { reference: ['bakery'] },
    text: { [referenceKey]: 'bakery' },
    more: { [referenceKey]: ['bakery'], note: 'Made-up' },
  };

  it('imports from an older file unchanged, with nothing left out', () => {
    const file = {
      graph: {
        label: 'Made-up',
        nodes: { ...nodes, mill: { label: 'Mill', metadata: { type: 'Application', ...older } } },
      },
    };
    const { document, validation } = validateImported(file);
    expect(validation.valid).toBe(true);
    const imported = (document as JgfDocument).graph.nodes ?? {};
    const { nodes: kept, changes } = withImportableReferences(imported);
    expect(changes).toEqual([]);
    expect(kept.mill).toBe(imported.mill);
  });

  it('reads as stored from a database, and an element’s delete leaves them as they are', async () => {
    const id = await storeRows(current, []);
    await current.query(
      "update elements set metadata = $2::jsonb where model_id = $1::uuid and id = 'mill'",
      [id, JSON.stringify(older)],
    );
    const store = await PostgresModelStore.open(current, quiet);
    const read = (await store.get(id)) as JgfDocument;
    expect(read.graph.nodes?.mill?.metadata).toEqual({ type: 'Application', ...older });
    expect(await store.listDamaged()).toEqual([]);
    const graph = buildModelGraph(read);
    const mill = graph.elements.get('mill');
    expect(mill && elementReferences(mill)).toEqual([]);
    // Lists and objects are no filter fields, as before.
    expect(filterFields(graph).map((field) => field.key)).toEqual([
      'data',
      'informationFlow',
      'requestData',
    ]);

    const result = await new ElementService(store).deleteElement(
      id,
      'bakery',
      { version: 1 },
      author,
    );
    expect(result.referencesRemovedFrom).toEqual([]);
    expect(((await store.get(id)) as JgfDocument).graph.nodes?.mill?.metadata).toEqual({
      type: 'Application',
      ...older,
    });
  });
});

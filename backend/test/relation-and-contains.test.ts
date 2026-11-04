import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  buildModelGraph,
  relationshipViewFields,
  relationshipViewValues,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import type { RejectedError } from '../src/editing/common.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { convertOlderTypes, validateImported } from '../src/jgf/older-types.js';
import { validateJgf } from '../src/jgf/validate.js';
import { FileModelStore } from '../src/storage/file-model-store.js';
import { importFileModels } from '../src/storage/import-files.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { newSummary, storedDocument } from '../src/storage/stored-model.js';
import { tempDataDir } from './helpers.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Relation and Contains, Information flow as a property, and migration 006. Made-up data.

const author: ModelAuthor = { id: 'oid-29', name: 'Made-up Modeller' };

const nodes = {
  a: { label: 'A', metadata: { type: 'Application' } },
  b: { label: 'B', metadata: { type: 'Application' } },
  c: { label: 'C', metadata: { type: 'Infrastructure' } },
};

const older = {
  graph: {
    label: 'Made-up older model',
    nodes,
    edges: [
      { id: 'flow', source: 'a', target: 'b', relation: 'Information flow', label: 'Orders' },
      {
        id: 'both',
        source: 'a',
        target: 'c',
        relation: 'Information flow',
        directed: false,
        metadata: { architectureState: 'Target', protocol: 'REST' },
      },
      { source: 'b', target: 'c', relation: 'Integration', metadata: { auth: 'OAuth' } },
      { id: 'holds', source: 'c', target: 'a', relation: 'Contains' },
    ],
  },
};

describe('older JGF', () => {
  it('converts the types and keeps everything else, leaving the input alone', () => {
    const copy = structuredClone(older);
    const { document, converted } = convertOlderTypes(older);
    expect(converted).toBe(3);
    expect(older).toEqual(copy);
    expect((document as JgfDocument).graph.edges).toEqual([
      {
        id: 'flow',
        source: 'a',
        target: 'b',
        relation: 'Relation',
        label: 'Orders',
        metadata: { informationFlow: true },
      },
      {
        id: 'both',
        source: 'a',
        target: 'c',
        relation: 'Relation',
        directed: false,
        metadata: { architectureState: 'Target', protocol: 'REST', informationFlow: true },
      },
      { source: 'b', target: 'c', relation: 'Relation', metadata: { auth: 'OAuth' } },
      { id: 'holds', source: 'c', target: 'a', relation: 'Contains' },
    ]);
  });

  it('returns today’s JGF as it is, and copes with any shape', () => {
    const today = { graph: { nodes, edges: [] } };
    expect(convertOlderTypes(today).document).toBe(today);
    for (const odd of [null, 3, 'x', [], {}, { graph: 1 }, { graph: { edges: 'x' } }]) {
      expect(convertOlderTypes(odd)).toEqual({ document: odd, converted: 0 });
    }
    const bad = { graph: { edges: [7, null, { relation: 'Information flow', metadata: [1] }] } };
    expect((convertOlderTypes(bad).document as typeof bad).graph.edges[2]).toEqual({
      relation: 'Relation',
      metadata: [1],
    });
  });

  it('notes the conversion in the report, and validates what it stores', () => {
    const { document, validation } = validateImported(older);
    expect(validation.valid).toBe(true);
    expect(validation.warningCount).toBe(1);
    expect(validation.warnings[0]).toMatchObject({
      code: 'older-relationship-types',
      message:
        'Document: 3 relationships with the older type Information flow or Integration converted to Relation.',
    });
    expect(validation.summary.edges.byRelation).toEqual({ Relation: 3, Contains: 1 });
    expect(validateJgf(document).valid).toBe(true);
    // Only an import converts: the plain check still refuses the old names.
    expect(validateJgf(older).valid).toBe(false);
  });
});

describe('the Information flow property', () => {
  const withEdge = (relation: string, metadata: Record<string, unknown>) => ({
    graph: { nodes, edges: [{ id: 'e', source: 'a', target: 'b', relation, metadata }] },
  });

  it('is a warning when bad, and reads as no, so a stored model stays readable', () => {
    for (const value of ['yes', 1, null, ['x']]) {
      const document = withEdge('Relation', { informationFlow: value });
      const result = validateJgf(document);
      expect(result.valid).toBe(true);
      expect(result.warnings.map((issue) => [issue.code, issue.message])).toEqual([
        [
          'invalid-property-value',
          'Edge "e": metadata.informationFlow must be true or false; it is read as no',
        ],
      ]);
      const [relationship] = buildModelGraph(document).relationships;
      expect(relationship?.informationFlow).toBeUndefined();
      expect(relationship && relationshipViewValues(relationship, ['informationFlow'])).toEqual([]);
    }
  });

  it('accepts true and false on a Relation with no warning; only true is a yes', () => {
    expect(validateJgf(withEdge('Relation', { informationFlow: true })).warnings).toEqual([]);
    expect(validateJgf(withEdge('Relation', { informationFlow: false })).warnings).toEqual([]);
    const read = (value: boolean) =>
      buildModelGraph(withEdge('Relation', { informationFlow: value })).relationships[0];
    const yes = read(true);
    const no = read(false);
    expect(yes?.informationFlow).toBe(true);
    expect(no?.informationFlow).toBeUndefined();
    expect(yes && relationshipViewValues(yes, ['informationFlow'])).toEqual(['Information flow']);
    expect(no && relationshipViewValues(no, ['informationFlow'])).toEqual([]);
  });

  it('is a warning on a Contains, and reads as no', () => {
    const document = withEdge('Contains', { informationFlow: true });
    const result = validateJgf(document);
    expect(result.valid).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toEqual(['information-flow-not-for-type']);
    expect(buildModelGraph(document).relationships[0]?.informationFlow).toBeUndefined();
  });

  it('stays ordinary custom metadata on an element', () => {
    const document = {
      graph: {
        nodes: { a: { label: 'A', metadata: { type: 'Other', informationFlow: 'anything' } } },
      },
    };
    expect(validateJgf(document).warnings).toEqual([]);
  });

  it('is offered whenever the model has a Relation, and only then', () => {
    const fields = (document: JgfDocument) =>
      relationshipViewFields(buildModelGraph(document)).map((field) => field.label);
    expect(fields(withEdge('Relation', {}))).toEqual(['Architecture state', 'Information flow']);
    expect(fields(withEdge('Contains', {}))).toEqual([]);
    expect(fields(withEdge('Relation', { informationFlow: false, zone: 'x' }))).toEqual([
      'Architecture state',
      'Information flow',
      'zone',
    ]);
  });
});

// The columns of one relationship row, in order.
interface Row {
  ordinal: number;
  id: string | null;
  source: string;
  target: string;
  relation: string;
  directed: boolean | null;
  label: string | null;
  metadata: Record<string, unknown> | null;
  extra: unknown;
  version: number;
}

describe('migration 006', () => {
  // Up to the migration under test: a later one has its own tests.
  const all = loadMigrations().filter((migration) => migration.version <= '006');
  const before = all.filter((migration) => migration.version < '006');
  const modelIds = [
    'aaaaaaaa-0000-4000-8000-000000000001',
    'aaaaaaaa-0000-4000-8000-000000000002',
    'aaaaaaaa-0000-4000-8000-000000000003',
  ] as const;
  const [first, second, empty] = modelIds;
  let db: TestDb;

  const rows = (model: string) =>
    db.query<Row>(
      `select ordinal, id, source, target, relation, directed, label, metadata, extra, version
       from relationships where model_id = $1::uuid order by ordinal`,
      [model],
    );

  beforeAll(async () => {
    db = pgliteDb(new PGlite());
    await migrate(db, before);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.exec('drop table if exists schema_migrations');
    await db.exec(
      'drop table if exists models, elements, relationships, audit, sessions, branding, licence cascade',
    );
    await migrate(db, before);
    for (const [index, id] of modelIds.entries()) {
      await db.query(
        `insert into models (id, name, created_at, created_by_id, created_by_name, node_count,
           edge_count, graph, metadata, has_nodes, has_edges)
         values ($1::uuid, $2, $3, 'oid-1', 'Made-up', 3, $4, '{"directed":true}', '{}', true, true)`,
        [id, `Made-up ${index}`, `2026-01-0${index + 1}T00:00:00.000Z`, id === empty ? 0 : 7],
      );
      for (const [ordinal, element] of ['a', 'b', 'c'].entries()) {
        await db.query(
          `insert into elements (model_id, id, ordinal, type, label) values ($1::uuid, $2, $3, 'Application', $2)`,
          [id, element, ordinal],
        );
      }
    }
    const insert = (
      model: string,
      ordinal: number,
      id: string | null,
      relation: string,
      fields: { directed?: boolean; label?: string; metadata?: string; version?: number } = {},
    ) =>
      db.query(
        `insert into relationships (model_id, ordinal, id, source, target, relation, directed, label, metadata, version)
         values ($1::uuid, $2, $3, 'a', $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          model,
          ordinal,
          id,
          ordinal % 2 === 0 ? 'b' : 'c',
          relation,
          fields.directed ?? null,
          fields.label ?? null,
          fields.metadata ?? null,
          fields.version ?? 1,
        ],
      );
    await insert(first, 0, 'flow-none', 'Information flow', { label: 'Orders', version: 7 });
    await insert(first, 1, 'flow-both', 'Information flow', {
      directed: false,
      metadata: '{"architectureState":"Target","protocol":"REST","deep":{"list":[1,2]}}',
      version: 3,
    });
    await insert(first, 2, null, 'Information flow', { metadata: 'null' });
    await insert(first, 3, 'plain-both', 'Integration', { directed: false, label: 'API' });
    await insert(first, 4, 'plain', 'Integration', {
      directed: true,
      metadata: '{"architectureState":"Deprecate","auth":"OAuth"}',
      version: 2,
    });
    await insert(first, 5, 'holds', 'Contains', {
      metadata: '{"architectureState":"Current"}',
      version: 4,
    });
    await insert(first, 6, null, 'Integration');
    await insert(second, 0, 'holds', 'Contains');
    await insert(second, 1, 'flow', 'Information flow', { metadata: '{}' });
    await insert(second, 2, 'twice-1', 'Integration');
    await insert(second, 3, 'twice-2', 'Integration');
    await insert(second, 4, 'twice-3', 'Information flow');
    await insert(second, 5, 'twice-4', 'Information flow');
    await insert(second, 6, 'custom', 'Information flow', {
      metadata: '{"informationFlow":"was text"}',
    });
  });

  it('converts the two types and changes nothing else', async () => {
    const was = await rows(first);
    expect(await migrate(db, all)).toBe(1);
    const now = await rows(first);
    expect(now.map((row) => row.relation)).toEqual([
      'Relation',
      'Relation',
      'Relation',
      'Relation',
      'Relation',
      'Contains',
      'Relation',
    ]);
    expect(now.map((row) => row.metadata)).toEqual([
      { informationFlow: true },
      {
        architectureState: 'Target',
        protocol: 'REST',
        deep: { list: [1, 2] },
        informationFlow: true,
      },
      { informationFlow: true },
      null,
      { architectureState: 'Deprecate', auth: 'OAuth' },
      { architectureState: 'Current' },
      null,
    ]);
    // Id, order, ends, direction, label, version and extra stay.
    const others = (list: Row[]) =>
      list.map((row) => ({ ...row, relation: undefined, metadata: undefined }));
    expect(others(now)).toEqual(others(was));
  });

  it('leaves every model readable, none damaged, with the same order and direction', async () => {
    await migrate(db, all);
    const warnings: object[] = [];
    const store = await PostgresModelStore.open(db, {
      log: { warn: (details) => warnings.push(details) },
    });
    expect((await store.list()).map((summary) => summary.id).sort()).toEqual([...modelIds].sort());
    expect(await store.listDamaged()).toEqual([]);
    expect(warnings).toEqual([]);
    for (const id of modelIds) {
      const document = await store.get(id);
      if (document === undefined) throw new Error('model gone');
      expect(validateJgf(document).valid).toBe(true);
    }
    const graph = buildModelGraph((await store.get(first)) as JgfDocument);
    expect(
      graph.relationships.map((r) => [r.id, r.type, r.informationFlow ?? false, r.twoWay ?? false]),
    ).toEqual([
      ['flow-none', 'Relation', true, false],
      ['flow-both', 'Relation', true, true],
      ['edges[2]', 'Relation', true, false],
      ['plain-both', 'Relation', false, true],
      ['plain', 'Relation', false, false],
      ['holds', 'Contains', false, false],
      ['edges[6]', 'Relation', false, false],
    ]);
    expect(graph.relationships[0]?.label).toBe('Orders');
  });

  it('makes a custom text key of that name a yes on a flow, and a read-as-no on the rest', async () => {
    await db.query(
      `update relationships set metadata = '{"informationFlow":"was text"}'
       where model_id = $1::uuid and id = 'twice-1'`,
      [second],
    );
    await migrate(db, all);
    const now = await rows(second);
    expect(now.find((row) => row.id === 'custom')?.metadata).toEqual({ informationFlow: true });
    const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    const document = (await store.get(second)) as JgfDocument;
    expect(validateJgf(document).valid).toBe(true);
    expect(
      buildModelGraph(document).relationships.find((r) => r.id === 'twice-1')?.informationFlow,
    ).toBeUndefined();
  });

  it('lets a migrated relationship be edited with the version it had', async () => {
    await migrate(db, all);
    const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    const service = new RelationshipService(store);
    const stale = service.updateRelationship(
      first,
      'flow-none',
      { version: 1, informationFlow: false },
      author,
    );
    await expect(stale).rejects.toThrow();
    const saved = await service.updateRelationship(
      first,
      'flow-none',
      { version: 7, informationFlow: false },
      author,
    );
    expect(saved.relationship.version).toBe(8);
    expect(saved.relationship.edge.metadata).toEqual({});
    // Several Relations with the same ends stay, and merge only on the UI.
    const twoAlike = (await rows(second)).filter((row) => row.id?.startsWith('twice'));
    expect(twoAlike).toHaveLength(4);
  });

  it('runs once, and an older API then refuses the database', async () => {
    await migrate(db, all);
    const once = await rows(first);
    expect(await migrate(db, all)).toBe(0);
    expect(await rows(first)).toEqual(once);
    await expect(migrate(db, before)).rejects.toThrow(/doesn't know/);
  });

  it('changes nothing if the transaction fails', async () => {
    const was = await rows(first);
    const broken = { version: '999', name: 'broken', sql: 'select from nowhere', checksum: 'x' };
    await expect(migrate(db, [...all, broken])).rejects.toThrow();
    expect(await rows(first)).toEqual(was);
    const applied = await db.query<{ version: string }>('select version from schema_migrations');
    expect(applied.map((row) => row.version)).not.toContain('006');
  });

  it('keeps a model of an unknown type listed as damaged, as before', async () => {
    await db.query(
      `update relationships set relation = 'Telepathy' where model_id = $1::uuid and ordinal = 0`,
      [second],
    );
    await migrate(db, all);
    const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    expect(await store.listDamaged()).toEqual([second]);
    expect((await rows(second))[0]?.relation).toBe('Telepathy');
  });

  it('reads an older type written after the migration, by an API still running, as today’s', async () => {
    await migrate(db, all);
    await db.query(
      `update relationships set relation = 'Information flow', metadata = null
       where model_id = $1::uuid and id = 'flow'`,
      [second],
    );
    const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    expect(await store.listDamaged()).toEqual([]);
    const edges = (await store.get(second))?.graph.edges ?? [];
    expect(edges.find((edge) => edge.id === 'flow')).toMatchObject({
      relation: 'Relation',
      metadata: { informationFlow: true },
    });
  });

  it('db:import-files brings an older file in converted, with none damaged', async () => {
    const parent = tempDataDir();
    const dir = join(parent, 'models');
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const id = 'bbbbbbbb-0000-4000-8000-000000000001';
      const document = older as unknown as JgfDocument;
      const stored = storedDocument(document, newSummary(id, document, author, 0));
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(stored), { mode: 0o600 });
      const files = await FileModelStore.open(dir, { log: { warn: () => undefined } });
      expect(await files.listDamaged()).toEqual([]);
      expect((await files.list()).map((summary) => summary.id)).toEqual([id]);
      const read = await files.get(id);
      expect(read?.graph.edges?.map((edge) => edge.relation)).toEqual([
        'Relation',
        'Relation',
        'Relation',
        'Contains',
      ]);

      await migrate(db, all);
      const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
      expect(await importFileModels(files, store)).toMatchObject({
        found: 1,
        imported: 1,
        damaged: 0,
        failed: 0,
        relationships: 4,
      });
      const edges = (await store.get(id))?.graph.edges;
      expect(edges?.[1]).toMatchObject({
        relation: 'Relation',
        directed: false,
        metadata: { informationFlow: true, protocol: 'REST', architectureState: 'Target' },
      });
      expect(edges?.[2]?.relation).toBe('Relation');
      expect(edges?.[3]?.relation).toBe('Contains');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('RelationshipService: Information flow', () => {
  let db: TestDb;
  const model: JgfDocument = {
    graph: {
      nodes,
      edges: [
        {
          id: 'flow',
          source: 'a',
          target: 'b',
          relation: 'Relation',
          directed: false,
          metadata: { informationFlow: true, zone: 'x' },
        },
        { id: 'plain', source: 'a', target: 'c', relation: 'Relation' },
        { id: 'holds', source: 'c', target: 'b', relation: 'Contains' },
      ],
    },
  };

  beforeAll(async () => {
    db = pgliteDb(new PGlite());
    await migrate(db, loadMigrations());
  });

  afterAll(async () => {
    await db.close();
  });

  const setup = async () => {
    await db.exec('truncate models, elements, relationships, audit');
    const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    const { id } = await store.save(model, author);
    return { service: new RelationshipService(store), id };
  };
  const refused = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => (error as RejectedError).fields,
    );
  const fieldsOfLastAudit = async () => {
    const rows = await db.query<{ details: { fields: string[] } }>(
      'select details from audit order by id desc limit 1',
    );
    return rows[0]?.details.fields;
  };

  it('adds a flow and a plain Relation between the same two elements', async () => {
    const { service, id } = await setup();
    const ends = { source: 'a', target: 'b', type: 'Relation' };
    const flow = await service.addRelationship(id, { ...ends, informationFlow: true }, author);
    expect(flow.relationship.edge.metadata).toMatchObject({ informationFlow: true });
    expect(await fieldsOfLastAudit()).toContain('informationFlow');
    const plain = await service.addRelationship(id, { ...ends, informationFlow: false }, author);
    expect(plain.relationship.edge.metadata).not.toHaveProperty('informationFlow');
    // A second of the same kind is fine as well.
    await expect(service.addRelationship(id, ends, author)).resolves.toBeDefined();
  });

  it('refuses a yes on a Contains, naming the field', async () => {
    const { service, id } = await setup();
    const expected = [
      { field: 'informationFlow', message: "A Contains can't have Information flow." },
    ];
    expect(
      await refused(
        service.addRelationship(
          id,
          { source: 'a', target: 'c', type: 'Contains', informationFlow: true },
          author,
        ),
      ),
    ).toEqual(expected);
    expect(
      await refused(
        service.updateRelationship(id, 'holds', { version: 1, informationFlow: true }, author),
      ),
    ).toEqual(expected);
    expect(
      await refused(
        service.updateRelationship(
          id,
          'plain',
          { version: 1, type: 'Contains', informationFlow: true },
          author,
        ),
      ),
    ).toEqual(expected);
  });

  it('ticks and unticks, removing the key on a no and keeping the rest', async () => {
    const { service, id } = await setup();
    const off = await service.updateRelationship(
      id,
      'flow',
      { version: 1, informationFlow: false },
      author,
    );
    expect(off.relationship.edge.metadata).toEqual({ zone: 'x' });
    expect(off.relationship.edge.directed).toBe(false);
    expect(await fieldsOfLastAudit()).toEqual(['informationFlow']);
    const on = await service.updateRelationship(
      id,
      'flow',
      { version: 2, informationFlow: true },
      author,
    );
    expect(on.relationship.edge.metadata).toEqual({ zone: 'x', informationFlow: true });
    const same = await service.updateRelationship(
      id,
      'flow',
      { version: 3, informationFlow: true },
      author,
    );
    expect(same.relationship.version).toBe(3);
  });

  it('removes the key on a change to Contains, and causes no warning', async () => {
    const { service, id } = await setup();
    const result = await service.updateRelationship(
      id,
      'flow',
      { version: 1, type: 'Contains' },
      author,
    );
    expect(result.relationship.edge.metadata).toEqual({ zone: 'x' });
    expect(result.warnings.map((issue) => issue.code)).not.toContain(
      'information-flow-not-for-type',
    );
  });

  it('never takes the key through custom metadata', async () => {
    const { service, id } = await setup();
    for (const value of [true, 'yes', null]) {
      expect(
        await refused(
          service.updateRelationship(
            id,
            'plain',
            { version: 1, metadata: { informationFlow: value } },
            author,
          ),
        ),
      ).toEqual([{ field: 'metadata.informationFlow', message: 'Set this in its own field.' }]);
    }
  });
});

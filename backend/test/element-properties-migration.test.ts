import { PGlite } from '@electric-sql/pglite';
import {
  buildModelGraph,
  elementValueFit,
  filterFields,
  referenceKey,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { upgradeSteps } from '../src/db/upgrades.js';
import { ElementService } from '../src/editing/element-service.js';
import { validateJgf } from '../src/jgf/validate.js';
import { readElementDefinitions } from '../src/properties/property-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Element properties come with migration 020 and its upgrade step, on a database that has run 001
// to 019 with made-up models holding custom metadata on elements: text keys, Reference keys, keys
// holding both, and odd values.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '020');
const through019 = all.filter((migration) => migration.version <= '019');
const quiet = { log: { warn: () => undefined } };
const ref = (...ids: string[]) => ({ [referenceKey]: ids });

// Made up: a harbour with cranes and a ledger.
const harbour: JgfDocument = {
  graph: {
    label: 'Made-up harbour',
    nodes: {
      crane: {
        label: 'Crane',
        metadata: {
          type: 'Infrastructure',
          owningTeam: 'Quay team',
          berth: 'B-1',
          servedBy: ref('ledger'),
          mixed: ref('ledger'),
          archimateType: 'Node',
          tags: ['heavy', 'old'],
          'Owning team': 'a key named like a standard property',
          'gate {north}': 'braces in the key',
        },
      },
      ledger: {
        label: 'Ledger',
        metadata: {
          type: 'Application',
          berth: 'B-2',
          mixed: 'text in another element',
          lookalike: { [referenceKey]: 'not a list' },
        },
      },
      pilot: {
        label: 'Pilot',
        // Sourcing is standard on Applications only: on a Stakeholder it was a property.
        metadata: { type: 'Stakeholder', sourcing: 'Buy', servedBy: ref('crane', 'ledger') },
      },
    },
    edges: [{ id: 'h1', source: 'pilot', target: 'crane', relation: 'Relation' }],
  },
};

// Made up: a second model, where a key is a Reference in the first but text here.
const ferry: JgfDocument = {
  graph: {
    label: 'Made-up ferry',
    nodes: {
      deck: { label: 'Deck', metadata: { type: 'Other', Berth: 'upper case', empty: {} } },
      ramp: { label: 'Ramp', metadata: { type: 'Other', lookalike: ref('deck'), blank: null } },
    },
  },
};

let db: TestDb | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

async function at019(): Promise<{ db: TestDb; ids: string[] }> {
  db = pgliteDb(new PGlite());
  await migrate(db, through019);
  const store = await PostgresModelStore.open(db, quiet);
  const ids = [(await store.save(harbour, author)).id, (await store.save(ferry, author)).id];
  return { db, ids };
}

const dump = async (target: TestDb) => ({
  models: await target.query('select * from models order by id'),
  elements: await target.query('select * from elements order by model_id, ordinal'),
  relationships: await target.query('select * from relationships order by model_id, ordinal'),
  audit: await target.query('select id, action, user_id, model_id, details from audit order by id'),
});

const text = (key: string, name = key) => ({
  key,
  name,
  kind: 'text',
  fromModels: true,
  version: 1,
});
const reference = (key: string) => ({ ...text(key), kind: 'reference' });

describe('migration 020 and its upgrade step', () => {
  it('runs once on a database at 019, and is plain ASCII', async () => {
    const { db: target } = await at019();
    const migration = all.find((each) => each.version === '020');
    expect(migration?.name).toBe('element_properties');
    expect(migration?.sql).toMatch(/^[\t\n\x20-\x7e]*$/);
    expect(upgradeSteps.has('020_element_properties')).toBe(true);
    expect(await migrate(target, all)).toBe(1);
    expect(await migrate(target, all)).toBe(0);
  });

  it('defines every custom key on elements: all-Reference keys as Reference, any other as Text', async () => {
    const { db: target } = await at019();
    await migrate(target, all);
    expect(await readElementDefinitions(target)).toEqual([
      text('archimateType'),
      // Keys are taken exactly: `Berth` and `berth` are two properties, named apart.
      text('Berth'),
      text('berth', 'berth (2)'),
      // Nothing but JSON null: not a Reference.
      text('blank'),
      // An empty object holds no list: not a Reference.
      text('empty'),
      text('gate {north}', 'gate north'),
      // A Reference in one model and another shape in the other: Text.
      text('lookalike'),
      // A Reference on one element and text on another: Text, the Reference read as not this kind.
      text('mixed'),
      // A standard property's name is taken: the key keeps its own spelling, with a number.
      text('Owning team', 'Owning team (2)'),
      reference('servedBy'),
      // A list is kept, and reads as not this kind.
      text('tags'),
    ]);
    const keys = (await readElementDefinitions(target)).map((definition) => definition.key);
    // Standard properties of any type (on their type, or kept from another) and the type: none.
    for (const key of ['owningTeam', 'sourcing', 'type', 'description']) {
      expect(keys).not.toContain(key);
    }
  });

  it('changes no model: every row stays as it was, and every model reads and validates', async () => {
    const { db: target, ids } = await at019();
    const before = await dump(target);
    const exports = await Promise.all(
      ids.map(async (id) => (await PostgresModelStore.open(target, quiet)).get(id)),
    );
    await migrate(target, all);
    expect(await dump(target)).toEqual(before);
    const store = await PostgresModelStore.open(target, quiet);
    expect(await store.listDamaged()).toEqual([]);
    for (const [index, id] of ids.entries()) {
      const document = await store.get(id);
      expect(document).toEqual(exports[index]);
      expect(validateJgf(document).valid).toBe(true);
    }
  });

  it('reads the mixed values as stored, under their kinds, after the upgrade', async () => {
    const { db: target, ids } = await at019();
    await migrate(target, all);
    const definitions = await readElementDefinitions(target);
    const store = await PostgresModelStore.open(target, quiet);
    const graph = buildModelGraph((await store.get(ids[0] ?? '')) as JgfDocument, [], definitions);
    const mixed = definitions.find((definition) => definition.key === 'mixed');
    const crane = graph.elements.get('crane');
    const ledger = graph.elements.get('ledger');
    expect(mixed && elementValueFit(mixed, crane?.metadata.mixed)).toBe('not-this-kind');
    expect(mixed && elementValueFit(mixed, ledger?.metadata.mixed)).toBe('fits');
    // The filters offer the Text properties by name (a Reference property, never).
    const fields = filterFields(graph).map((field) => field.key);
    expect(fields).toEqual(expect.arrayContaining(['archimateType', 'berth', 'mixed']));
    expect(fields).not.toContain('servedBy');
  });

  it('lets the upgraded elements be edited: a kept Reference stays, a new key is refused', async () => {
    const { db: target, ids } = await at019();
    await migrate(target, all);
    const store = await PostgresModelStore.open(target, quiet);
    const service = new ElementService(store);
    const modelId = ids[0] ?? '';
    const kept = await service.updateElement(
      modelId,
      'crane',
      { version: 1, name: 'Big crane', metadata: { mixed: ref('ledger'), berth: 'B-3' } },
      author,
    );
    expect(kept.element.node.metadata).toMatchObject({ mixed: ref('ledger'), berth: 'B-3' });
    await expect(
      service.updateElement(modelId, 'crane', { version: 2, metadata: { pier: '4' } }, author),
    ).rejects.toThrow('The change is not valid');
  });

  it('leaves migration 016’s relationship properties as they were', async () => {
    const { db: target } = await at019();
    const before = await target.query('select * from relationship_properties order by key');
    await migrate(target, all);
    expect(await target.query('select * from relationship_properties order by key')).toEqual(
      before,
    );
  });

  it('rolls back with its migration when the step fails, so 020 runs again next time', async () => {
    const { db: target } = await at019();
    const failing = new Map([
      [
        '020_element_properties',
        async () => {
          throw new Error('made-up failure');
        },
      ],
    ]);
    await expect(migrate(target, all, failing)).rejects.toThrow('made-up failure');
    const [table] = await target.query<{ present: boolean }>(
      "select to_regclass('element_properties') is not null as present",
    );
    expect(table?.present).toBe(false);
    expect(await migrate(target, all)).toBe(1);
  });
});

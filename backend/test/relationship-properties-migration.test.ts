import { PGlite } from '@electric-sql/pglite';
import type { JgfDocument, ModelAuthor } from '@simplearchitecture/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { upgradeSteps } from '../src/db/upgrades.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { validateJgf } from '../src/jgf/validate.js';
import { readDefinitions } from '../src/properties/property-store.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { pgliteDb, type TestDb } from './pglite.js';

// Defined properties come with migration 016 and its upgrade step, on a database that has run 001
// to 015 with made-up models holding custom metadata on relationships and on elements.

const author: ModelAuthor = { id: 'oid-made-up', name: 'Made-up author' };
const all = loadMigrations().filter((migration) => migration.version <= '016');
const through015 = all.filter((migration) => migration.version <= '015');
const quiet = { log: { warn: () => undefined } };

// Made up: a library with a lending desk and a catalogue.
const library: JgfDocument = {
  graph: {
    label: 'Made-up library',
    nodes: {
      reader: { label: 'Reader', metadata: { type: 'Stakeholder', shelfMark: 'R-1' } },
      desk: { label: 'Lending desk', metadata: { type: 'Application', tier: 'element-tier' } },
      catalogue: { label: 'Catalogue', metadata: { type: 'Application', owner: 'Made-up' } },
      building: { label: 'Building', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      {
        id: 'l1',
        source: 'reader',
        target: 'desk',
        relation: 'Relation',
        label: 'Borrows {tier}',
        metadata: {
          tier: 'Gold',
          identity: 'Library card',
          archimateType: 'Serving',
          Identity: 'clash with a standard name',
          owningTeam: 'Made-up desk team',
          type: 'reserved',
        },
      },
      {
        id: 'l2',
        source: 'desk',
        target: 'catalogue',
        relation: 'Relation',
        metadata: { tier: 'Silver', Tier: 'upper case', data: 'retired', count: 3 },
      },
      {
        id: 'l3',
        source: 'building',
        target: 'desk',
        relation: 'Contains',
        metadata: { legacyId: 'B-7', requestData: ['kept on a Contains'] },
      },
    ],
  },
};

// Made up: a second model with a key the first doesn't have, and odd metadata.
const garden: JgfDocument = {
  graph: {
    label: 'Made-up garden',
    nodes: {
      gardener: { label: 'Gardener', metadata: { type: 'Stakeholder' } },
      shed: { label: 'Shed', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      {
        id: 'g1',
        source: 'gardener',
        target: 'shed',
        relation: 'Relation',
        metadata: { 'watering {can}': 'daily', tier: 'Gold' },
      },
      { id: 'g2', source: 'shed', target: 'gardener', relation: 'Relation' },
    ],
  },
};

let db: TestDb | undefined;

afterEach(async () => {
  await db?.close();
  db = undefined;
});

/** A database at 015 with the two models, stored by the app as it was. */
async function at015(): Promise<{ db: TestDb; store: PostgresModelStore; ids: string[] }> {
  db = pgliteDb(new PGlite());
  await migrate(db, through015);
  const store = await PostgresModelStore.open(db, quiet);
  const ids = [(await store.save(library, author)).id, (await store.save(garden, author)).id];
  return { db, store, ids };
}

const dump = async (target: TestDb) => ({
  models: await target.query('select * from models order by id'),
  elements: await target.query('select * from elements order by model_id, ordinal'),
  relationships: await target.query('select * from relationships order by model_id, ordinal'),
  audit: await target.query('select id, action, user_id, model_id, details from audit order by id'),
});

describe('migration 016 and its upgrade step', () => {
  it('runs once on a database at 015, and is plain ASCII', async () => {
    const { db: target } = await at015();
    const migration = all.find((each) => each.version === '016');
    expect(migration?.name).toBe('relationship_properties');
    expect(migration?.sql).toMatch(/^[\t\n\x20-\x7e]*$/);
    expect(upgradeSteps.has('016_relationship_properties')).toBe(true);
    expect(await migrate(target, all)).toBe(1);
    expect(await migrate(target, all)).toBe(0);
  });

  it('defines every custom key on relationships as a text property from models, and no other', async () => {
    const { db: target } = await at015();
    await migrate(target, all);
    const definitions = await readDefinitions(target);
    expect(definitions).toEqual([
      { key: 'archimateType', name: 'archimateType', kind: 'text', fromModels: true, version: 1 },
      { key: 'count', name: 'count', kind: 'text', fromModels: true, version: 1 },
      // A standard property's name is taken: the key keeps its own spelling, with a number.
      { key: 'Identity', name: 'Identity (2)', kind: 'text', fromModels: true, version: 1 },
      { key: 'legacyId', name: 'legacyId', kind: 'text', fromModels: true, version: 1 },
      // A key standard on elements only is custom on a relationship.
      { key: 'owningTeam', name: 'owningTeam', kind: 'text', fromModels: true, version: 1 },
      // Keys from models are taken exactly: `Tier` and `tier` are two properties, named apart
      // (in the keys' order).
      { key: 'Tier', name: 'Tier', kind: 'text', fromModels: true, version: 1 },
      { key: 'tier', name: 'tier (2)', kind: 'text', fromModels: true, version: 1 },
      // Braces can't be in a name: they would read as a label expression.
      { key: 'watering {can}', name: 'watering can', kind: 'text', fromModels: true, version: 1 },
    ]);
    const keys = definitions.map((definition) => definition.key);
    // Standard (identity, requestData), reserved (type) and retired (data) keys stay as they are.
    for (const key of ['identity', 'requestData', 'type', 'data', 'description']) {
      expect(keys).not.toContain(key);
    }
    // Element metadata is never looked at.
    for (const key of ['shelfMark', 'owner']) expect(keys).not.toContain(key);
  });

  it('changes no model: every row stays as it was and every model still validates', async () => {
    const { db: target, ids } = await at015();
    const before = await dump(target);
    const exports = await Promise.all(
      ids.map(async (id) => (await PostgresModelStore.open(target, quiet)).get(id)),
    );
    await migrate(target, all);
    expect(await dump(target)).toEqual(before);
    const store = await PostgresModelStore.open(target, quiet);
    expect(await store.listDamaged()).toEqual([]);
    expect((await store.list()).map((model) => model.id).sort()).toEqual([...ids].sort());
    for (const [index, id] of ids.entries()) {
      const document = await store.get(id);
      expect(document).toEqual(exports[index]);
      expect(validateJgf(document).valid).toBe(true);
    }
    // Element metadata untouched.
    expect(await target.query('select * from elements order by model_id, ordinal')).toEqual(
      before.elements,
    );
  });

  it('lets a stored relationship with old custom metadata open and be edited afterwards', async () => {
    const { db: target, ids } = await at015();
    await migrate(target, all);
    const store = await PostgresModelStore.open(target, quiet);
    const service = new RelationshipService(store);
    const modelId = ids[0] ?? '';
    const opened = await service.getRelationship(modelId, 'l1');
    expect(opened.relationship.edge.metadata).toMatchObject({
      tier: 'Gold',
      archimateType: 'Serving',
    });
    // Its values can change and be removed; a key nobody defined can't be added.
    const changed = await service.updateRelationship(
      modelId,
      'l1',
      { version: 1, metadata: { tier: 'Platinum', archimateType: null } },
      author,
    );
    expect(changed.relationship.edge.metadata).toMatchObject({ tier: 'Platinum' });
    expect(changed.relationship.edge.metadata).not.toHaveProperty('archimateType');
    await expect(
      service.updateRelationship(
        modelId,
        'l1',
        { version: 2, metadata: { brandNew: 'x' } },
        author,
      ),
    ).rejects.toMatchObject({
      fields: [
        {
          field: 'metadata.brandNew',
          message: "“brandNew” isn't a property here. An Admin can add it in Admin → Properties.",
        },
      ],
    });
  });

  it('runs only with its migration: a property deleted afterwards is not added again', async () => {
    const { db: target } = await at015();
    await migrate(target, all);
    await target.query("delete from relationship_properties where key = 'count'");
    expect(await migrate(target, all)).toBe(0);
    const keys = (await readDefinitions(target)).map((definition) => definition.key);
    expect(keys).not.toContain('count');
  });

  it('rolls back with its migration when the step fails, and runs clean afterwards', async () => {
    const { db: target } = await at015();
    const failing = new Map([
      [
        '016_relationship_properties',
        () => {
          throw new Error('made-up failure in the step');
        },
      ],
    ]);
    await expect(migrate(target, all, failing)).rejects.toThrow('made-up failure');
    expect(
      await target.query("select to_regclass('relationship_properties') is not null as present"),
    ).toEqual([{ present: false }]);
    expect(await migrate(target, all)).toBe(1);
    expect((await readDefinitions(target)).length).toBeGreaterThan(0);
  });

  it('defines nothing on a database without models', async () => {
    db = pgliteDb(new PGlite());
    await migrate(db, all);
    expect(await readDefinitions(db)).toEqual([]);
  });
});

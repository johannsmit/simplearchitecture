import {
  buildModelGraph,
  canBeTwoWay,
  describeRelationship,
  relationshipGroups,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RejectedError } from '../src/editing/common.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { validateJgf } from '../src/jgf/validate.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

// Two-way relationships: JGF `"directed": false`. Made-up data only.

const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };

const garden: JgfDocument = {
  graph: {
    label: 'Made-up garden',
    nodes: {
      pond: { label: 'Pond', metadata: { type: 'Infrastructure' } },
      pump: { label: 'Pump', metadata: { type: 'Application' } },
      shed: { label: 'Shed', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      {
        id: 'flow',
        source: 'pond',
        target: 'pump',
        relation: 'Relation',
        metadata: { informationFlow: true },
        directed: false,
      },
      { id: 'link', source: 'pump', target: 'shed', relation: 'Relation', directed: true },
      { id: 'holds', source: 'shed', target: 'pump', relation: 'Contains' },
    ],
  },
};

describe('the metamodel and validation', () => {
  it('lets a Relation be two-way, never Contains', () => {
    expect(canBeTwoWay('Relation')).toBe(true);
    expect(canBeTwoWay('Contains')).toBe(false);
  });

  it('accepts directed false on flow and integration without any issue', () => {
    const result = validateJgf(garden);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('warns about a two-way Contains, never an error, and reads it as one-way', () => {
    const document: JgfDocument = {
      graph: {
        ...garden.graph,
        edges: [
          { id: 'holds', source: 'shed', target: 'pump', relation: 'Contains', directed: false },
        ],
      },
    };
    const result = validateJgf(document);
    expect(result.valid).toBe(true);
    expect(result.warnings.map((issue) => [issue.edgeId, issue.field, issue.code])).toEqual([
      ['holds', 'directed', 'one-way-only'],
    ]);
    expect(buildModelGraph(document).relationships[0]?.twoWay).toBeUndefined();
  });

  it('reads two-way relationships into the graph, with "both ways" words', () => {
    const graph = buildModelGraph(garden);
    expect(graph.relationships.map((r) => [r.id, r.twoWay === true])).toEqual([
      ['flow', true],
      ['link', false],
      ['holds', false],
    ]);
    const flow = graph.relationships[0];
    if (!flow) throw new Error('fixture');
    expect(describeRelationship(graph, flow)).toBe('"Pond" relates both ways to "Pump"');
    // From either end, a two-way relationship is in one "both ways" group.
    for (const id of ['pond', 'pump']) {
      const group = relationshipGroups(graph, id).find(
        (g) => g.type === 'Relation' && g.direction === 'both',
      );
      expect(group?.direction).toBe('both');
      expect(group?.heading).toBe('Relates both ways to');
    }
    expect(
      relationshipGroups(graph, 'shed').map((group) => [group.heading, group.rows.length]),
    ).toEqual([
      ['Is related to', 1],
      ['Contains', 1],
    ]);
  });
});

describe('RelationshipService: direction', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetTestDb(db);
  });

  async function setup() {
    const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    const summary = await store.save(garden, modeller);
    return { store, service: new RelationshipService(store), modelId: summary.id };
  }
  const audit = () =>
    db.query<{ action: string; details: { fields: string[] } }>(
      'select action, details from audit order by id',
    );

  it('saves both ways and one way as directed, with the version and the field name', async () => {
    const { service, modelId } = await setup();
    const both = await service.updateRelationship(
      modelId,
      'link',
      { version: 1, twoWay: true },
      modeller,
    );
    expect(both.relationship).toMatchObject({ version: 2, edge: { directed: false } });
    const one = await service.updateRelationship(
      modelId,
      'flow',
      { version: 1, twoWay: false },
      modeller,
    );
    expect(one.relationship.edge.directed).toBe(true);
    // Unchanged: nothing is stored.
    const same = await service.updateRelationship(
      modelId,
      'link',
      { version: 2, twoWay: true },
      modeller,
    );
    expect(same.relationship.version).toBe(2);
    const rows = await audit();
    expect(rows.map((row) => row.details.fields)).toEqual([['directed'], ['directed']]);
    expect(JSON.stringify(rows)).not.toContain('false');
    await expect(
      service.updateRelationship(modelId, 'link', { version: 1, twoWay: false }, modeller),
    ).rejects.toMatchObject({ currentVersion: 2 });
  });

  it('makes a relationship one way when its type becomes Contains', async () => {
    const { service, modelId } = await setup();
    const result = await service.updateRelationship(
      modelId,
      'flow',
      { version: 1, type: 'Contains' },
      modeller,
    );
    expect(result.relationship.edge).toMatchObject({ relation: 'Contains', directed: true });
    expect((await audit())[0]?.details.fields).toEqual(['type', 'directed']);
  });

  it('refuses both ways on Contains', async () => {
    const { service, modelId } = await setup();
    const error: unknown = await service
      .updateRelationship(modelId, 'holds', { version: 1, twoWay: true }, modeller)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RejectedError);
    expect((error as RejectedError).fields).toEqual([
      { field: 'twoWay', message: 'Contains is always one way.' },
    ]);
    expect(await audit()).toEqual([]);
  });
});

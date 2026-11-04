import {
  buildModelGraph,
  containerOf,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };

// Made up, as an old import could leave it: a self-relationship, a Contains cycle (a, b), and a
// target (shed) with two containers whose ids sort against their order in the model.
const awkward: JgfDocument = {
  graph: {
    label: 'Made-up awkward farm',
    directed: true,
    nodes: {
      a: { label: 'A', metadata: { type: 'Infrastructure' } },
      b: { label: 'B', metadata: { type: 'Infrastructure' } },
      c1: { label: 'C one', metadata: { type: 'Infrastructure' } },
      c2: { label: 'C two', metadata: { type: 'Infrastructure' } },
      shed: { label: 'Shed', metadata: { type: 'Infrastructure' } },
    },
    edges: [
      { id: 'z-self', source: 'a', target: 'a', relation: 'Relation' },
      { id: 'y-ab', source: 'a', target: 'b', relation: 'Contains' },
      { id: 'x-ba', source: 'b', target: 'a', relation: 'Contains' },
      { id: 'w-first', source: 'c2', target: 'shed', relation: 'Contains' },
      { id: 'a-second', source: 'c1', target: 'shed', relation: 'Contains' },
    ],
  },
};

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

const open = () => PostgresModelStore.open(db, { log: { warn: () => undefined } });

describe('stored models that break the Modelling rules', () => {
  it('stay readable; state and description of their relationships can still be edited', async () => {
    const store = await open();
    const { id } = await store.save(awkward, modeller);
    const service = new RelationshipService(store);

    for (const relationshipId of ['z-self', 'y-ab', 'a-second']) {
      const { relationship } = await service.getRelationship(id, relationshipId);
      const result = await service.updateRelationship(
        id,
        relationshipId,
        { version: relationship.version, architectureState: 'Target', description: 'Made-up note' },
        modeller,
      );
      expect(result.relationship.edge.metadata).toMatchObject({
        architectureState: 'Target',
        description: 'Made-up note',
      });
    }
    const reloaded = await (await open()).get(id);
    expect(reloaded).toBeDefined();
    expect(reloaded?.graph.edges?.map((edge) => edge.id)).toEqual([
      'z-self',
      'y-ab',
      'x-ba',
      'w-first',
      'a-second',
    ]);
  });

  it('nests in the first container in the model order, also after adds, deletes and a reload', async () => {
    const store = await open();
    const { id } = await store.save(awkward, modeller);
    const service = new RelationshipService(store);
    const nested = async () => {
      const document = await (await open()).get(id);
      if (!document) throw new Error('model gone');
      return containerOf(buildModelGraph(document), 'shed');
    };
    expect(await nested()).toBe('c2');

    const added = await service
      .addRelationship(id, { source: 'tractorless', target: 'shed', type: 'Contains' }, modeller)
      .catch((error: unknown) => error);
    expect(added).toBeInstanceOf(Error); // unknown element: stores nothing
    await service.addRelationship(id, { source: 'b', target: 'shed', type: 'Contains' }, modeller);
    expect(await nested()).toBe('c2');

    // Deleting the first container's relationship hands the nesting to the next in order.
    const first = await service.getRelationship(id, 'w-first');
    await service.deleteRelationship(
      id,
      'w-first',
      { version: first.relationship.version },
      modeller,
    );
    expect(await nested()).toBe('c1');
    const order = (await (await open()).get(id))?.graph.edges?.map((edge) => edge.id);
    expect(order?.slice(0, 4)).toEqual(['z-self', 'y-ab', 'x-ba', 'a-second']);
    expect(order).toHaveLength(5);
  });

  it('writes field names only in the audit row', async () => {
    const store = await open();
    const { id } = await store.save(awkward, modeller);
    const service = new RelationshipService(store);
    await service.addRelationship(
      id,
      {
        source: 'c1',
        target: 'b',
        type: 'Relation',
        description: 'Secret-looking made-up text',
      },
      modeller,
    );
    const rows = await db.query<{ details: unknown }>('select details from audit');
    expect(JSON.stringify(rows)).not.toContain('Secret-looking');
    expect(JSON.stringify(rows)).toContain('description');
  });
});

// A stored two-way Contains (`"directed": false`, from a hand-made or older file)
// is a warning only: the model stays listed and readable, nests as one-way, and an edit of the
// relationship saves it as one-way.
describe('a stored Contains with "directed": false', () => {
  const twoWayContains: JgfDocument = {
    graph: {
      label: 'Made-up two-way shed',
      directed: true,
      nodes: {
        shed: { label: 'Shed', metadata: { type: 'Infrastructure' } },
        pump: { label: 'Pump', metadata: { type: 'Infrastructure' } },
      },
      edges: [
        { id: 'holds', source: 'shed', target: 'pump', relation: 'Contains', directed: false },
      ],
    },
  };

  it('stays listed, nests one way, and an edit stores it as one way', async () => {
    const store = await open();
    const { id } = await store.save(twoWayContains, modeller);
    const reopened = await open();
    expect((await reopened.list()).map((model) => model.id)).toEqual([id]);
    expect(await reopened.listDamaged()).toEqual([]);
    const document = await reopened.get(id);
    expect(document?.graph.edges?.[0]?.directed).toBe(false);
    const graph = buildModelGraph(document as JgfDocument);
    expect(containerOf(graph, 'pump')).toBe('shed');
    expect(graph.relationships[0]?.twoWay).toBeUndefined();

    const service = new RelationshipService(reopened);
    const { relationship } = await service.getRelationship(id, 'holds');
    const result = await service.updateRelationship(
      id,
      'holds',
      { version: relationship.version, description: 'Made-up note' },
      modeller,
    );
    expect(result.relationship.edge.directed).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

import type { JgfDocument, JgfEdge, ModelAuthor } from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RejectedError } from '../src/editing/common.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { validateJgf } from '../src/jgf/validate.js';
import { McpReadService } from '../src/mcp/read-service.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

// Identity, Identity Context and Data: standard text properties of a Relation. Made-up data only.

const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };

const texts = {
  identity: 'svc-made-up-reader',
  identityContext: 'On behalf of the signed-in baker',
  data: 'Oven temperatures',
};

const bakery = (edges: JgfEdge[]): JgfDocument => ({
  graph: {
    label: 'Made-up bakery',
    nodes: {
      oven: { label: 'Oven', metadata: { type: 'Infrastructure' } },
      planner: { label: 'Planner', metadata: { type: 'Application' } },
    },
    edges,
  },
});

const relation = (metadata: Record<string, unknown>, type = 'Relation'): JgfEdge => ({
  id: 'r1',
  source: 'planner',
  target: 'oven',
  relation: type,
  metadata,
});

describe('validation', () => {
  it('accepts the three as text on a Relation', () => {
    const result = validateJgf(bakery([relation(texts)]));
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('warns, never refuses, a stored value that is not text', () => {
    const result = validateJgf(
      bakery([relation({ identity: 7, identityContext: ['a'], data: {} })]),
    );
    expect(result.valid).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warnings.map((w) => [w.field, w.code])).toEqual([
      ['metadata.identity', 'invalid-property-value'],
      ['metadata.identityContext', 'invalid-property-value'],
      ['metadata.data', 'invalid-property-value'],
    ]);
  });

  it('warns about them on a Contains, keeping the model readable', () => {
    const result = validateJgf(bakery([relation({ data: 'x', identity: 3 }, 'Contains')]));
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => [w.field, w.code])).toEqual([
      ['metadata.data', 'property-not-for-type'],
      ['metadata.identity', 'property-not-for-type'],
    ]);
  });

  it('leaves the same keys on an element as custom metadata', () => {
    const document = bakery([]);
    const oven = document.graph.nodes?.oven;
    if (oven) oven.metadata = { type: 'Infrastructure', data: 5, identity: ['x'] };
    const result = validateJgf(document);
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

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

async function setup(model: JgfDocument) {
  const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
  const summary = await store.save(model, modeller);
  return { store, service: new RelationshipService(store), modelId: summary.id };
}

describe('the JGF round trip', () => {
  it('stores and exports them exactly as imported', async () => {
    const document = bakery([relation({ architectureState: 'Current', ...texts })]);
    const { store, modelId } = await setup(document);
    const stored = await store.get(modelId);
    expect(stored?.graph.edges).toEqual(document.graph.edges);
  });

  it('keeps a value that is not text, or one on a Contains, as it was', async () => {
    const edges = [
      relation({ identity: 7 }),
      { ...relation({ data: 'kept' }, 'Contains'), id: 'c1' },
    ];
    const { store, modelId } = await setup(bakery(edges));
    expect((await store.get(modelId))?.graph.edges).toEqual(edges);
  });
});

describe('editing', () => {
  it('sets them trimmed, and a blank or null removes one', async () => {
    const { store, service, modelId } = await setup(bakery([relation({})]));
    const set = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, identity: '  svc-a  ', identityContext: 'ctx', data: 'Orders' },
      modeller,
    );
    expect(set.relationship.edge.metadata).toEqual({
      identity: 'svc-a',
      identityContext: 'ctx',
      data: 'Orders',
    });
    const cleared = await service.updateRelationship(
      modelId,
      'r1',
      { version: 2, identity: '  ', data: null },
      modeller,
    );
    expect(cleared.relationship.edge.metadata).toEqual({ identityContext: 'ctx' });
    expect((await store.get(modelId))?.graph.edges?.[0]?.metadata).toEqual({
      identityContext: 'ctx',
    });
  });

  it('refuses them on a Contains, and as custom metadata', async () => {
    const { service, modelId } = await setup(bakery([relation({}, 'Contains')]));
    await expect(
      service.updateRelationship(modelId, 'r1', { version: 1, data: 'x' }, modeller),
    ).rejects.toThrow(RejectedError);
    await expect(
      service.updateRelationship(modelId, 'r1', { version: 1, metadata: { data: 'x' } }, modeller),
    ).rejects.toThrow();
  });

  it('lets a value kept as custom metadata on a Contains be removed', async () => {
    const { service, modelId } = await setup(bakery([relation({ data: 'old' }, 'Contains')]));
    const result = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, metadata: { data: null } },
      modeller,
    );
    expect(result.relationship.edge.metadata).toEqual({});
  });

  it('removes them when the type changes to Contains', async () => {
    const { service, modelId } = await setup(bakery([relation({ ...texts, zone: 'z' })]));
    const result = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, type: 'Contains' },
      modeller,
    );
    expect(result.relationship.edge.metadata).toEqual({ zone: 'z' });
    expect(result.warnings).toEqual([]);
  });
});

describe('the MCP read tools', () => {
  it('return them for a Relation, and not as standard on a Contains', async () => {
    const { store, modelId } = await setup(
      bakery([relation(texts), { ...relation({ data: 'kept' }, 'Contains'), id: 'c1' }]),
    );
    const read = new McpReadService(store);
    const element = await read.element(modelId, 'planner');
    const [first, second] = element.relationships;
    expect(first).toMatchObject(texts);
    expect(second).not.toHaveProperty('data');
    expect(second?.properties).toEqual({ data: 'kept' });
  });
});

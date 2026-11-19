import {
  maxDataValueLength,
  maxDataValues,
  type JgfDocument,
  type JgfEdge,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RejectedError } from '../src/editing/common.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { validateImported } from '../src/jgf/older-types.js';
import { validateJgf } from '../src/jgf/validate.js';
import { McpReadService } from '../src/mcp/read-service.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

// Identity and Identity Context (text), and the two lists of data (lists of texts):
// standard properties of a Relation. Made-up data only.

const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };

const texts = {
  identity: 'svc-made-up-reader',
  identityContext: 'On behalf of the signed-in baker',
  sourceToTargetData: ['Oven temperatures', 'Flour stock'],
  targetToSourceData: ['Baking plan'],
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
  it('accepts Identity and Identity Context as text and the Data as lists on a Relation', () => {
    const result = validateJgf(bakery([relation(texts)]));
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(
      validateJgf(bakery([relation({ sourceToTargetData: [], targetToSourceData: [] })])).warnings,
    ).toEqual([]);
  });

  it('reads a single text in Source to target data or Target to source data as one value, never as a problem', () => {
    const { document, validation } = validateImported(
      bakery([relation({ sourceToTargetData: 'Flour', targetToSourceData: '  ' })]),
    );
    expect(validation.valid).toBe(true);
    expect(validation.warnings).toEqual([]);
    // A blank text held no value: it goes.
    expect((document as JgfDocument).graph.edges?.[0]?.metadata).toEqual({
      sourceToTargetData: ['Flour'],
    });
  });

  it('warns, never refuses, a stored value that is not text', () => {
    const result = validateJgf(
      bakery([
        relation({
          identity: 7,
          identityContext: ['a'],
          sourceToTargetData: {},
          targetToSourceData: [1, 'a'],
        }),
      ]),
    );
    expect(result.valid).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warnings.map((w) => [w.field, w.code])).toEqual([
      ['metadata.identity', 'invalid-property-value'],
      ['metadata.identityContext', 'invalid-property-value'],
      ['metadata.sourceToTargetData', 'invalid-property-value'],
      ['metadata.targetToSourceData', 'invalid-property-value'],
    ]);
  });

  it('warns, never refuses, a list with a blank value, a value twice or too many values', () => {
    const many = Array.from({ length: maxDataValues + 1 }, (_, index) => `Value ${String(index)}`);
    const result = validateJgf(
      bakery([
        relation({ sourceToTargetData: ['Orders', 'ORDERS', '', '  '], targetToSourceData: many }),
        { ...relation({ sourceToTargetData: ['Orders', 'Invoices'] }), id: 'r2' },
        { ...relation({ targetToSourceData: [' orders', 'Orders'] }), id: 'r3' },
      ]),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => [w.edgeId, w.field, w.code, w.message])).toEqual([
      [
        'r1',
        'metadata.sourceToTargetData',
        'data-values-not-kept',
        'Edge "r1": metadata.sourceToTargetData has a blank value and a value more than once (ignoring case); it is kept as it is, and a change to it must leave that out',
      ],
      [
        'r1',
        'metadata.targetToSourceData',
        'data-values-not-kept',
        `Edge "r1": metadata.targetToSourceData has more than ${String(maxDataValues)} values; it is kept as it is, and a change to it must leave that out`,
      ],
      [
        'r3',
        'metadata.targetToSourceData',
        'data-values-not-kept',
        'Edge "r3": metadata.targetToSourceData has a value more than once (ignoring case); it is kept as it is, and a change to it must leave that out',
      ],
    ]);
    // The most values a field may hold is fine.
    expect(validateJgf(bakery([relation({ sourceToTargetData: many.slice(1) })])).warnings).toEqual(
      [],
    );
  });

  it('keeps such a list as imported and stored, with the warning', async () => {
    const edges = [relation({ sourceToTargetData: ['Orders', 'ORDERS', ''] })];
    const { document, validation } = validateImported(bakery(edges));
    expect(validation.valid).toBe(true);
    expect(validation.warnings.map((w) => w.code)).toEqual(['data-values-not-kept']);
    expect((document as JgfDocument).graph.edges?.[0]?.metadata).toEqual({
      sourceToTargetData: ['Orders', 'ORDERS', ''],
    });
    const { store, modelId } = await setup(document as JgfDocument);
    expect(await store.listDamaged()).toEqual([]);
    const stored = await store.get(modelId);
    expect(stored?.graph.edges?.[0]?.metadata).toEqual({
      sourceToTargetData: ['Orders', 'ORDERS', ''],
    });
    expect(validateJgf(stored).warnings.map((w) => w.code)).toEqual(['data-values-not-kept']);
  });

  it('warns about them on a Contains, keeping the model readable', () => {
    const result = validateJgf(
      bakery([
        relation({ sourceToTargetData: 'x', identity: 3, targetToSourceData: 'y' }, 'Contains'),
      ]),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => [w.field, w.code])).toEqual([
      ['metadata.sourceToTargetData', 'property-not-for-type'],
      ['metadata.identity', 'property-not-for-type'],
      ['metadata.targetToSourceData', 'property-not-for-type'],
    ]);
  });

  it('warns, never refuses, Data kept from before on any relationship', () => {
    const result = validateJgf(
      bakery([
        relation({ data: 'Old', sourceToTargetData: ['New'] }),
        { ...relation({ data: 'Old', sourceToTargetData: ['New'] }, 'Contains'), id: 'c1' },
      ]),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => [w.edgeId, w.field, w.code])).toEqual([
      ['r1', 'metadata.data', 'retired-property'],
      ['c1', 'metadata.data', 'retired-property'],
      ['c1', 'metadata.sourceToTargetData', 'property-not-for-type'],
    ]);
  });

  it('leaves the same keys on an element as custom metadata', () => {
    const document = bakery([]);
    const oven = document.graph.nodes?.oven;
    if (oven) {
      oven.metadata = { type: 'Infrastructure', data: 5, sourceToTargetData: 5, identity: ['x'] };
    }
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

  it('keeps a value of another shape, or one on a Contains, as it was', async () => {
    const edges = [
      relation({ identity: 7, sourceToTargetData: { odd: true }, targetToSourceData: [1, 'a'] }),
      { ...relation({ sourceToTargetData: ['kept'] }, 'Contains'), id: 'c1' },
    ];
    const { store, modelId } = await setup(bakery(edges));
    expect((await store.get(modelId))?.graph.edges).toEqual(edges);
  });

  it('reads a single text stored by an older API as a list of that text', async () => {
    const { modelId } = await setup(bakery([relation({})]));
    await db.query(
      `update relationships set metadata = '{"sourceToTargetData": "Flour", "targetToSourceData": ""}'::jsonb`,
    );
    const fresh = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
    expect((await fresh.get(modelId))?.graph.edges?.[0]?.metadata).toEqual({
      sourceToTargetData: ['Flour'],
    });
    expect(await fresh.listDamaged()).toEqual([]);
  });
});

describe('editing', () => {
  it('sets them trimmed, in the order sent, and a blank, an empty list or null removes one', async () => {
    const { store, service, modelId } = await setup(bakery([relation({})]));
    const set = await service.updateRelationship(
      modelId,
      'r1',
      {
        version: 1,
        identity: '  svc-a  ',
        identityContext: 'ctx',
        sourceToTargetData: ['Orders', ' Customers '],
        targetToSourceData: [' Order ids '],
      },
      modeller,
    );
    expect(set.relationship.edge.metadata).toEqual({
      identity: 'svc-a',
      identityContext: 'ctx',
      sourceToTargetData: ['Orders', 'Customers'],
      targetToSourceData: ['Order ids'],
    });
    const cleared = await service.updateRelationship(
      modelId,
      'r1',
      { version: 2, identity: '  ', sourceToTargetData: null, targetToSourceData: [] },
      modeller,
    );
    expect(cleared.relationship.edge.metadata).toEqual({ identityContext: 'ctx' });
    expect((await store.get(modelId))?.graph.edges?.[0]?.metadata).toEqual({
      identityContext: 'ctx',
    });
  });

  it('refuses them on a Contains, and as custom metadata', async () => {
    const { service, modelId } = await setup(bakery([relation({}, 'Contains')]));
    for (const key of ['sourceToTargetData', 'targetToSourceData']) {
      await expect(
        service.updateRelationship(modelId, 'r1', { version: 1, [key]: ['x'] }, modeller),
      ).rejects.toThrow(RejectedError);
      await expect(
        service.updateRelationship(
          modelId,
          'r1',
          { version: 1, metadata: { [key]: 'x' } },
          modeller,
        ),
      ).rejects.toThrow();
    }
  });

  it('refuses Data, now Source to target data and Target to source data, in its field and as custom metadata', async () => {
    const { service, modelId } = await setup(bakery([relation({})]));
    await expect(
      service.updateRelationship(modelId, 'r1', { version: 1, data: 'x' }, modeller),
    ).rejects.toThrow();
    const refusal = await service
      .updateRelationship(modelId, 'r1', { version: 1, metadata: { data: 'x' } }, modeller)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RejectedError);
    expect((refusal as RejectedError).fields).toEqual([
      {
        field: 'metadata.data',
        message: 'This key is reserved: Data is now sourceToTargetData and targetToSourceData.',
      },
    ]);
  });

  it('lets a value kept as custom metadata on a Contains be removed', async () => {
    const { service, modelId } = await setup(
      bakery([relation({ sourceToTargetData: ['old'] }, 'Contains')]),
    );
    const result = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, metadata: { sourceToTargetData: null } },
      modeller,
    );
    expect(result.relationship.edge.metadata).toEqual({});
  });

  it('keeps Data from before beside Source to target data, and lets it be removed', async () => {
    const { store, service, modelId } = await setup(
      bakery([relation({ data: 'Old', sourceToTargetData: ['New'] })]),
    );
    const kept = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, targetToSourceData: ['Answer'] },
      modeller,
    );
    expect(kept.relationship.edge.metadata).toEqual({
      data: 'Old',
      sourceToTargetData: ['New'],
      targetToSourceData: ['Answer'],
    });
    expect(kept.warnings.map((w) => w.code)).toEqual(['retired-property']);
    const removed = await service.updateRelationship(
      modelId,
      'r1',
      { version: 2, metadata: { data: null } },
      modeller,
    );
    expect(removed.relationship.edge.metadata).toEqual({
      sourceToTargetData: ['New'],
      targetToSourceData: ['Answer'],
    });
    expect((await store.get(modelId))?.graph.edges?.[0]?.metadata).not.toHaveProperty('data');
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

describe('the values of Source to target data and Target to source data', () => {
  const refusal = async (sent: unknown, stored: Record<string, unknown> = {}) => {
    const { service, modelId } = await setup(bakery([relation(stored)]));
    const error = await service
      .updateRelationship(modelId, 'r1', { version: 1, sourceToTargetData: sent }, modeller)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(RejectedError);
    return (error as RejectedError).fields;
  };

  it('refuses a value twice, ignoring case, naming the field', async () => {
    expect(await refusal(['Orders', ' orders'])).toEqual([
      {
        field: 'sourceToTargetData',
        message: 'Each value can be there only once (ignoring case).',
      },
    ]);
  });

  it('refuses a blank value, a value that is not text, and a single text', async () => {
    expect(await refusal(['Orders', '  '])).toEqual([
      { field: 'sourceToTargetData', message: "A value can't be empty." },
    ]);
    expect(await refusal(['Orders', 7])).toEqual([
      { field: 'sourceToTargetData', message: 'Must be a list of texts.' },
    ]);
    expect(await refusal('Orders')).toEqual([
      { field: 'sourceToTargetData', message: 'Must be a list of texts.' },
    ]);
  });

  it('refuses too many values, and a new value that is too long', async () => {
    const many = Array.from({ length: maxDataValues + 1 }, (_, index) => `Value ${String(index)}`);
    expect(await refusal(many)).toEqual([
      { field: 'sourceToTargetData', message: `Can hold at most ${String(maxDataValues)} values.` },
    ]);
    expect(await refusal(['x'.repeat(maxDataValueLength + 1)])).toEqual([
      {
        field: 'sourceToTargetData',
        message: `Each value must be at most ${String(maxDataValueLength)} characters.`,
      },
    ]);
  });

  it('accepts the most values, and keeps a long value stored already', async () => {
    const most = Array.from({ length: maxDataValues }, (_, index) => `Value ${String(index)}`);
    const long = 'y'.repeat(maxDataValueLength + 20);
    const { service, modelId } = await setup(bakery([relation({ sourceToTargetData: [long] })]));
    const kept = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, sourceToTargetData: [long, 'Flour'], targetToSourceData: most },
      modeller,
    );
    expect(kept.relationship.edge.metadata).toEqual({
      sourceToTargetData: [long, 'Flour'],
      targetToSourceData: most,
    });
  });

  it('changes nothing when the same list is sent', async () => {
    const { service, modelId } = await setup(
      bakery([relation({ sourceToTargetData: ['A', 'B'] })]),
    );
    const same = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, sourceToTargetData: ['A', 'B'] },
      modeller,
    );
    expect(same.relationship.version).toBe(1);
    const reordered = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, sourceToTargetData: ['B', 'A'] },
      modeller,
    );
    expect(reordered.relationship.version).toBe(2);
    expect(reordered.relationship.edge.metadata).toEqual({ sourceToTargetData: ['B', 'A'] });
  });
});

describe('the MCP read tools', () => {
  it('return them for a Relation, and not as standard on a Contains', async () => {
    const { store, modelId } = await setup(
      bakery([
        relation(texts),
        { ...relation({ sourceToTargetData: ['kept'] }, 'Contains'), id: 'c1' },
      ]),
    );
    const read = new McpReadService(store);
    const element = await read.element(modelId, 'planner');
    const [first, second] = element.relationships;
    expect(first).toMatchObject(texts);
    expect(first).not.toHaveProperty('data');
    expect(second).not.toHaveProperty('sourceToTargetData');
    expect(second?.properties).toEqual({ sourceToTargetData: ['kept'] });
  });
});

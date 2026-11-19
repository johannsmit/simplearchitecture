import type { JgfDocument, JgfEdge, ModelAuthor } from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { validateImported } from '../src/jgf/older-types.js';
import { McpReadService } from '../src/mcp/read-service.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

// The relationship form's saves, as the browser sends them, give the same data between the same two
// elements; an older file imports with the lists named by direction; the MCP tools read them so.
// Made-up data.

const modeller: ModelAuthor = { id: 'oid-made-up', name: 'Made-up Modeller' };

const dock = (edges: JgfEdge[]): JgfDocument => ({
  graph: {
    label: 'Made-up dock',
    nodes: {
      order: { label: 'Order system', metadata: { type: 'Application' } },
      warehouse: { label: 'Warehouse', metadata: { type: 'Application' } },
      crm: { label: 'Customer desk', metadata: { type: 'Application' } },
      billing: { label: 'Billing', metadata: { type: 'Application' } },
      ledger: { label: 'Ledger', metadata: { type: 'Application' } },
    },
    edges,
  },
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
  const { id } = await store.save(model, modeller);
  return { store, service: new RelationshipService(store), modelId: id };
}

/** Who sends what to whom, whichever end is the source. */
function flows(edge: JgfEdge): Record<string, unknown> {
  const metadata = edge.metadata ?? {};
  return {
    [`${edge.source}>${edge.target}`]: metadata.sourceToTargetData,
    [`${edge.target}>${edge.source}`]: metadata.targetToSourceData,
  };
}

describe("the relationship form's saves", () => {
  it('Reverse alone, then Reverse with a value added, keep each value flowing the same way', async () => {
    const { service, modelId } = await setup(
      dock([
        {
          id: 'r-down',
          source: 'order',
          target: 'warehouse',
          relation: 'Relation',
          metadata: { sourceToTargetData: ['orders', 'invoices'], targetToSourceData: ['stock'] },
        },
      ]),
    );
    // What the form sent for Reverse alone.
    const first = await service.updateRelationship(
      modelId,
      'r-down',
      { version: 1, reverse: true },
      modeller,
    );
    expect(first.relationship.edge).toMatchObject({ source: 'warehouse', target: 'order' });
    expect(flows(first.relationship.edge)).toEqual({
      'order>warehouse': ['orders', 'invoices'],
      'warehouse>order': ['stock'],
    });
    // Reverse back, with "returns" added to the top list (Order system to Warehouse) on the form.
    const second = await service.updateRelationship(
      modelId,
      'r-down',
      { version: 2, reverse: true, sourceToTargetData: ['orders', 'invoices', 'returns'] },
      modeller,
    );
    expect(second.relationship.edge).toMatchObject({ source: 'order', target: 'warehouse' });
    expect(second.relationship.edge.metadata).toEqual({
      sourceToTargetData: ['orders', 'invoices', 'returns'],
      targetToSourceData: ['stock'],
    });
  });

  it('a Change and a Reverse, sent as new ends with the lists swapped, keep each list with its direction', async () => {
    const { service, modelId } = await setup(
      dock([
        {
          id: 'r-side',
          source: 'crm',
          target: 'billing',
          relation: 'Relation',
          metadata: { sourceToTargetData: ['accounts'], targetToSourceData: ['payments'] },
        },
      ]),
    );
    // To changed from Billing to Ledger, then Reversed: what the form sent.
    const result = await service.updateRelationship(
      modelId,
      'r-side',
      {
        version: 1,
        source: 'ledger',
        target: 'crm',
        sourceToTargetData: ['payments'],
        targetToSourceData: ['accounts'],
      },
      modeller,
    );
    expect(flows(result.relationship.edge)).toEqual({
      'crm>ledger': ['accounts'],
      'ledger>crm': ['payments'],
    });
  });
});

describe('an older file', () => {
  const older = {
    graph: {
      label: 'Made-up older dock',
      nodes: dock([]).graph.nodes,
      edges: [
        // An older Information flow: its label became Data, then Request Data.
        {
          id: 'e1',
          source: 'order',
          target: 'warehouse',
          relation: 'Information flow',
          label: 'Orders',
        },
        // Data with {Data} in the label.
        {
          id: 'e2',
          source: 'crm',
          target: 'billing',
          relation: 'Relation',
          label: 'Sends {Data}',
          metadata: { data: 'Accounts' },
        },
        // Request Data and Response Data, a single text and a list, named in the label.
        {
          id: 'e3',
          source: 'billing',
          target: 'ledger',
          relation: 'Relation',
          label: '{request data} / { Response  Data } {{Request Data}}',
          metadata: { requestData: 'Entries', responseData: ['Totals'] },
        },
        // Both an older and a newer key: both kept, the older one a warning.
        {
          id: 'e4',
          source: 'ledger',
          target: 'order',
          relation: 'Relation',
          metadata: { requestData: ['Old'], sourceToTargetData: ['New'] },
        },
        // Information flow as a property, on a two-way relationship.
        {
          id: 'e5',
          source: 'warehouse',
          target: 'ledger',
          relation: 'Relation',
          directed: false,
          label: 'Stock',
          metadata: { informationFlow: true, responseData: 'Counts' },
        },
      ],
    },
  };

  it('imports with the new keys, labels and report notes', async () => {
    const { document, validation } = validateImported(older);
    expect(validation.valid).toBe(true);
    const edges = new Map(
      ((document as JgfDocument).graph.edges ?? []).map((edge) => [edge.id, edge] as const),
    );
    expect(edges.get('e1')).toMatchObject({
      relation: 'Relation',
      label: 'Orders',
      metadata: { sourceToTargetData: ['Orders'] },
    });
    expect(edges.get('e2')).toMatchObject({
      label: 'Sends {Source to Target Data}',
      metadata: { sourceToTargetData: ['Accounts'] },
    });
    expect(edges.get('e3')).toMatchObject({
      label: '{Source to Target Data} / {Target to Source Data} {{Request Data}}',
      metadata: { sourceToTargetData: ['Entries'], targetToSourceData: ['Totals'] },
    });
    expect(edges.get('e4')?.metadata).toEqual({
      requestData: ['Old'],
      sourceToTargetData: ['New'],
    });
    expect(edges.get('e5')).toMatchObject({
      directed: false,
      metadata: { sourceToTargetData: ['Stock'], targetToSourceData: ['Counts'] },
    });
    for (const edge of edges.values()) {
      expect(Object.keys(edge.metadata ?? {})).not.toContain('responseData');
      expect(Object.keys(edge.metadata ?? {})).not.toContain('data');
    }
    const codes = validation.warnings.map((issue) => [issue.code, issue.edgeId ?? '']);
    expect(codes).toEqual(
      expect.arrayContaining([
        ['older-relationship-types', ''],
        ['older-data-property', ''],
        ['older-data-direction', ''],
        ['older-data-kept', 'e4'],
      ]),
    );
    const direction = validation.warnings.find((issue) => issue.code === 'older-data-direction');
    // Only e3: e1, e2 and e5 count once, for their oldest conversion, and e4 keeps both keys.
    expect(direction?.message).toBe(
      'Document: 1 relationship with Request Data or Response Data, or with them in the label, converted: Request Data is now Source to target data, Response Data is now Target to source data.',
    );
  });

  it('reads through the MCP tools with the new keys and labels filled in', async () => {
    const { document } = validateImported(older);
    const { store, modelId } = await setup(document as JgfDocument);
    const read = new McpReadService(store);
    const near = await read.neighbours(modelId, 'billing', 1);
    const e3 = near.relationships.find((relationship) => relationship.id === 'e3');
    expect(e3).toMatchObject({
      sourceToTargetData: ['Entries'],
      targetToSourceData: ['Totals'],
      displayLabel: 'Entries / Totals {Request Data}',
    });
    const element = await read.element(modelId, 'ledger');
    for (const relationship of element.relationships) {
      expect(Object.keys(relationship)).not.toContain('requestData');
      expect(Object.keys(relationship)).not.toContain('responseData');
    }
    // An older key kept beside a new one shows only among the properties, as stored.
    expect(element.relationships.find((relationship) => relationship.id === 'e4')).toMatchObject({
      sourceToTargetData: ['New'],
      properties: { requestData: ['Old'], sourceToTargetData: ['New'] },
    });
  });
});

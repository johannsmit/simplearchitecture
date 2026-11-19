import {
  buildModelGraph,
  fillLabel,
  labelPropertyNames,
  propertyNameProblem,
  relationshipPropertyValues,
  relationshipViewFields,
  standardProperties,
  type JgfDocument,
  type JgfEdge,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RejectedError } from '../src/editing/common.js';
import { RelationshipService } from '../src/editing/relationship-service.js';
import { warnAboutNameClashes } from '../src/db/service.js';
import { insertDefinitions } from '../src/properties/property-store.js';
import { validateJgf } from '../src/jgf/validate.js';
import { McpReadService } from '../src/mcp/read-service.js';
import { convertOef } from '../src/oef/mapper.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { agreedMapping } from './helpers.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

// A Relation's two lists of data are named by direction: Source to target data
// (`sourceToTargetData`) and Target to source data (`targetToSourceData`). Reversing a Relation swaps
// them along with its ends, so the same data flows between the same two elements. Made-up data.

const modeller: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };

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

const relation = (metadata: Record<string, unknown>, fields: Partial<JgfEdge> = {}): JgfEdge => ({
  id: 'r1',
  source: 'planner',
  target: 'oven',
  relation: 'Relation',
  metadata,
  ...fields,
});

describe('the metamodel', () => {
  it('names the two lists by direction', () => {
    expect(standardProperties.sourceToTargetData.label).toBe('Source to target data');
    expect(standardProperties.targetToSourceData.label).toBe('Target to source data');
    expect(Object.keys(standardProperties)).not.toContain('requestData');
    expect(Object.keys(standardProperties)).not.toContain('responseData');
  });
});

describe('validation', () => {
  it('accepts the new keys as lists on a Relation', () => {
    const result = validateJgf(
      bakery([relation({ sourceToTargetData: ['Orders'], targetToSourceData: ['Order ids'] })]),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('warns, never refuses, an older key kept on any relationship', () => {
    const result = validateJgf(
      bakery([
        relation({ requestData: ['Old'], sourceToTargetData: ['New'] }),
        relation({ responseData: ['Old'] }, { id: 'c1', relation: 'Contains' }),
      ]),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => [w.edgeId, w.field, w.code, w.message])).toEqual([
      [
        'r1',
        'metadata.requestData',
        'older-data-kept',
        'Edge "r1": metadata.requestData is Request Data from before it became Source to target data; it is kept as it is',
      ],
      [
        'c1',
        'metadata.responseData',
        'older-data-kept',
        'Edge "c1": metadata.responseData is Response Data from before it became Target to source data; it is kept as it is',
      ],
    ]);
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

const audit = () =>
  db.query<{ action: string; relationship_id: string; details: { fields: string[] } }>(
    'select action, relationship_id, details from audit where relationship_id is not null order by id',
  );

describe('editing', () => {
  it('sets the two lists under their new keys', async () => {
    const { service, modelId } = await setup(bakery([relation({})]));
    const result = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, sourceToTargetData: [' Orders '], targetToSourceData: ['Order ids'] },
      modeller,
    );
    expect(result.relationship.edge.metadata).toEqual({
      sourceToTargetData: ['Orders'],
      targetToSourceData: ['Order ids'],
    });
  });

  it('refuses the older keys in their fields and as metadata, with a clear message', async () => {
    const { service, modelId } = await setup(bakery([relation({})]));
    const refused = async (change: Record<string, unknown>) => {
      const error = await service
        .updateRelationship(modelId, 'r1', { version: 1, ...change }, modeller)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(RejectedError);
      return (error as RejectedError).fields;
    };
    expect(await refused({ requestData: ['x'] })).toEqual([
      {
        field: 'requestData',
        message: 'requestData is no longer used: send sourceToTargetData.',
      },
    ]);
    expect(await refused({ responseData: null })).toEqual([
      {
        field: 'responseData',
        message: 'responseData is no longer used: send targetToSourceData.',
      },
    ]);
    expect(await refused({ metadata: { requestData: ['x'] } })).toEqual([
      {
        field: 'metadata.requestData',
        message: 'requestData is no longer used: send sourceToTargetData.',
      },
    ]);
    expect(await refused({ metadata: { data: 'x' } })).toEqual([
      {
        field: 'metadata.data',
        message: 'This key is reserved: Data is now sourceToTargetData and targetToSourceData.',
      },
    ]);
    expect(await refused({ metadata: { responseData: 'x' } })).toEqual([
      {
        field: 'metadata.responseData',
        message: 'responseData is no longer used: send targetToSourceData.',
      },
    ]);
  });

  it('keeps an older key beside a new one, and lets it be removed', async () => {
    const { service, modelId } = await setup(
      bakery([relation({ requestData: ['Old'], sourceToTargetData: ['New'] })]),
    );
    const removed = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, metadata: { requestData: null } },
      modeller,
    );
    expect(removed.relationship.edge.metadata).toEqual({ sourceToTargetData: ['New'] });
    expect(removed.warnings).toEqual([]);
  });
});

describe('Reverse', () => {
  it('swaps the two lists with the ends, and the audit lists both', async () => {
    const { store, service, modelId } = await setup(
      bakery([relation({ sourceToTargetData: ['Plans'], targetToSourceData: ['Temperatures'] })]),
    );
    const result = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, reverse: true },
      modeller,
    );
    expect(result.relationship.edge).toMatchObject({
      source: 'oven',
      target: 'planner',
      metadata: { sourceToTargetData: ['Temperatures'], targetToSourceData: ['Plans'] },
    });
    expect((await store.get(modelId))?.graph.edges?.[0]?.metadata).toEqual({
      sourceToTargetData: ['Temperatures'],
      targetToSourceData: ['Plans'],
    });
    const [row] = await audit();
    expect(row?.action).toBe('relationship-reversed');
    expect([...(row?.details.fields ?? [])].sort()).toEqual([
      'source',
      'sourceToTargetData',
      'target',
      'targetToSourceData',
    ]);
  });

  it('moves a single list to the other side, and lists only the ends when there is none', async () => {
    const { service, modelId } = await setup(
      bakery([relation({ sourceToTargetData: ['Plans'], zone: 'z' }), relation({}, { id: 'r2' })]),
    );
    const one = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, reverse: true },
      modeller,
    );
    expect(one.relationship.edge.metadata).toEqual({ targetToSourceData: ['Plans'], zone: 'z' });
    await service.updateRelationship(modelId, 'r2', { version: 1, reverse: true }, modeller);
    const rows = await audit();
    expect([...(rows[0]?.details.fields ?? [])].sort()).toEqual([
      'source',
      'sourceToTargetData',
      'target',
      'targetToSourceData',
    ]);
    expect(rows[1]?.details.fields).toEqual(['source', 'target']);
  });

  it('swaps them on a two-way Relation too', async () => {
    const { service, modelId } = await setup(
      bakery([relation({ sourceToTargetData: ['Plans'] }, { directed: false })]),
    );
    const result = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, reverse: true },
      modeller,
    );
    expect(result.relationship.edge).toMatchObject({
      source: 'oven',
      target: 'planner',
      directed: false,
      metadata: { targetToSourceData: ['Plans'] },
    });
    expect(result.relationship.edge.metadata).not.toHaveProperty('sourceToTargetData');
  });

  it('takes lists sent with it as the lists after the swap', async () => {
    const long = 'x'.repeat(300);
    const { service, modelId } = await setup(
      bakery([relation({ sourceToTargetData: [long], targetToSourceData: ['Temperatures'] })]),
    );
    const result = await service.updateRelationship(
      modelId,
      'r1',
      // The long value stored already may stay, now on the other side.
      { version: 1, reverse: true, targetToSourceData: [long, 'More plans'] },
      modeller,
    );
    expect(result.relationship.edge.metadata).toEqual({
      sourceToTargetData: ['Temperatures'],
      targetToSourceData: [long, 'More plans'],
    });
  });

  it('leaves the lists alone on a relationship from an element to itself', async () => {
    const { service, modelId } = await setup(
      bakery([
        relation(
          { sourceToTargetData: ['Plans'] },
          { source: 'planner', target: 'planner', label: 'Loops' },
        ),
      ]),
    );
    const result = await service.updateRelationship(
      modelId,
      'r1',
      { version: 1, reverse: true },
      modeller,
    );
    expect(result.relationship.version).toBe(1);
    expect(result.relationship.edge.metadata).toEqual({ sourceToTargetData: ['Plans'] });
  });
});

describe('the MCP read tools', () => {
  it('return the lists under the new keys', async () => {
    const { store, modelId } = await setup(
      bakery([relation({ sourceToTargetData: ['Plans'], targetToSourceData: ['Temperatures'] })]),
    );
    const element = await new McpReadService(store).element(modelId, 'planner');
    expect(element.relationships[0]).toMatchObject({
      sourceToTargetData: ['Plans'],
      targetToSourceData: ['Temperatures'],
    });
    expect(element.relationships[0]).not.toHaveProperty('requestData');
  });
});

describe('labels', () => {
  const subject = {
    type: 'Relation' as const,
    architectureState: 'Current' as const,
    metadata: { sourceToTargetData: ['Orders', 'Customers'], targetToSourceData: ['Order ids'] },
  };

  it('fill in the fixed names, ignoring case and runs of white space', () => {
    expect(
      fillLabel('Sends {Source to Target Data}, gets {target  to source DATA}', subject).text,
    ).toBe('Sends Orders, Customers, gets Order ids');
  });

  it('suggest the fixed names as labels write them', () => {
    expect(labelPropertyNames(subject)).toEqual([
      'Identity',
      'Identity Context',
      'Source to Target Data',
      'Target to Source Data',
      'Architecture state',
      'Description',
    ]);
  });

  it('never offer leftover Data, Request Data or Response Data', () => {
    const leftovers = {
      ...subject,
      metadata: { ...subject.metadata, data: 'Old', requestData: ['Old'], zone: 'z' },
    };
    const names = labelPropertyNames(leftovers);
    expect(names).toContain('zone');
    expect(names).not.toContain('data');
    expect(names).not.toContain('requestData');
  });

  it('leave an older name as an unknown one', () => {
    expect(fillLabel('{Request Data}', subject)).toEqual({
      text: '{Request Data}',
      unknown: ['Request Data'],
    });
  });
});

describe('suggestions and viewpoints', () => {
  const graph = buildModelGraph(
    bakery([
      relation({ sourceToTargetData: ['Orders'], targetToSourceData: ['Order ids'] }),
      relation({ requestData: ['Left over'], sourceToTargetData: ['Totals'] }, { id: 'r2' }),
    ]),
  );

  it('offer the values of both lists to each, and none from an older key', () => {
    const values = relationshipPropertyValues(graph);
    expect(values.get('sourceToTargetData')).toEqual(values.get('targetToSourceData'));
    expect(values.get('sourceToTargetData')).toEqual(
      expect.arrayContaining(['Orders', 'Order ids', 'Totals']),
    );
    expect(values.get('sourceToTargetData')).not.toContain('Left over');
    expect(values.has('requestData')).toBe(false);
  });

  it('show both lists as the one Data choice, never an older key', () => {
    const keys = relationshipViewFields(graph).map((field) => field.key);
    expect(keys).toContain('data');
    expect(keys).not.toContain('requestData');
    expect(keys).not.toContain('sourceToTargetData');
  });
});

describe('the OEF import', () => {
  it('sets Source to target data from a Flow named in the mapping', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="m">
  <name xml:lang="en">Made-up</name>
  <elements>
    <element identifier="a" xsi:type="ApplicationComponent"><name xml:lang="en">Planner</name></element>
    <element identifier="b" xsi:type="ApplicationComponent"><name xml:lang="en">Oven</name></element>
  </elements>
  <relationships>
    <relationship identifier="r-flow" source="a" target="b" xsi:type="Flow"><name xml:lang="en">Made-up rows</name></relationship>
  </relationships>
</model>`;
    const { jgf } = convertOef(xml, agreedMapping);
    expect(jgf.graph.edges?.[0]?.metadata).toMatchObject({ sourceToTargetData: ['Made-up rows'] });
    expect(jgf.graph.edges?.[0]?.metadata).not.toHaveProperty('requestData');
  });
});

describe('properties defined by an Admin', () => {
  it('can take neither the new names nor the older ones', () => {
    expect(propertyNameProblem('source  to TARGET data', [])).toBe(
      '“Source to target data” is a standard property.',
    );
    expect(propertyNameProblem('Target to source data', [])).toBe(
      '“Target to source data” is a standard property.',
    );
    expect(propertyNameProblem('request data', [])).toBe(
      '“Request Data” is the older name of Source to target data.',
    );
    expect(propertyNameProblem('Response  Data', [])).toBe(
      '“Response Data” is the older name of Target to source data.',
    );
  });

  it('give a warning at the start when one defined before is named like a standard one', async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await warnAboutNameClashes(db, log);
    expect(log.warn).not.toHaveBeenCalled();
    await insertDefinitions(db, [
      { key: 'flowsOut', name: 'source  to Target data', kind: 'text', fromModels: false },
      { key: 'protocol', name: 'Protocol', kind: 'text', fromModels: false },
    ]);
    await warnAboutNameClashes(db, log);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toEqual({ standard: ['Source to target data'] });
  });
});

import {
  buildModelGraph,
  checkStandardProperty,
  elementIcon,
  fieldValueCounts,
  filterFields,
  findElements,
  hasStandardProperty,
  keptAsCustomOnTypeChange,
  stakeholderKindOf,
  stakeholderKinds,
  standardProperties,
  type JgfDocument,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ElementRejectedError, ElementService } from '../src/editing/element-service.js';
import { validateJgf } from '../src/jgf/validate.js';
import { McpReadService } from '../src/mcp/read-service.js';
import { convertOef } from '../src/oef/mapper.js';
import { PostgresModelStore } from '../src/storage/postgres-model-store.js';
import { agreedMapping } from './helpers.js';
import { createTestDb, resetTestDb, type TestDb } from './pglite.js';

// A Stakeholder's Kind: Human or AI Agent, missing read as Human. Made-up data: a small bakery
// with a baker, an ordering bot, and stakeholders that held a custom "stakeholderKind" before it
// became standard.

const author: ModelAuthor = { id: 'oid-made-up-modeller', name: 'Made-up Modeller' };

const bakery = (): JgfDocument => ({
  graph: {
    id: 'made-up-bakery',
    label: 'Made-up bakery',
    directed: true,
    nodes: {
      baker: { label: 'Baker', metadata: { type: 'Stakeholder' } },
      bot: { label: 'Order bot', metadata: { type: 'Stakeholder', stakeholderKind: 'AI Agent' } },
      // Custom metadata from before Kind was standard: any value, never an error now.
      odd: { label: 'Odd one', metadata: { type: 'Stakeholder', stakeholderKind: 'robot' } },
      listed: { label: 'Listed', metadata: { type: 'Stakeholder', stakeholderKind: ['AI Agent'] } },
      oven: {
        label: 'Oven planner',
        metadata: { type: 'Application', stakeholderKind: 'AI Agent' },
      },
    },
    edges: [{ id: 'r1', source: 'bot', target: 'oven', relation: 'Relation' }],
  },
});

const fieldsOf = (document: JgfDocument, severity: 'errors' | 'warnings') =>
  validateJgf(document)[severity].map((issue) => `${issue.code} ${issue.nodeId} ${issue.field}`);

describe('the metamodel: Kind on a Stakeholder', () => {
  it('is a standard choice of Stakeholder only, labelled Kind, Human or AI Agent', () => {
    expect(standardProperties.stakeholderKind.label).toBe('Kind');
    expect(stakeholderKinds).toEqual(['Human', 'AI Agent']);
    expect(standardProperties.stakeholderKind.value).toEqual({
      kind: 'choice',
      options: ['Human', 'AI Agent'],
    });
    expect(hasStandardProperty('Stakeholder', 'stakeholderKind')).toBe(true);
    for (const type of ['Business', 'Application', 'Infrastructure', 'Other'] as const) {
      expect(hasStandardProperty(type, 'stakeholderKind')).toBe(false);
    }
  });

  it('reads a missing or unknown value as Human, and gives an AI Agent the robot icon', () => {
    expect(stakeholderKindOf('Stakeholder', {})).toBe('Human');
    expect(stakeholderKindOf('Stakeholder', { stakeholderKind: 'AI Agent' })).toBe('AI Agent');
    expect(stakeholderKindOf('Stakeholder', { stakeholderKind: 'Human' })).toBe('Human');
    expect(stakeholderKindOf('Stakeholder', { stakeholderKind: 'robot' })).toBe('Human');
    expect(stakeholderKindOf('Stakeholder', { stakeholderKind: 7 })).toBe('Human');
    expect(stakeholderKindOf('Application', { stakeholderKind: 'AI Agent' })).toBeUndefined();

    expect(elementIcon('Stakeholder')).toBe('user');
    expect(elementIcon('Stakeholder', {})).toBe('user');
    expect(elementIcon('Stakeholder', { stakeholderKind: 'AI Agent' })).toBe('bot');
    expect(elementIcon('Stakeholder', { stakeholderKind: 'robot' })).toBe('user');
    expect(elementIcon('Application', { stakeholderKind: 'AI Agent' })).toBeUndefined();
  });

  it('checks a value strictly, for forms and the import mapping', () => {
    expect(checkStandardProperty('stakeholderKind', 'AI Agent')).toEqual({ ok: true });
    expect(checkStandardProperty('stakeholderKind', 'robot')).toEqual({
      ok: false,
      severity: 'error',
      problem: 'must be one of Human, AI Agent (got "robot")',
    });
  });
});

describe('validation: no stored model becomes damaged', () => {
  it('keeps a model with any stored stakeholderKind valid, with warnings only', () => {
    const result = validateJgf(bakery());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(fieldsOf(bakery(), 'warnings')).toEqual([
      'invalid-property-value odd metadata.stakeholderKind',
      'invalid-property-value listed metadata.stakeholderKind',
      'not-standard-for-type oven metadata.stakeholderKind',
    ]);
    expect(result.warnings[0]?.message).toBe(
      'Node "odd": metadata.stakeholderKind must be one of Human, AI Agent (got "robot"); it is read as Human',
    );
  });

  it('gives a Human or an AI Agent no warning', () => {
    const document: JgfDocument = {
      graph: {
        nodes: {
          a: { label: 'A', metadata: { type: 'Stakeholder', stakeholderKind: 'Human' } },
          b: { label: 'B', metadata: { type: 'Stakeholder', stakeholderKind: 'AI Agent' } },
          c: { label: 'C', metadata: { type: 'Stakeholder' } },
        },
      },
    };
    expect(validateJgf(document)).toMatchObject({ valid: true, errorCount: 0, warningCount: 0 });
  });

  it('still refuses a bad value of the other choices, as before', () => {
    const document: JgfDocument = {
      graph: { nodes: { a: { metadata: { type: 'Application', sourcing: 'Lease' } } } },
    };
    expect(fieldsOf(document, 'errors')).toEqual(['invalid-property-value a metadata.sourcing']);
  });
});

describe('the element list filter: Kind as read, on Stakeholders only', () => {
  // Baker has no Kind, the oven (an Application) holds a custom "AI Agent" from a type change.
  const graph = buildModelGraph(bakery());
  const ids = (filters: Record<string, (string | null)[]>) =>
    findElements(graph, { filters }).map((element) => element.id);

  it('counts a Stakeholder without Kind as Human, and other types not at all', () => {
    const kind = filterFields(graph).find((field) => field.key === 'stakeholderKind');
    expect(kind).toMatchObject({ label: 'Kind', standard: true, notSetCount: 0 });
    expect(kind?.values).toEqual([
      { value: 'Human', count: 2 },
      { value: 'AI Agent', count: 1 },
      { value: 'robot', count: 1 },
    ]);
    expect(fieldValueCounts(graph, kind ?? { key: '', values: [] }, {})).toEqual({
      values: kind?.values,
      notSetCount: 0,
    });
  });

  it('filters a Stakeholder without Kind as Human, and never matches another type', () => {
    expect(ids({ stakeholderKind: ['Human'] })).toEqual(['baker', 'listed']);
    expect(ids({ stakeholderKind: ['AI Agent'] })).toEqual(['bot']);
    expect(ids({ stakeholderKind: [null] })).toEqual([]);
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

async function setup() {
  const store = await PostgresModelStore.open(db, { log: { warn: () => undefined } });
  const summary = await store.save(bakery(), author);
  return { store, service: new ElementService(store), modelId: summary.id };
}

async function rejection(promise: Promise<unknown>): Promise<ElementRejectedError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ElementRejectedError)) throw new Error(`not rejected: ${String(error)}`);
  return error;
}

describe('stored models and JGF export', () => {
  it('reads and lists a model with odd stored values, and exports every value as stored', async () => {
    const { store, modelId } = await setup();
    expect((await store.list()).map((model) => model.id)).toEqual([modelId]);
    const nodes = (await store.get(modelId))?.graph.nodes ?? {};
    expect(nodes.bot?.metadata?.stakeholderKind).toBe('AI Agent');
    expect(nodes.odd?.metadata?.stakeholderKind).toBe('robot');
    expect(nodes.listed?.metadata?.stakeholderKind).toEqual(['AI Agent']);
    expect(nodes.baker?.metadata).toEqual({ type: 'Stakeholder' });
  });
});

describe('ElementService: Kind', () => {
  it('sets and changes Kind, and removes it with null (read as Human again)', async () => {
    const { service, modelId } = await setup();
    const added = await service.addElement(
      modelId,
      { type: 'Stakeholder', name: 'Delivery bot', metadata: { stakeholderKind: 'AI Agent' } },
      author,
    );
    expect(added.element.node.metadata).toEqual({
      type: 'Stakeholder',
      stakeholderKind: 'AI Agent',
    });
    expect(added.warnings).toEqual([]);

    const human = await service.updateElement(
      modelId,
      'baker',
      { version: 1, metadata: { stakeholderKind: 'AI Agent' } },
      author,
    );
    expect(human.element.node.metadata?.stakeholderKind).toBe('AI Agent');
    const back = await service.updateElement(
      modelId,
      'baker',
      { version: 2, metadata: { stakeholderKind: null } },
      author,
    );
    expect(back.element.node.metadata).toEqual({ type: 'Stakeholder' });
  });

  it('refuses a new value outside the options, at the field', async () => {
    const { service, modelId } = await setup();
    const error = await rejection(
      service.updateElement(
        modelId,
        'baker',
        { version: 1, metadata: { stakeholderKind: 'Robot' } },
        author,
      ),
    );
    expect(error.fields).toEqual([
      {
        field: 'metadata.stakeholderKind',
        message: 'Must be one of Human, AI Agent (got "Robot").',
      },
    ]);
    const added = await rejection(
      service.addElement(
        modelId,
        { type: 'Stakeholder', name: 'X', metadata: { stakeholderKind: 'ai agent' } },
        author,
      ),
    );
    expect(added.fields.map((field) => field.field)).toEqual(['metadata.stakeholderKind']);
  });

  it('keeps an odd stored value while other fields change, with a warning', async () => {
    const { service, modelId } = await setup();
    const renamed = await service.updateElement(
      modelId,
      'odd',
      { version: 1, name: 'Odd two', metadata: { stakeholderKind: 'robot' } },
      author,
    );
    expect(renamed.element.node).toEqual({
      label: 'Odd two',
      metadata: { type: 'Stakeholder', stakeholderKind: 'robot' },
    });
    expect(renamed.warnings.map((issue) => `${issue.code} ${issue.field}`)).toEqual([
      'invalid-property-value metadata.stakeholderKind',
    ]);
  });

  it('keeps Kind as custom metadata when the type changes, and as Kind again on the way back', async () => {
    const { service, modelId } = await setup();
    expect(
      keptAsCustomOnTypeChange({ stakeholderKind: 'AI Agent' }, 'Stakeholder', 'Application'),
    ).toEqual(['stakeholderKind']);
    const app = await service.updateElement(
      modelId,
      'bot',
      { version: 1, type: 'Application' },
      author,
    );
    expect(app.element.node.metadata).toEqual({ type: 'Application', stakeholderKind: 'AI Agent' });
    expect(app.warnings.map((issue) => `${issue.code} ${issue.field}`)).toEqual([
      'not-standard-for-type metadata.stakeholderKind',
    ]);
    const back = await service.updateElement(
      modelId,
      'bot',
      { version: 2, type: 'Stakeholder' },
      author,
    );
    expect(back.element.node.metadata).toEqual({
      type: 'Stakeholder',
      stakeholderKind: 'AI Agent',
    });
    expect(back.warnings).toEqual([]);
  });

  it('turns an element with an odd custom value into a Stakeholder without refusing it', async () => {
    const { service, modelId } = await setup();
    await service.updateElement(
      modelId,
      'oven',
      { version: 1, metadata: { stakeholderKind: 'Maybe' } },
      author,
    );
    const turned = await service.updateElement(
      modelId,
      'oven',
      { version: 2, type: 'Stakeholder' },
      author,
    );
    expect(turned.element.node.metadata).toEqual({ type: 'Stakeholder', stakeholderKind: 'Maybe' });
    expect(turned.warnings.map((issue) => issue.code)).toEqual(['invalid-property-value']);
  });
});

describe('MCP read tools: Kind', () => {
  it('says each Stakeholder Kind as read, keeps the stored value in properties, and filters by it', async () => {
    const { store, modelId } = await setup();
    const service = new McpReadService(store);
    const bot = await service.element(modelId, 'bot');
    expect(bot).toMatchObject({
      id: 'bot',
      type: 'Stakeholder',
      stakeholderKind: 'AI Agent',
      properties: { stakeholderKind: 'AI Agent' },
    });
    expect(bot.relationships[0]?.other).toEqual({
      id: 'oven',
      name: 'Oven planner',
      type: 'Application',
    });
    expect(await service.element(modelId, 'baker')).toMatchObject({ stakeholderKind: 'Human' });
    expect(await service.element(modelId, 'odd')).toMatchObject({
      stakeholderKind: 'Human',
      properties: { stakeholderKind: 'robot' },
    });
    expect(await service.element(modelId, 'oven')).not.toHaveProperty('stakeholderKind');

    const agents = await service.searchElements(modelId, {
      type: 'Stakeholder',
      filters: { stakeholderKind: ['AI Agent'] },
    });
    expect(agents.elements.map((element) => element.id)).toEqual(['bot']);
    // The hint's search for people: Stakeholders without Kind are Human; other types never match.
    const people = await service.searchElements(modelId, {
      type: 'Stakeholder',
      filters: { stakeholderKind: ['Human'] },
    });
    expect(people.elements.map((element) => element.id)).toEqual(['baker', 'listed']);
    const anyType = await service.searchElements(modelId, {
      filters: { stakeholderKind: ['AI Agent'] },
    });
    expect(anyType.elements.map((element) => element.id)).toEqual(['bot']);
    const neighbours = await service.neighbours(modelId, 'oven', 1);
    expect(neighbours.elements).toContainEqual({
      id: 'bot',
      name: 'Order bot',
      type: 'Stakeholder',
      stakeholderKind: 'AI Agent',
      steps: 1,
    });
  });
});

describe('ArchiMate (OEF) import: Kind', () => {
  it('sets no Kind, and keeps a property that would land on its key as custom metadata', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="m">
  <name xml:lang="en">Made-up</name>
  <elements>
    <element identifier="a" xsi:type="BusinessActor"><name>Made-up actor</name>
      <properties>
        <property propertyDefinitionRef="p1"><value>Robot</value></property>
        <property propertyDefinitionRef="p2"><value>Person</value></property>
      </properties>
    </element>
  </elements>
  <propertyDefinitions>
    <propertyDefinition identifier="p1"><name>Stakeholder Kind</name></propertyDefinition>
    <propertyDefinition identifier="p2"><name>Kind</name></propertyDefinition>
  </propertyDefinitions>
</model>`;
    const { jgf } = convertOef(xml, agreedMapping);
    expect(jgf.graph.nodes?.a?.metadata).toEqual({
      type: 'Stakeholder',
      archimateType: 'BusinessActor',
      oefStakeholderKind: 'Robot',
      kind: 'Person',
    });
    expect(validateJgf(jgf)).toMatchObject({ valid: true, warningCount: 0 });
  });
});

import {
  buildModelGraph,
  edgeArchitectureState,
  fieldValueCounts,
  filterElements,
  filterFields,
  findElements,
  isFilterableKey,
  matchesFilters,
  searchElements,
  type JgfDocument,
  type JgfNode,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { sampleModel } from '../src/jgf/sample.js';
import { expectGrowthBelow } from './growth.js';

// Element list filters (shared/src/filters.ts) and edge Architecture state.
// Made-up data only.

const node = (label: string, metadata: Record<string, unknown>): JgfNode => ({ label, metadata });

const zoo: JgfDocument = {
  graph: {
    label: 'Zoo',
    nodes: {
      keeper: node('Keeper', { type: 'Stakeholder', description: 'Feeds animals.' }),
      feeding: node('Feeding', { type: 'Business', owningTeam: 'Care' }),
      tickets: node('Ticket app', {
        type: 'Application',
        architectureState: 'Target',
        functions: ['Sell'],
        owningTeam: 'IT',
        sourcing: 'Buy',
        supplierHqCountry: 'NL',
        archimateType: 'ApplicationComponent',
        hosting: 'Cloud',
        tier: 1,
        critical: true,
      }),
      gates: node('Gate control', {
        type: 'Application',
        architectureState: 'Current',
        owningTeam: 'IT',
        sourcing: 'Build',
        hosting: 'On premises',
        tags: ['a', 'b'],
      }),
      cameras: node('Cameras', {
        type: 'Infrastructure',
        architectureState: 'Deprecate',
        owningTeam: '  ',
        hosting: 'Cloud',
        'simplearchitecture:internal': 'x',
      }),
      map: node('Zoo map', { type: 'Other', notes: { nested: true }, region: ['North'] }),
      shop: node('Gift shop', { type: 'Other', region: 'South', notes: 'Busy' }),
    },
    edges: [],
  },
};
const graph = buildModelGraph(zoo);
const ids = (elements: { id: string }[]) => elements.map((e) => e.id).sort();

describe('filterFields', () => {
  it('lists standard fields in metamodel order, then custom keys by name', () => {
    expect(filterFields(graph).map((f) => [f.key, f.label, f.standard])).toEqual([
      ['owningTeam', 'Owning team', true],
      ['architectureState', 'Architecture state', true],
      ['sourcing', 'Sourcing', true],
      ['supplierHqCountry', 'Supplier HQ country', true],
      ['critical', 'critical', false],
      ['hosting', 'hosting', false],
      ['tier', 'tier', false],
    ]);
  });

  it('counts each value and the elements without one', () => {
    const fields = new Map(filterFields(graph).map((f) => [f.key, f]));
    // Choice values in metamodel order (Deprecate, Current, Target).
    expect(fields.get('architectureState')).toMatchObject({
      values: [
        { value: 'Deprecate', count: 1 },
        { value: 'Current', count: 1 },
        { value: 'Target', count: 1 },
      ],
      notSetCount: 4,
    });
    // A blank text is "not set".
    expect(fields.get('owningTeam')).toMatchObject({
      // Other fields: by count, high to low, then by name.
      values: [
        { value: 'IT', count: 2 },
        { value: 'Care', count: 1 },
      ],
      notSetCount: 4,
    });
    expect(fields.get('hosting')?.values).toEqual([
      { value: 'Cloud', count: 2 },
      { value: 'On premises', count: 1 },
    ]);
    expect(fields.get('tier')?.values).toEqual([{ value: '1', count: 1 }]);
    expect(fields.get('critical')?.values).toEqual([{ value: 'true', count: 1 }]);
  });

  it('leaves out the type, description, functions, archimateType, internal keys and non-scalar keys', () => {
    const keys = filterFields(graph).map((f) => f.key);
    for (const key of [
      'type',
      'description',
      'functions',
      'archimateType',
      'simplearchitecture:internal',
      'tags',
      'notes',
      // A list or an object on any element leaves the key out, even with text elsewhere.
      'region',
    ]) {
      expect(keys).not.toContain(key);
    }
    for (const key of [
      'type',
      'description',
      'functions',
      'archimateType',
      'simplearchitecture:x',
    ]) {
      expect(isFilterableKey(key), key).toBe(false);
    }
    expect(isFilterableKey('hosting')).toBe(true);
  });

  it('finds the standard and custom fields of the made-up sample model', () => {
    const fields = filterFields(buildModelGraph(sampleModel));
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      const withValue = field.values.reduce((sum, v) => sum + v.count, 0);
      expect(withValue + field.notSetCount).toBe(buildModelGraph(sampleModel).elements.size);
    }
  });

  it('is empty for an empty model', () => {
    expect(filterFields(buildModelGraph({ graph: {} }))).toEqual([]);
  });
});

describe('filterElements', () => {
  it('returns every element when no filter is active', () => {
    expect(filterElements(graph, {})).toHaveLength(7);
    expect(filterElements(graph, { hosting: [] })).toHaveLength(7);
  });

  it('combines values of one field with OR', () => {
    expect(ids(filterElements(graph, { architectureState: ['Target', 'Deprecate'] }))).toEqual([
      'cameras',
      'tickets',
    ]);
  });

  it('combines fields with AND', () => {
    expect(ids(filterElements(graph, { hosting: ['Cloud'], owningTeam: ['IT'] }))).toEqual([
      'tickets',
    ]);
  });

  it('matches "(not set)" (null) on elements without the key, or with a blank or non-scalar value', () => {
    expect(ids(filterElements(graph, { owningTeam: [null] }))).toEqual([
      'cameras',
      'keeper',
      'map',
      'shop',
    ]);
    expect(ids(filterElements(graph, { architectureState: ['Current', null] }))).toEqual([
      'feeding',
      'gates',
      'keeper',
      'map',
      'shop',
    ]);
  });

  it('matches numbers and true/false by their text', () => {
    expect(ids(filterElements(graph, { tier: ['1'], critical: ['true'] }))).toEqual(['tickets']);
  });

  it('agrees with matchesFilters, and never matches an unknown value', () => {
    const filters = { hosting: ['Cloud'] };
    const expected = [...graph.elements.values()].filter((e) => matchesFilters(e, filters));
    expect(filterElements(graph, filters)).toEqual(expected);
    expect(filterElements(graph, { hosting: ['Moon'] })).toEqual([]);
  });

  it('treats a filter key such as __proto__ as a plain key', () => {
    const filters = JSON.parse('{"__proto__":["x"]}') as Record<string, string[]>;
    expect(filterElements(graph, filters)).toEqual([]);
  });
});

describe('fieldValueCounts: counts follow search and the other fields', () => {
  const fields = new Map(filterFields(graph).map((f) => [f.key, f]));
  const hosting = fields.get('hosting');
  if (!hosting) throw new Error('hosting field expected');

  it('counts over the whole model without search or filters', () => {
    expect(fieldValueCounts(graph, hosting, {})).toEqual({
      values: hosting.values,
      notSetCount: hosting.notSetCount,
    });
  });

  it("ignores the field's own filter, applies the others and search, and keeps the order", () => {
    const filters = { hosting: ['Cloud'], owningTeam: ['IT'] };
    expect(fieldValueCounts(graph, hosting, { filters })).toEqual({
      values: [
        { value: 'Cloud', count: 1 },
        { value: 'On premises', count: 1 },
      ],
      notSetCount: 0,
    });
    expect(fieldValueCounts(graph, hosting, { filters, query: 'gate' })).toEqual({
      values: [
        { value: 'Cloud', count: 0 },
        { value: 'On premises', count: 1 },
      ],
      notSetCount: 0,
    });
  });
});

describe('findElements: search AND filters', () => {
  it('is the intersection of searchElements and filterElements', () => {
    const filters = { hosting: ['Cloud', 'On premises'] };
    for (const query of ['', 'a', 'ticket', 'zzz']) {
      const searched = new Set(searchElements(graph, query));
      const expected = filterElements(graph, filters).filter((e) => searched.has(e));
      expect(ids(findElements(graph, { query, filters })), query).toEqual(ids(expected));
    }
    expect(ids(findElements(graph, { query: 'GATE' }))).toEqual(['gates']);
  });

  it('stays linear on a large model', async () => {
    const graphOf = (size: number) => {
      const nodes: Record<string, JgfNode> = {};
      for (let i = 0; i < size; i++) {
        nodes[`n${i}`] = node(`Element ${i}`, {
          type: 'Application',
          architectureState: i % 3 === 0 ? 'Target' : 'Current',
          [`custom${i % 100}`]: `v${i % 7}`,
        });
      }
      return buildModelGraph({ graph: { nodes } });
    };
    const filterAll = (graph: ReturnType<typeof graphOf>) => ({
      fields: filterFields(graph),
      found: findElements(graph, {
        query: 'element 1',
        filters: { architectureState: ['Target'], custom1: ['v1', null] },
      }),
    });
    const graphs = new Map([12_500, 50_000].map((size) => [size, graphOf(size)]));
    const big = graphs.get(50_000);
    if (!big) throw new Error('fixture');
    const { fields, found } = filterAll(big);
    expect(fields).toHaveLength(101);
    expect(found.length).toBeGreaterThan(0);
    await expectGrowthBelow(
      (size: number) => () => {
        const graph = graphs.get(size);
        if (!graph) throw new Error('fixture');
        return filterAll(graph);
      },
      12_500,
      50_000,
    );
  });
});

describe('edge Architecture state', () => {
  it('reads the state from edge metadata; missing or unknown means Current', () => {
    expect(edgeArchitectureState({ architectureState: 'Target' })).toBe('Target');
    expect(edgeArchitectureState({ architectureState: 'Deprecate' })).toBe('Deprecate');
    expect(edgeArchitectureState({})).toBe('Current');
    expect(edgeArchitectureState(undefined)).toBe('Current');
    expect(edgeArchitectureState({ architectureState: 'Later' })).toBe('Current');
  });

  it('is on every relationship of the model graph', () => {
    const states = buildModelGraph(sampleModel).relationships.map((r) => [
      r.id,
      r.architectureState,
    ]);
    expect(states).toEqual([
      ['customer-to-shop', 'Current'],
      ['shop-to-payments', 'Current'],
      ['shop-to-orders', 'Target'],
    ]);
  });
});

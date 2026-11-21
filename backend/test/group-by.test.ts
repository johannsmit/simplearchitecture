import {
  buildModelGraph,
  compareGroupValues,
  elementGroupValue,
  groupByChoices,
  groupByLabel,
  isGroupByKey,
  storedGroupValue,
  type ElementPropertyDefinition,
  type JgfDocument,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';

// Group by's rules, shared by the canvas and the API: which properties a model offers, an
// element's value, the order of the groups, and a value as a view stores it. Made-up model.

const fleet: JgfDocument = {
  graph: {
    label: 'Made-up fleet',
    nodes: {
      driver: { label: 'Driver', metadata: { type: 'Stakeholder', owningTeam: 'Ignored' } },
      robot: {
        label: 'Router bot',
        metadata: { type: 'Stakeholder', stakeholderKind: 'AI Agent' },
      },
      depot: {
        label: 'Depot',
        metadata: {
          type: 'Business',
          owningTeam: ' Yard team ',
          hosting: 'Cloud',
          tags: ['a', 'b'],
          archimateType: 'BusinessActor',
          description: 'Where vans park',
        },
      },
      planner: {
        label: 'Planner',
        metadata: {
          type: 'Application',
          owningTeam: 'yard team',
          architectureState: 'Target',
          supplierHqCountry: 'NL',
          functions: ['Plan'],
          hosting: 'On site',
          floor: 3,
          remote: true,
          tags: 'one',
        },
      },
      van: { label: 'Van', metadata: { type: 'Infrastructure', owningTeam: '' } },
    },
    edges: [],
  },
};

const graph = buildModelGraph(fleet);
const element = (id: string) => {
  const found = graph.elements.get(id);
  if (!found) throw new Error(id);
  return found;
};

describe('Group by choices', () => {
  it('lists Type, the standard single-value properties in order, then custom keys A to Z', () => {
    expect(groupByChoices(graph)).toEqual([
      { key: 'type', label: 'Type', standard: true },
      { key: 'owningTeam', label: 'Owning team', standard: true },
      { key: 'architectureState', label: 'Architecture state', standard: true },
      { key: 'stakeholderKind', label: 'Kind', standard: true },
      { key: 'supplierHqCountry', label: 'Supplier HQ country', standard: true },
      { key: 'floor', label: 'floor', standard: false },
      { key: 'hosting', label: 'hosting', standard: false },
      { key: 'remote', label: 'remote', standard: false },
    ]);
  });

  it('never offers Description, Functions, an undefined archimateType, keys holding a list, or __proto__', () => {
    const keys = groupByChoices(graph).map((choice) => choice.key);
    for (const key of ['description', 'functions', 'archimateType', 'tags']) {
      expect(keys).not.toContain(key);
    }
    for (const key of ['description', 'functions', '__proto__', '', ' ']) {
      expect(isGroupByKey(key), key).toBe(false);
    }
    expect(isGroupByKey('simplearchitecture:stored')).toBe(false);
    expect(isGroupByKey('k'.repeat(101))).toBe(false);
    // archimateType can be an element property's key: then the model offers it.
    for (const key of ['type', 'owningTeam', 'Cost centre', 'archimateType', 'k'.repeat(100)]) {
      expect(isGroupByKey(key), key).toBe(true);
    }
  });

  it('offers Text and Choice element properties by name, a choice in its options’ order, never a Reference', () => {
    const define = (
      key: string,
      name: string,
      kind: ElementPropertyDefinition['kind'],
      options?: string[],
    ): ElementPropertyDefinition => ({
      key,
      name,
      kind,
      ...(options === undefined ? {} : { options }),
      fromModels: false,
      version: 1,
    });
    const definitions = [
      define('hosting', 'Hosted at', 'choice', ['On site', 'Cloud']),
      define('archimateType', 'ArchiMate type', 'text'),
      define('floor', 'Floor', 'reference'),
    ];
    const defined = buildModelGraph(fleet, [], definitions);
    expect(groupByChoices(defined).filter((choice) => !choice.standard)).toEqual([
      { key: 'archimateType', label: 'ArchiMate type', standard: false },
      { key: 'hosting', label: 'Hosted at', standard: false },
      { key: 'remote', label: 'remote', standard: false },
    ]);
    expect(groupByLabel('hosting', definitions)).toBe('Hosted at');
    const order = compareGroupValues('hosting', definitions);
    expect(['Cloud', undefined, 'On site'].sort(order)).toEqual(['On site', 'Cloud', undefined]);
  });

  it('labels a key as the panel does', () => {
    expect(groupByLabel('type')).toBe('Type');
    expect(groupByLabel('stakeholderKind')).toBe('Kind');
    expect(groupByLabel('Cost centre')).toBe('Cost centre');
  });
});

describe("an element's group", () => {
  it('reads the value as the Filter does: trimmed, case kept, empty is Not set', () => {
    expect(elementGroupValue(element('depot'), 'owningTeam')).toBe('Yard team');
    expect(elementGroupValue(element('planner'), 'owningTeam')).toBe('yard team');
    expect(elementGroupValue(element('van'), 'owningTeam')).toBeUndefined();
    expect(elementGroupValue(element('planner'), 'floor')).toBe('3');
    expect(elementGroupValue(element('planner'), 'remote')).toBe('true');
    expect(elementGroupValue(element('depot'), 'tags')).toBeUndefined();
    expect(elementGroupValue(element('planner'), 'type')).toBe('Application');
  });

  it("is Not set for a standard property the element's type lacks, and Kind reads as Human", () => {
    expect(elementGroupValue(element('driver'), 'owningTeam')).toBeUndefined();
    expect(elementGroupValue(element('driver'), 'stakeholderKind')).toBe('Human');
    expect(elementGroupValue(element('robot'), 'stakeholderKind')).toBe('AI Agent');
    expect(elementGroupValue(element('planner'), 'stakeholderKind')).toBeUndefined();
  });
});

describe('the order of groups', () => {
  const sorted = (key: string, values: (string | undefined)[]) =>
    [...values].sort(compareGroupValues(key));

  it("follows the metamodel's order for Type and choices, A to Z otherwise, Not set last", () => {
    expect(sorted('type', ['Other', undefined, 'Application', 'Stakeholder'])).toEqual([
      'Stakeholder',
      'Application',
      'Other',
      undefined,
    ]);
    expect(sorted('architectureState', ['Target', undefined, 'Odd', 'Deprecate'])).toEqual([
      'Deprecate',
      'Target',
      'Odd',
      undefined,
    ]);
    expect(sorted('owningTeam', [undefined, 'yard', 'Billing', 'apps'])).toEqual([
      'apps',
      'Billing',
      'yard',
      undefined,
    ]);
  });
});

describe('a stored group value', () => {
  it('is null for Not set, and cut to 200 whole characters', () => {
    expect(storedGroupValue(undefined)).toBeNull();
    expect(storedGroupValue('Yard')).toBe('Yard');
    const long = `${'🚚'.repeat(199)}ab`;
    const cut = storedGroupValue(long);
    expect(Array.from(cut ?? '')).toHaveLength(200);
    expect(cut).toBe(`${'🚚'.repeat(199)}a`);
  });
});

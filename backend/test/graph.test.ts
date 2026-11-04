import {
  buildModelGraph,
  customMetadata,
  degree,
  describeRelationship,
  elementArchitectureState,
  elementDescription,
  elementFunctions,
  groupByType,
  matchRange,
  missingRelatedCount,
  missingRelatedElements,
  mostConnected,
  neighbourhood,
  nodeTypeDefinitions,
  relatedElements,
  relationshipGroups,
  relationshipVerb,
  searchElements,
  standardPropertyRows,
  withAddedElements,
  type JgfDocument,
  type JgfEdge,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { expectGrowthBelow, wideGrowthLimit } from './growth.js';

// Shared graph queries (shared/src/graph.ts): the explorer uses them now, an MCP server later.
// Made-up data only.

const edge = (
  source: string,
  target: string,
  relation = 'Relation',
  extra: Partial<JgfEdge> = {},
): JgfEdge => ({ source, target, relation, ...extra });
const flow = (source: string, target: string, extra: Partial<JgfEdge> = {}): JgfEdge =>
  edge(source, target, 'Relation', { ...extra, metadata: { informationFlow: true } });

const sample: JgfDocument = {
  graph: {
    label: 'Bakery',
    nodes: {
      customer: { label: 'Customer', metadata: { type: 'Stakeholder' } },
      shop: {
        label: 'Web Shop',
        metadata: {
          type: 'Application',
          description: 'Takes orders.\r\nOnline.',
          architectureState: 'Current',
          functions: ['Order capture', 7, 'Payment'],
          owningTeam: 'Web',
          archimateType: 'ApplicationComponent',
          zeta: 1,
        },
      },
      planner: { label: 'Oven Planner', metadata: { type: 'Application' } },
      till: { label: 'Till', metadata: { type: 'Application', architectureState: 'Unknown' } },
      ordering: {
        label: 'Ordering',
        metadata: { type: 'Business', architectureState: 'Current', functions: ['x'] },
      },
      zurich: { label: 'Zürich Depot', metadata: { type: 'Infrastructure' } },
      odd: { label: 'Odd', metadata: { type: 'Spaceship' } },
      lonely: { metadata: { type: 'Other' } },
    },
    edges: [
      flow('customer', 'shop', { id: 'e1', label: ' Places orders ' }),
      edge('shop', 'planner', 'Relation', { id: 'e2' }),
      edge('planner', 'zurich', 'Relation'),
      flow('till', 'shop'),
      flow('shop', 'ordering'),
      edge('shop', 'shop', 'Relation', { id: 'self' }),
      edge('shop', 'missing'),
      edge('shop', 'planner', 'Telepathy'),
    ],
  },
};

const graph = buildModelGraph(sample);

describe('buildModelGraph', () => {
  it('indexes elements and relationships and leaves out broken edges', () => {
    expect(graph.name).toBe('Bakery');
    expect(graph.elements.size).toBe(8);
    expect(graph.relationships).toHaveLength(6);
    expect(graph.skippedRelationships).toBe(2);
    expect(graph.elements.get('lonely')?.name).toBe('');
    // A type outside the metamodel counts as Other (stored models are validated, so it's rare).
    expect(graph.elements.get('odd')?.type).toBe('Other');
  });

  it('gives edges without an id a stable one, and trims labels', () => {
    expect(graph.relationships.map((r) => r.id)).toEqual([
      'e1',
      'e2',
      'edges[2]',
      'edges[3]',
      'edges[4]',
      'self',
    ]);
    expect(graph.relationships[0]?.label).toBe('Places orders');
    expect(graph.relationships[1]?.label).toBeUndefined();
  });

  it('counts a self-relationship once', () => {
    expect(degree(graph, 'shop')).toBe(5);
    expect(degree(graph, 'shop', new Set(['Contains']))).toBe(0);
    expect(degree(graph, 'lonely')).toBe(0);
  });
});

describe('search and grouping', () => {
  it('searches names case- and accent-insensitively', () => {
    expect(searchElements(graph, 'zurich').map((e) => e.id)).toEqual(['zurich']);
    expect(searchElements(graph, '  SHOP ').map((e) => e.id)).toEqual(['shop']);
    expect(searchElements(graph, '')).toHaveLength(8);
  });

  it('finds the match range in the original text', () => {
    expect(matchRange('Zürich Depot', 'uri')).toEqual([1, 4]);
    expect(matchRange('Web Shop', 'shop')).toEqual([4, 8]);
    expect(matchRange('Web Shop', 'x')).toBeUndefined();
    expect(matchRange('Web Shop', ' ')).toBeUndefined();
  });

  it('groups by node type in metamodel order, sorted by name', () => {
    const groups = groupByType(graph.elements.values());
    expect(groups.map((g) => g.type)).toEqual([
      'Stakeholder',
      'Business',
      'Application',
      'Infrastructure',
      'Other',
    ]);
    expect(groups[2]?.elements.map((e) => e.name)).toEqual(['Oven Planner', 'Till', 'Web Shop']);
  });

  it('sorts names with numbers naturally', () => {
    const numbered = buildModelGraph({
      graph: {
        nodes: {
          a: { label: 'Item 10', metadata: { type: 'Other' } },
          b: { label: 'item 2', metadata: { type: 'Other' } },
        },
      },
    });
    expect(groupByType(numbered.elements.values())[0]?.elements.map((e) => e.name)).toEqual([
      'item 2',
      'Item 10',
    ]);
  });

  it('lists the most connected elements, most first', () => {
    expect(mostConnected(graph, 2).map((e) => e.id)).toEqual(['shop', 'planner']);
    expect(mostConnected(graph, 20).some((e) => e.id === 'lonely')).toBe(false);
  });
});

describe('neighbourhood', () => {
  it('follows relationships both ways up to the depth', () => {
    const one = neighbourhood(graph, 'planner', { depth: 1 });
    expect([...one.hops]).toEqual([
      ['planner', 0],
      ['shop', 1],
      ['zurich', 1],
    ]);
    expect(one.relationships.map((r) => r.id)).toEqual(['e2', 'edges[2]', 'self']);

    const two = neighbourhood(graph, 'planner', { depth: 2 });
    expect(two.hops.get('customer')).toBe(2);
    expect(two.hops.size).toBe(6);
    // Every relationship between shown elements, the self-relationship included.
    expect(two.relationships.map((r) => r.id).sort()).toEqual(
      ['e1', 'e2', 'edges[2]', 'edges[3]', 'edges[4]', 'self'].sort(),
    );
    expect(two.capped).toBe(false);
    expect(two.reachable).toBe(6);
  });

  it('follows only the given relationship types', () => {
    const hood = neighbourhood(graph, 'shop', { depth: 3, types: new Set(['Contains']) });
    expect([...hood.hops.keys()]).toEqual(['shop']);
    expect(neighbourhood(graph, 'shop', { depth: 3, types: new Set(['Relation']) }).hops.size).toBe(
      6,
    );
    expect(neighbourhood(graph, 'shop', { depth: 3, types: new Set() }).hops.size).toBe(1);
  });

  it('caps the elements, nearest first and then most connected, keeping paths', () => {
    const nodes: Record<string, { label: string; metadata: { type: string } }> = {
      hub: { label: 'Hub', metadata: { type: 'Application' } },
    };
    const edges: JgfEdge[] = [];
    for (let i = 0; i < 10; i++) {
      nodes[`n${i}`] = { label: `Near ${i}`, metadata: { type: 'Application' } };
      edges.push(edge('hub', `n${i}`));
      for (let j = 0; j < 3; j++) {
        nodes[`f${i}-${j}`] = { label: `Far ${i}-${j}`, metadata: { type: 'Other' } };
        edges.push(edge(`n${i}`, `f${i}-${j}`));
      }
    }
    // n7 is the most connected near element.
    edges.push(edge('n7', 'f0-0'), edge('n7', 'f1-0'));
    const big = buildModelGraph({ graph: { nodes, edges } });

    const hood = neighbourhood(big, 'hub', { depth: 2, cap: 15 });
    expect(hood.hops.size).toBe(15);
    expect(hood.reachable).toBe(41);
    expect(hood.capped).toBe(true);
    // All ten near elements come before any far one.
    expect([...hood.hops.values()].filter((hop) => hop === 1)).toHaveLength(10);
    expect([...hood.hops.keys()][1]).toBe('n7');
    // Every kept far element is linked to a kept near element.
    for (const [id, hop] of hood.hops) {
      if (hop !== 2) continue;
      expect(hood.relationships.some((r) => r.source.startsWith('n') && r.target === id)).toBe(
        true,
      );
    }
  });

  it('defaults to the 150 cap and clamps the depth to 1–3', () => {
    const nodes: Record<string, { metadata: { type: string } }> = {
      hub: { metadata: { type: 'Other' } },
    };
    const edges: JgfEdge[] = [];
    for (let i = 0; i < 200; i++) {
      nodes[`n${i}`] = { metadata: { type: 'Other' } };
      edges.push(edge('hub', `n${i}`));
    }
    const star = buildModelGraph({ graph: { nodes, edges } });
    const hood = neighbourhood(star, 'hub', { depth: 9 });
    expect(hood.hops.size).toBe(150);
    expect(hood.reachable).toBe(201);
    expect(neighbourhood(star, 'n1', { depth: 9 }).hops.size).toBe(150);
  });

  it('is empty for an unknown element', () => {
    const hood = neighbourhood(graph, 'nope', { depth: 1 });
    expect(hood.hops.size).toBe(0);
    expect(hood.reachable).toBe(0);
  });
});

describe('relationships in words', () => {
  it('has a verb per type and direction', () => {
    expect(relationshipVerb('Relation', 'outgoing', true)).toBe('sends information to');
    expect(relationshipVerb('Relation', 'incoming', true)).toBe('receives information from');
    expect(relationshipVerb('Relation', 'both', true)).toBe('exchanges information both ways with');
    expect(relationshipVerb('Contains', 'outgoing', true)).toBe('contains');
    expect(relationshipVerb('Relation', 'outgoing')).toBe('relates to');
    expect(relationshipVerb('Relation', 'incoming')).toBe('is related to');
  });

  it('groups an element’s relationships per type and direction, sorted by name', () => {
    const groups = relationshipGroups(graph, 'shop');
    expect(groups.map((g) => [g.heading, g.rows.map((r) => r.other.name)])).toEqual([
      ['Sends information to', ['Ordering']],
      ['Receives information from', ['Customer', 'Till']],
      ['Relates to', ['Oven Planner', 'Web Shop']],
    ]);
    const self = groups[2]?.rows.find((row) => row.self);
    expect(self?.other.id).toBe('shop');
    expect(relationshipGroups(graph, 'lonely')).toEqual([]);
  });

  it('describes a relationship as a sentence', () => {
    const first = graph.relationships[0];
    expect(first && describeRelationship(graph, first)).toBe(
      '"Customer" sends information to "Web Shop"',
    );
  });
});

describe('element details', () => {
  const shop = graph.elements.get('shop');
  const ordering = graph.elements.get('ordering');
  const till = graph.elements.get('till');
  if (!shop || !ordering || !till) throw new Error('fixture');

  it('reads description, functions and Architecture state where the type has them', () => {
    expect(elementDescription(shop)).toBe('Takes orders.\nOnline.');
    expect(elementFunctions(shop)).toEqual(['Order capture', 'Payment']);
    expect(elementArchitectureState(shop)).toBe('Current');
    // Business has no functions or Architecture state in the metamodel.
    expect(elementFunctions(ordering)).toEqual([]);
    expect(elementArchitectureState(ordering)).toBeUndefined();
    expect(elementArchitectureState(till)).toBeUndefined();
  });

  it('lists standard properties in metamodel order without description and functions', () => {
    const rows = standardPropertyRows(shop);
    expect(rows.map((r) => r.key)).toEqual(
      nodeTypeDefinitions.Application.properties.filter(
        (key) => key !== 'description' && key !== 'functions',
      ),
    );
    expect(rows.find((r) => r.key === 'owningTeam')?.value).toBe('Web');
    expect(rows.find((r) => r.key === 'sourcing')?.value).toBeUndefined();
  });

  it('lists custom metadata, including properties not standard for the type, by key', () => {
    expect(customMetadata(shop).map(([key]) => key)).toEqual(['archimateType', 'zeta']);
    expect(customMetadata(ordering).map(([key]) => key)).toEqual([
      'architectureState',
      'functions',
    ]);
  });
});

describe('related elements and adding them', () => {
  it('lists each related element once per group, without the element itself', () => {
    const doubled = buildModelGraph({
      graph: {
        nodes: {
          a: { label: 'A', metadata: { type: 'Application' } },
          b: { label: 'B', metadata: { type: 'Application' } },
          c: { label: 'C', metadata: { type: 'Other' } },
        },
        edges: [flow('a', 'b'), flow('a', 'b'), edge('a', 'c', 'Relation'), edge('a', 'a')],
      },
    });
    expect(
      relatedElements(doubled, 'a').map((g) => [g.heading, g.elements.map((e) => e.id)]),
    ).toEqual([
      ['Sends information to', ['b']],
      ['Relates to', ['c']],
    ]);
    expect(relatedElements(doubled, 'a', new Set(['Contains']))).toEqual([]);
    expect(relatedElements(doubled, 'nope')).toEqual([]);
  });

  describe('related elements not shown', () => {
    const missingGraph = buildModelGraph({
      graph: {
        nodes: {
          a: { label: 'A', metadata: { type: 'Application' } },
          b: { label: 'B', metadata: { type: 'Application' } },
          c: { label: 'C', metadata: { type: 'Other' } },
          d: { label: 'D', metadata: { type: 'Business' } },
        },
        edges: [
          // Two relationships to b, one each way, plus one of another type: b counts once.
          flow('a', 'b'),
          flow('b', 'a'),
          edge('a', 'b', 'Relation'),
          edge('a', 'c', 'Relation'),
          flow('d', 'a'),
          flow('a', 'a'),
        ],
      },
    });

    it('counts each missing related element once, never the element itself', () => {
      expect(missingRelatedCount(missingGraph, 'a', new Set(['a']))).toBe(3);
      expect(missingRelatedCount(missingGraph, 'a', new Set(['a', 'b']))).toBe(2);
      expect(missingRelatedCount(missingGraph, 'a', new Set(['a', 'b', 'c', 'd']))).toBe(0);
      // Any id set will do, e.g. a canvas's map of placed cards.
      expect(missingRelatedCount(missingGraph, 'a', new Map([['c', 1]]))).toBe(2);
      expect(missingRelatedCount(missingGraph, 'nope', new Set())).toBe(0);
    });

    it('follows only the given relationship types', () => {
      const shown = new Set(['a']);
      expect(missingRelatedCount(missingGraph, 'a', shown, new Set(['Relation']))).toBe(3);
      expect(missingRelatedCount(missingGraph, 'a', shown, new Set(['Contains']))).toBe(0);
      expect(missingRelatedCount(missingGraph, 'a', shown, new Set())).toBe(0);
    });

    it('lists only the missing elements, leaving out groups that end up empty', () => {
      const list = (shown: Set<string>, types?: ReadonlySet<'Relation' | 'Contains'>) =>
        missingRelatedElements(missingGraph, 'a', shown, types).map((g) => [
          g.heading,
          g.elements.map((e) => e.id),
        ]);
      expect(list(new Set(['a', 'b']))).toEqual([
        ['Receives information from', ['d']],
        ['Relates to', ['c']],
      ]);
      expect(list(new Set(['a', 'c']), new Set(['Contains']))).toEqual([]);
      expect(list(new Set(['a', 'b', 'c', 'd']))).toEqual([]);
    });

    it('stays linear on a hub with many relationships', async () => {
      const hubOf = (size: number) => {
        const nodes: Record<string, { label: string; metadata: { type: string } }> = {
          hub: { label: 'Hub', metadata: { type: 'Application' } },
        };
        const edges: JgfEdge[] = [];
        for (let i = 0; i < size; i++) {
          nodes[`n${i}`] = { label: `Leaf ${i}`, metadata: { type: 'Other' } };
          edges.push(flow('hub', `n${i}`), edge(`n${i}`, 'hub', 'Relation'));
        }
        return buildModelGraph({ graph: { nodes, edges } });
      };
      const shown = new Set(['hub', 'n0', 'n1']);
      const hubs = new Map([625, 10_000, 20_000].map((size) => [size, hubOf(size)]));
      const big = hubs.get(20_000);
      if (!big) throw new Error('fixture');
      expect(missingRelatedCount(big, 'hub', shown)).toBe(19_998);
      await expectGrowthBelow(
        (size: number) => () => {
          const hub = hubs.get(size);
          if (!hub) throw new Error('fixture');
          // Often enough to measure: this is quick.
          for (let i = 0; i < 40; i++) missingRelatedCount(hub, 'hub', shown);
        },
        625,
        10_000,
        wideGrowthLimit,
      );
    });
  });

  it('adds elements to a neighbourhood with their relationships to what is shown', () => {
    const hood = neighbourhood(graph, 'customer', { depth: 1 });
    expect([...hood.hops.keys()]).toEqual(['customer', 'shop']);
    const more = withAddedElements(graph, hood, ['planner', 'planner', 'customer', 'nope']);
    expect(more.added).toEqual(['planner']);
    expect(more.hops.get('planner')).toBe(2);
    expect(more.relationships.map((r) => r.id).sort()).toEqual(['e1', 'e2', 'self'].sort());
    // The original is untouched.
    expect(hood.hops.has('planner')).toBe(false);
    // Nothing to add: the same neighbourhood back.
    expect(withAddedElements(graph, hood, []).hops).toBe(hood.hops);
  });

  describe('what an added element brings', () => {
    const element = (type = 'Other') => ({ metadata: { type } });
    const contains = (source: string, target: string) => ({ source, target, relation: 'Contains' });
    const built = buildModelGraph({
      graph: {
        nodes: Object.fromEntries(
          ['focus', 'near', 'box', 'c1', 'c2', 'g1', 'gg1', 'ggg1', 'peer', 'loopA', 'loopB'].map(
            (id) => [id, element()],
          ),
        ),
        edges: [
          { source: 'focus', target: 'near', relation: 'Relation' },
          contains('box', 'c1'),
          contains('box', 'c2'),
          contains('c1', 'g1'),
          contains('g1', 'gg1'),
          contains('gg1', 'ggg1'),
          contains('box', 'box'),
          contains('loopA', 'loopB'),
          contains('loopB', 'loopA'),
          { source: 'box', target: 'peer', relation: 'Relation' },
          {
            source: 'c1',
            target: 'peer',
            relation: 'Relation',
            metadata: { informationFlow: true },
          },
        ],
      },
    });
    const hood = neighbourhood(built, 'focus', { depth: 1 });
    const brought = (ids: string[], depth: number, cap?: number) =>
      withAddedElements(built, hood, ids, { depth, ...(cap === undefined ? {} : { cap }) });

    it.each([
      [0, ['box']],
      [1, ['box', 'c1', 'c2']],
      [2, ['box', 'c1', 'c2', 'g1']],
      [3, ['box', 'c1', 'c2', 'g1', 'gg1']],
    ])('at depth %i, nearest first, through Contains only', (depth, expected) => {
      expect(brought(['box'], depth).added).toEqual(expected);
    });

    it('ends on a cycle and on an element containing itself', () => {
      expect(brought(['loopA'], 3).added).toEqual(['loopA', 'loopB']);
      expect(brought(['box'], 1).added.filter((id) => id === 'box')).toHaveLength(1);
    });

    it('brings nothing up the chain: a contained element added alone stays alone', () => {
      expect(brought(['ggg1'], 3).added).toEqual(['ggg1']);
    });

    it('numbers the steps from the added element', () => {
      const { hops } = brought(['box'], 2);
      expect(hops.get('c1')).toBe((hops.get('box') ?? 0) + 1);
      expect(hops.get('g1')).toBe((hops.get('c1') ?? 0) + 1);
    });

    it('reaches through elements already shown, adding them once', () => {
      const first = withAddedElements(built, hood, ['c1'], { depth: 0 });
      const more = withAddedElements(built, first, ['box'], { depth: 2 });
      expect(more.added).toEqual(['box', 'c2', 'g1']);
      // An added element the neighbourhood already shows still brings its contents.
      const shown = neighbourhood(built, 'box', { depth: 1 });
      expect(withAddedElements(built, shown, ['c1'], { depth: 1 }).added).toEqual(['g1']);
    });

    it('reports what the cap refuses, once each, and keeps the nearest', () => {
      const capped = brought(['box', 'c1'], 2, 4);
      expect([...capped.hops.keys()]).toEqual(['focus', 'near', 'box', 'c1']);
      expect(capped.refused).toEqual(['c2', 'g1', 'gg1']);
    });

    it('brings nothing when Contains isn’t followed', () => {
      const result = withAddedElements(built, hood, ['box'], {
        depth: 3,
        types: new Set(['Relation'] as const),
      });
      expect(result.added).toEqual(['box']);
    });
  });

  it('follows only the given types and respects the cap', () => {
    const hood = neighbourhood(graph, 'customer', { depth: 1 });
    const containsOnly = withAddedElements(graph, hood, ['planner'], {
      types: new Set(['Contains']),
    });
    // Planner relates to the shop by a Relation only: added, but with no relationship drawn.
    expect(containsOnly.relationships.some((r) => r.target === 'planner')).toBe(false);
    const capped = withAddedElements(graph, hood, ['planner', 'till'], { cap: 3 });
    expect(capped.added).toEqual(['planner']);
    expect(capped.refused).toEqual(['till']);
  });
});

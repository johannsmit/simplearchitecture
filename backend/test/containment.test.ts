import {
  analyseContainment,
  type ContainsEdge,
  buildModelGraph,
  childrenOf,
  containerOf,
  containment,
  isNestingRelationship,
  neighbourhood,
  relationshipGroups,
  relationshipVerb,
  withContainers,
  type JgfDocument,
  type JgfEdge,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { validateJgf } from '../src/jgf/validate.js';
import { expectGrowthBelow } from './growth.js';

// The Contains relationship: shared nesting rules and validation warnings.
// Made-up data only.

const contains = (id: string, source: string, target: string): JgfEdge => ({
  id,
  source,
  target,
  relation: 'Contains',
});

function documentWith(nodeIds: string[], edges: JgfEdge[]): JgfDocument {
  return {
    graph: {
      label: 'Garden centre',
      nodes: Object.fromEntries(
        nodeIds.map((id) => [id, { label: `Item ${id}`, metadata: { type: 'Application' } }]),
      ),
      edges,
    },
  };
}

describe('Contains in the data', () => {
  it('validates, counts and keeps a Contains edge with Architecture state', () => {
    const doc = documentWith(
      ['site', 'till'],
      [{ ...contains('c1', 'site', 'till'), metadata: { architectureState: 'Target' } }],
    );
    const result = validateJgf(doc);
    expect(result).toMatchObject({ valid: true, errorCount: 0, warningCount: 0 });
    expect(result.summary.edges.byRelation).toEqual({
      Relation: 0,
      Contains: 1,
    });
    const graph = buildModelGraph(doc);
    expect(graph.relationships[0]).toMatchObject({ type: 'Contains', architectureState: 'Target' });
  });

  it('reads in words from both ends', () => {
    expect(relationshipVerb('Contains', 'outgoing')).toBe('contains');
    expect(relationshipVerb('Contains', 'incoming')).toBe('is contained in');
    const graph = buildModelGraph(documentWith(['a', 'b'], [contains('c1', 'a', 'b')]));
    expect(relationshipGroups(graph, 'b').map((group) => group.heading)).toEqual([
      'Is contained in',
    ]);
  });
});

describe('nesting: which Contains relationships nest and which are drawn as lines', () => {
  it('nests the target inside the source, as a forest', () => {
    const graph = buildModelGraph(
      documentWith(
        ['site', 'hall', 'till', 'oven', 'x'],
        [
          contains('c1', 'site', 'hall'),
          contains('c2', 'hall', 'till'),
          contains('c3', 'hall', 'oven'),
          { id: 'f1', source: 'till', target: 'x', relation: 'Relation' },
        ],
      ),
    );
    expect(containerOf(graph, 'till')).toBe('hall');
    expect(containerOf(graph, 'hall')).toBe('site');
    expect(containerOf(graph, 'site')).toBeUndefined();
    expect(containerOf(graph, 'x')).toBeUndefined();
    expect(childrenOf(graph, 'hall')).toEqual(['till', 'oven']);
    expect(childrenOf(graph, 'till')).toEqual([]);
    for (const relationship of graph.relationships) {
      expect(isNestingRelationship(graph, relationship)).toBe(relationship.type === 'Contains');
    }
    expect(containment(graph)).toBe(containment(graph)); // worked out once per graph
  });

  it('nests an element with several containers in the first in model order; the others are lines', () => {
    const graph = buildModelGraph(
      documentWith(
        ['a', 'b', 'c', 't'],
        [contains('z9', 'b', 't'), contains('b1', 'a', 't'), contains('m5', 'c', 't')],
      ),
    );
    expect(containerOf(graph, 't')).toBe('b');
    const nesting = graph.relationships.filter((r) => isNestingRelationship(graph, r));
    expect(nesting.map((r) => r.id)).toEqual(['z9']);
    expect(containment(graph).multipleContainers.get('t')).toBe(3);
  });

  it('nests parallel relationships from the chosen container (they count as one container)', () => {
    const graph = buildModelGraph(
      documentWith(['a', 't'], [contains('c2', 'a', 't'), contains('c1', 'a', 't')]),
    );
    expect(containerOf(graph, 't')).toBe('a');
    expect(childrenOf(graph, 'a')).toEqual(['t']);
    expect(graph.relationships.every((r) => isNestingRelationship(graph, r))).toBe(true);
    expect(containment(graph).multipleContainers.size).toBe(0);
  });

  it('draws an element containing itself, and every relationship in a cycle, as lines', () => {
    const graph = buildModelGraph(
      documentWith(
        ['self', 'a', 'b', 'c', 'outside', 'inner'],
        [
          contains('s', 'self', 'self'),
          contains('ab', 'a', 'b'),
          contains('bc', 'b', 'c'),
          contains('ca', 'c', 'a'),
          contains('in', 'outside', 'a'), // into the cycle: nests
          contains('out', 'c', 'inner'), // out of the cycle: nests
        ],
      ),
    );
    const found = containment(graph);
    expect(found.selfContains.map((r) => r.id)).toEqual(['s']);
    expect(found.inCycle.map((r) => r.id).sort()).toEqual(['ab', 'bc', 'ca']);
    expect(containerOf(graph, 'self')).toBeUndefined();
    expect(containerOf(graph, 'a')).toBe('outside');
    expect(containerOf(graph, 'b')).toBeUndefined();
    expect(containerOf(graph, 'inner')).toBe('c');
    expect(
      graph.relationships.filter((r) => isNestingRelationship(graph, r)).map((r) => r.id),
    ).toEqual(['in', 'out']);
  });

  it('ignores relationship types other than Contains', () => {
    const graph = buildModelGraph(
      documentWith(['a', 'b'], [{ source: 'a', target: 'b', relation: 'Relation' }]),
    );
    expect(containerOf(graph, 'b')).toBeUndefined();
    expect(childrenOf(graph, 'a')).toEqual([]);
  });

  it('stays linear on a long chain and a big cycle (no recursion, no quadratic work)', async () => {
    const chainOf = (size: number) =>
      Array.from({ length: size }, (_, i) => ({
        id: `e${i}`,
        source: `n${i}`,
        target: `n${i + 1}`,
      }));
    const n = 100_000;
    const chain = chainOf(n);
    // This deep, recursion would overflow the stack, on any machine.
    const open = analyseContainment(chain);
    const closed = analyseContainment([...chain, { id: 'back', source: `n${n}`, target: 'n0' }]);
    expect(open.nesting.size).toBe(n);
    expect(open.inCycle).toHaveLength(0);
    expect(closed.inCycle).toHaveLength(n + 1);
    expect(closed.nesting.size).toBe(0);
    // Linear, counted, not timed: time here depends on the memory as much as the code, and came too
    // close to quadratic. This counts every read of the input, so a pass over the edges for
    // each edge, or a walk up the chain for each element, shows on any machine.
    const readsOf = (size: number) => {
      let reads = 0;
      const counted = (edge: ContainsEdge): ContainsEdge => ({
        get id() {
          reads += 1;
          return edge.id;
        },
        get source() {
          reads += 1;
          return edge.source;
        },
        get target() {
          reads += 1;
          return edge.target;
        },
      });
      const edges = [...chainOf(size), { id: 'back', source: `n${size}`, target: 'n0' }];
      analyseContainment(
        new Proxy(edges.map(counted), {
          get(list, key, receiver) {
            reads += 1;
            return Reflect.get(list, key, receiver) as unknown;
          },
        }),
      );
      return reads;
    };
    expect(readsOf(32_000)).toBeLessThanOrEqual(16 * readsOf(2000) * 1.01);
  });
});

describe('validation warns about Contains that cannot nest (never errors)', () => {
  it('warns about an element containing itself, a cycle and several containers', () => {
    const result = validateJgf(
      documentWith(
        ['self', 'a', 'b', 'c', 't'],
        [
          contains('s', 'self', 'self'),
          contains('ab', 'a', 'b'),
          contains('ba', 'b', 'a'),
          contains('at', 'a', 't'),
          contains('ct', 'c', 't'),
        ],
      ),
    );
    expect(result).toMatchObject({ valid: true, errorCount: 0 });
    expect(result.warnings.map((w) => [w.code, w.edgeId ?? w.nodeId])).toEqual([
      ['contains-self', 's'],
      ['contains-cycle', 'ab'],
      ['contains-cycle', 'ba'],
      ['multiple-containers', 't'],
      // b is contained by a, and a by b: each has one container only.
    ]);
    expect(result.warnings[0]?.message).toBe(
      'Edge "s": an element can\'t contain itself; this Contains edge is drawn as a line',
    );
    expect(result.warnings[3]?.message).toMatch(/^Node "t": is contained by 2 elements/);
  });

  it('leaves Contains edges with a missing end to the unknown-node error', () => {
    const result = validateJgf(
      documentWith(['a'], [contains('x', 'a', 'gone'), contains('y', 'gone', 'gone')]),
    );
    expect(result.errors.map((issue) => issue.code)).toEqual([
      'unknown-node',
      'unknown-node',
      'unknown-node',
    ]);
    expect(result.warningCount).toBe(0);
  });

  it('checks a large model in linear time', async () => {
    const documentOf = (size: number) => {
      const ids = Array.from({ length: size }, (_, i) => `n${i}`);
      const edges = ids.slice(1).map((id, i) => contains(`e${i}`, `n${i}`, id));
      edges.push(contains('back', `n${size - 1}`, 'n0'));
      return documentWith(ids, edges);
    };
    const n = 20_000;
    const result = validateJgf(documentOf(n));
    expect(result.warningCount).toBe(n);
    expect(result.errorCount).toBe(0);
    const inputs = new Map([n / 4, n].map((size) => [size, documentOf(size)]));
    await expectGrowthBelow((size: number) => () => validateJgf(inputs.get(size)), n / 4, n);
  });
});

describe('withContainers: a nested element brings its containers onto the canvas', () => {
  const graph = buildModelGraph(
    documentWith(
      ['site', 'hall', 'till', 'shop'],
      [
        contains('c1', 'site', 'hall'),
        contains('c2', 'hall', 'till'),
        { id: 'i1', source: 'shop', target: 'till', relation: 'Relation' },
      ],
    ),
  );

  it('adds the whole chain, one step further each, with the relationships between them', () => {
    const hood = withContainers(graph, neighbourhood(graph, 'shop', { depth: 1 }));
    expect([...hood.hops]).toEqual([
      ['shop', 0],
      ['till', 1],
      ['hall', 2],
      ['site', 3],
    ]);
    expect(hood.relationships.map((r) => r.id).sort()).toEqual(['c1', 'c2', 'i1']);
  });

  it('counts containers towards the cap, and leaves the neighbourhood alone when none is missing', () => {
    const capped = withContainers(graph, neighbourhood(graph, 'shop', { depth: 1 }), { cap: 3 });
    expect([...capped.hops.keys()]).toEqual(['shop', 'till', 'hall']);
    const whole = neighbourhood(graph, 'hall', { depth: 1 });
    expect(withContainers(graph, whole)).toBe(whole);
  });

  it('follows only the relationship types shown', () => {
    const types = new Set(['Relation', 'Contains'] as const);
    const hood = withContainers(graph, neighbourhood(graph, 'shop', { depth: 1, types }), {
      types: new Set(['Relation'] as const),
    });
    expect(hood.relationships.map((r) => r.id)).toEqual(['i1']);
  });
});

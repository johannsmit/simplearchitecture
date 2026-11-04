import {
  buildModelGraph,
  containersOf,
  relationshipProblems,
  type JgfDocument,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';

// The shared Modelling rules for relationships. Made-up data only.

const kitchen: JgfDocument = {
  graph: {
    nodes: {
      house: { label: 'House', metadata: { type: 'Infrastructure' } },
      kitchen: { label: 'Kitchen', metadata: { type: 'Infrastructure' } },
      oven: { label: 'Oven', metadata: { type: 'Application' } },
      cook: { label: 'Cook', metadata: { type: 'Stakeholder' } },
      shed: { label: '', metadata: { type: 'Other' } },
    },
    edges: [
      { id: 'c1', source: 'house', target: 'kitchen', relation: 'Contains' },
      { id: 'c2', source: 'kitchen', target: 'oven', relation: 'Contains' },
      { source: 'cook', target: 'oven', relation: 'Relation', metadata: { informationFlow: true } },
      { id: 'c3', source: 'shed', target: 'oven', relation: 'Contains' },
      { source: 'cook', target: 'shed', relation: 'Contains' },
    ],
  },
};
const graph = buildModelGraph(kitchen);

describe('relationshipProblems', () => {
  it('refuses an element related to itself, for every type', () => {
    for (const type of ['Relation', 'Contains'] as const) {
      expect(relationshipProblems(graph, { source: 'oven', target: 'oven', type })).toEqual([
        { kind: 'self', message: "Can't connect an element to itself." },
      ]);
    }
  });

  it('names the existing Contains for a duplicate, also one without an id', () => {
    expect(
      relationshipProblems(graph, { source: 'house', target: 'kitchen', type: 'Contains' })[0],
    ).toEqual({
      kind: 'duplicate',
      duplicateOf: 'c1',
      message: 'House already contains Kitchen.',
    });
    expect(
      relationshipProblems(graph, { source: 'cook', target: 'shed', type: 'Contains' })[0],
    ).toMatchObject({ kind: 'duplicate', duplicateOf: 'edges[4]' });
    // The relationship being changed doesn't count.
    expect(
      relationshipProblems(graph, {
        source: 'house',
        target: 'kitchen',
        type: 'Contains',
        ignore: 'c1',
      }),
    ).toEqual([]);
  });

  it('lets several Relations link the same two elements, in the same direction', () => {
    expect(
      relationshipProblems(graph, { source: 'cook', target: 'oven', type: 'Relation' }),
    ).toEqual([]);
    expect(
      relationshipProblems(graph, { source: 'oven', target: 'cook', type: 'Relation' }),
    ).toEqual([]);
  });

  it('refuses a Contains cycle with the chain, directly or through others', () => {
    const [direct] = relationshipProblems(graph, {
      source: 'kitchen',
      target: 'house',
      type: 'Contains',
    });
    expect(direct).toEqual({
      kind: 'cycle',
      chain: ['house', 'kitchen'],
      message: 'Not possible: House contains Kitchen.',
    });
    const [through] = relationshipProblems(graph, {
      source: 'oven',
      target: 'house',
      type: 'Contains',
    });
    expect(through).toMatchObject({
      chain: ['house', 'kitchen', 'oven'],
      message: 'Not possible: Oven is inside House (through Kitchen).',
    });
    // Another type isn't a cycle; reversing c1 itself isn't one either.
    expect(
      relationshipProblems(graph, { source: 'oven', target: 'house', type: 'Relation' }),
    ).toEqual([]);
    expect(
      relationshipProblems(graph, {
        source: 'kitchen',
        target: 'house',
        type: 'Contains',
        ignore: 'c1',
      }),
    ).toEqual([]);
  });

  it('lists every container of an element in model order; a second container is no problem', () => {
    expect(containersOf(graph, 'oven')).toEqual(['kitchen', 'shed']);
    expect(containersOf(graph, 'house')).toEqual([]);
    expect(
      relationshipProblems(graph, { source: 'cook', target: 'oven', type: 'Contains' }),
    ).toEqual([]);
  });
});

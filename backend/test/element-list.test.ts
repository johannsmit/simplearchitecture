import {
  buildModelGraph,
  elementListTree,
  findElements,
  listAncestorsOf,
  listParentOf,
  type ElementListGroup,
  type ElementListRow,
  type JgfDocument,
  type JgfEdge,
  type ModelGraph,
  type NodeType,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';

// The nested element list: shared rules in shared/src/element-list.ts.
// Made-up data only.

type Node = [id: string, name: string, type: NodeType];

const contains = (id: string, source: string, target: string): JgfEdge => ({
  id,
  source,
  target,
  relation: 'Contains',
});

function graphOf(nodes: Node[], edges: JgfEdge[] = []): ModelGraph {
  const document: JgfDocument = {
    graph: {
      label: 'Made-up harbour',
      nodes: Object.fromEntries(
        nodes.map(([id, label, type]) => [id, { label, metadata: { type } }]),
      ),
      edges,
    },
  };
  return buildModelGraph(document);
}

/** The tree as ids, `*` marking context rows: ['a', ['b', ['c']]]. */
type Shape = (string | Shape)[];
function shape(rows: ElementListRow[]): Shape {
  return rows.flatMap((row): Shape => {
    const id = `${row.context ? '*' : ''}${row.element.id}`;
    return row.children.length === 0 ? [id] : [id, shape(row.children)];
  });
}

function groupsOf(groups: ElementListGroup[]): Record<string, { rows: Shape; matches: number }> {
  return Object.fromEntries(
    groups.map((group) => [group.type, { rows: shape(group.rows), matches: group.matchCount }]),
  );
}

describe('elementListTree: nesting', () => {
  it('lists an element under a container of the same type', () => {
    const graph = graphOf(
      [
        ['portal', 'Portal', 'Application'],
        ['search', 'Search', 'Application'],
        ['basket', 'Basket', 'Application'],
      ],
      [contains('c1', 'portal', 'search'), contains('c2', 'portal', 'basket')],
    );
    expect(groupsOf(elementListTree(graph))).toEqual({
      Application: { rows: ['portal', ['basket', 'search']], matches: 3 },
    });
    expect(listParentOf(graph, 'search')).toBe('portal');
    expect(listParentOf(graph, 'portal')).toBeUndefined();
  });

  it('keeps an element contained by another type at the top of its own group', () => {
    const graph = graphOf(
      [
        ['sales', 'Sales', 'Business'],
        ['crm', 'CRM', 'Application'],
        ['server', 'Server', 'Infrastructure'],
      ],
      [contains('c1', 'sales', 'crm'), contains('c2', 'crm', 'server')],
    );
    expect(groupsOf(elementListTree(graph))).toEqual({
      Business: { rows: ['sales'], matches: 1 },
      Application: { rows: ['crm'], matches: 1 },
      Infrastructure: { rows: ['server'], matches: 1 },
    });
    expect(listParentOf(graph, 'crm')).toBeUndefined();
  });

  it('uses only the direct container: same type further up does not count', () => {
    const graph = graphOf(
      [
        ['hub', 'Hub', 'Application'],
        ['team', 'Team', 'Business'],
        ['tool', 'Tool', 'Application'],
      ],
      [contains('c1', 'hub', 'team'), contains('c2', 'team', 'tool')],
    );
    expect(groupsOf(elementListTree(graph)).Application?.rows).toEqual(['hub', 'tool']);
  });

  it('with several containers, uses the one the canvas nests it in (first in model order)', () => {
    const graph = graphOf(
      [
        ['zeta', 'Zeta', 'Application'],
        ['alpha', 'Alpha', 'Application'],
        ['shared', 'Shared', 'Application'],
      ],
      [contains('c1', 'zeta', 'shared'), contains('c2', 'alpha', 'shared')],
    );
    expect(groupsOf(elementListTree(graph)).Application?.rows).toEqual([
      'alpha',
      'zeta',
      ['shared'],
    ]);
  });

  it('keeps it at the top when the canvas container is of another type, even if a later one is not', () => {
    const graph = graphOf(
      [
        ['ops', 'Ops', 'Business'],
        ['suite', 'Suite', 'Application'],
        ['ledger', 'Ledger', 'Application'],
      ],
      [contains('c1', 'ops', 'ledger'), contains('c2', 'suite', 'ledger')],
    );
    expect(groupsOf(elementListTree(graph)).Application?.rows).toEqual(['ledger', 'suite']);
    expect(listParentOf(graph, 'ledger')).toBeUndefined();
  });

  it('does not nest an element that contains itself, or elements in a cycle', () => {
    const graph = graphOf(
      [
        ['self', 'Self', 'Other'],
        ['a', 'A', 'Other'],
        ['b', 'B', 'Other'],
        ['c', 'C', 'Other'],
        ['d', 'D', 'Other'],
      ],
      [
        contains('c1', 'self', 'self'),
        contains('c2', 'a', 'b'),
        contains('c3', 'b', 'a'),
        // A cycle of three, with an element hanging off it: that one nests.
        contains('c4', 'c', 'self'),
        contains('c5', 'self', 'c'),
        contains('c6', 'b', 'd'),
      ],
    );
    expect(groupsOf(elementListTree(graph))).toEqual({
      Other: { rows: ['a', 'b', ['d'], 'c', 'self'], matches: 5 },
    });
    for (const id of ['self', 'a', 'b', 'c']) expect(listParentOf(graph, id), id).toBeUndefined();
  });

  it('only Contains nests: other relationships leave the list flat', () => {
    const graph = graphOf(
      [
        ['a', 'A', 'Application'],
        ['b', 'B', 'Application'],
      ],
      [
        { id: 'r1', source: 'a', target: 'b', relation: 'Relation' },
        {
          id: 'r2',
          source: 'a',
          target: 'b',
          relation: 'Relation',
          metadata: { informationFlow: true },
        },
      ],
    );
    expect(groupsOf(elementListTree(graph)).Application?.rows).toEqual(['a', 'b']);
  });

  it('nests to any depth without recursion, and gives the path to open', () => {
    const depth = 5_000;
    const nodes: Node[] = Array.from({ length: depth }, (_, i) => [`n${i}`, `Level ${i}`, 'Other']);
    const edges = Array.from({ length: depth - 1 }, (_, i) =>
      contains(`c${i}`, `n${i}`, `n${i + 1}`),
    );
    const graph = graphOf(nodes, edges);
    const [group] = elementListTree(graph);
    expect(group?.rows).toHaveLength(1);
    expect(group?.matchCount).toBe(depth);
    let row = group?.rows[0];
    let levels = 0;
    while (row !== undefined) {
      expect(row.element.id).toBe(`n${levels}`);
      levels += 1;
      row = row.children[0];
    }
    expect(levels).toBe(depth);

    const path = listAncestorsOf(graph, `n${depth - 1}`);
    expect(path).toHaveLength(depth - 1);
    expect(path.slice(0, 3)).toEqual(['n0', 'n1', 'n2']);
    expect(path.at(-1)).toBe(`n${depth - 2}`);
  });
});

describe('listAncestorsOf', () => {
  const graph = graphOf(
    [
      ['top', 'Top', 'Application'],
      ['mid', 'Mid', 'Application'],
      ['leaf', 'Leaf', 'Application'],
      ['team', 'Team', 'Business'],
    ],
    [contains('c1', 'top', 'mid'), contains('c2', 'mid', 'leaf'), contains('c3', 'team', 'top')],
  );

  it('goes from the top-level row down to the parent, within the type', () => {
    expect(listAncestorsOf(graph, 'leaf')).toEqual(['top', 'mid']);
    expect(listAncestorsOf(graph, 'mid')).toEqual(['top']);
  });

  it('is empty for a top-level element and an unknown id', () => {
    expect(listAncestorsOf(graph, 'top')).toEqual([]);
    expect(listAncestorsOf(graph, 'team')).toEqual([]);
    expect(listAncestorsOf(graph, 'nowhere')).toEqual([]);
    expect(listParentOf(graph, 'nowhere')).toBeUndefined();
  });
});

describe('elementListTree: order', () => {
  it('sorts the top level and children by name like the list (numbers, case), then by id', () => {
    const graph = graphOf(
      [
        ['p', 'platform', 'Infrastructure'],
        ['i10', 'Item 10', 'Infrastructure'],
        ['i2', 'item 2', 'Infrastructure'],
        ['twin-b', 'Twin', 'Infrastructure'],
        ['twin-a', 'Twin', 'Infrastructure'],
        ['top-b', 'Beta', 'Infrastructure'],
        ['top-a', 'alpha', 'Infrastructure'],
      ],
      [
        contains('c1', 'p', 'i10'),
        contains('c2', 'p', 'twin-b'),
        contains('c3', 'p', 'i2'),
        contains('c4', 'p', 'twin-a'),
      ],
    );
    expect(groupsOf(elementListTree(graph)).Infrastructure?.rows).toEqual([
      'top-a',
      'top-b',
      'p',
      ['i2', 'i10', 'twin-a', 'twin-b'],
    ]);
  });

  it('gives the same tree whatever the order of the matches', () => {
    const graph = graphOf(
      [
        ['a', 'A', 'Application'],
        ['b', 'B', 'Application'],
        ['c', 'C', 'Application'],
        ['s', 'S', 'Stakeholder'],
      ],
      [contains('c1', 'a', 'c'), contains('c2', 'a', 'b')],
    );
    const elements = [...graph.elements.values()];
    const forward = elementListTree(graph, elements);
    expect(elementListTree(graph, [...elements].reverse())).toEqual(forward);
    expect(elementListTree(graph)).toEqual(forward);
    // Groups in metamodel order, empty ones left out.
    expect(forward.map((group) => group.type)).toEqual(['Stakeholder', 'Application']);
  });

  it('is empty without matches', () => {
    expect(elementListTree(graphOf([['a', 'A', 'Other']]), [])).toEqual([]);
    expect(elementListTree(graphOf([]))).toEqual([]);
  });
});

describe('elementListTree: search and filters', () => {
  const graph = graphOf(
    [
      ['estate', 'Estate', 'Application'],
      ['finance', 'Finance suite', 'Application'],
      ['ledger', 'Ledger', 'Application'],
      ['payroll', 'Payroll ledger', 'Application'],
      ['crm', 'CRM', 'Application'],
      ['dc', 'Data centre', 'Infrastructure'],
      ['rack', 'Ledger rack', 'Infrastructure'],
    ],
    [
      contains('c1', 'estate', 'finance'),
      contains('c2', 'finance', 'ledger'),
      contains('c3', 'finance', 'payroll'),
      contains('c4', 'dc', 'rack'),
      // Another type: CRM is not listed under the data centre.
      contains('c5', 'dc', 'crm'),
    ],
  );
  const matching = (query: string) => elementListTree(graph, findElements(graph, { query }));

  it('shows a matching child under its parents, which are context when they do not match', () => {
    expect(groupsOf(matching('ledger'))).toEqual({
      Application: { rows: ['*estate', ['*finance', ['ledger', 'payroll']]], matches: 2 },
      Infrastructure: { rows: ['*dc', ['rack']], matches: 1 },
    });
  });

  it('a parent that matches is not context', () => {
    expect(groupsOf(matching('e'))).toEqual({
      Application: {
        rows: ['estate', ['finance', ['ledger', 'payroll']]],
        matches: 4,
      },
      Infrastructure: { rows: ['dc', ['rack']], matches: 2 },
    });
  });

  it('a matching parent without matching children shows alone', () => {
    expect(groupsOf(matching('suite'))).toEqual({
      Application: { rows: ['*estate', ['finance']], matches: 1 },
    });
  });

  it('marks a row as a match when it is also the context of an earlier match, and counts each match once', () => {
    const ledger = graph.elements.get('ledger');
    const finance = graph.elements.get('finance');
    if (ledger === undefined || finance === undefined) throw new Error('fixture');
    const groups = elementListTree(graph, [ledger, finance, ledger]);
    expect(groupsOf(groups)).toEqual({
      Application: { rows: ['*estate', ['finance', ['ledger']]], matches: 2 },
    });
  });

  it('a container of another type is never brought in as context', () => {
    expect(groupsOf(matching('crm'))).toEqual({
      Application: { rows: ['crm'], matches: 1 },
    });
  });
});

import {
  buildModelGraph,
  canRemoveFromCanvas,
  neighbourhood,
  withContainers,
  withoutElements,
  type JgfDocument,
  type JgfEdge,
} from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';

// Taking cards off the canvas: only what is shown changes, never the model. Made-up data only.

const contains = (id: string, source: string, target: string): JgfEdge => ({
  id,
  source,
  target,
  relation: 'Contains',
});
const relation = (id: string, source: string, target: string): JgfEdge => ({
  id,
  source,
  target,
  relation: 'Relation',
});

const document: JgfDocument = {
  graph: {
    nodes: Object.fromEntries(
      ['shop', 'hall', 'till', 'scale', 'site', 'stock'].map((id) => [
        id,
        { label: `Item ${id}`, metadata: { type: 'Application' } },
      ]),
    ),
    edges: [
      relation('r1', 'shop', 'hall'),
      contains('c1', 'hall', 'till'),
      contains('c2', 'till', 'scale'),
      relation('r2', 'shop', 'stock'),
      contains('c3', 'site', 'shop'),
    ],
  },
};
const graph = buildModelGraph(document);
const shown = () => withContainers(graph, neighbourhood(graph, 'shop', { depth: 3 }));
const ids = (hood: { hops: ReadonlyMap<string, number> }) => [...hood.hops.keys()].sort();
const lines = (hood: { relationships: { id: string }[] }) =>
  hood.relationships.map((r) => r.id).sort();

describe('withoutElements', () => {
  it('takes a card off with its lines, leaving the rest and the model as they were', () => {
    const before = shown();
    const after = withoutElements(graph, before, ['stock'], { nest: true });
    expect(ids(after)).toEqual(['hall', 'scale', 'shop', 'site', 'till']);
    expect(lines(after)).not.toContain('r2');
    expect(ids(before)).toContain('stock');
    expect(graph.elements.has('stock')).toBe(true);
  });

  it('takes the cards drawn inside it too, when contained elements are nested', () => {
    const after = withoutElements(graph, shown(), ['hall'], { nest: true });
    expect(ids(after)).toEqual(['shop', 'site', 'stock']);
    expect(lines(after)).toEqual(['c3', 'r2']);
  });

  it('takes only the card itself when nothing is drawn nested', () => {
    const hood = neighbourhood(graph, 'shop', { depth: 3 });
    const after = withoutElements(graph, hood, ['hall'], { nest: false });
    expect(ids(after)).toEqual(ids(hood).filter((id) => id !== 'hall'));
  });

  it('never takes the focused element, nor a card it is drawn inside', () => {
    const hood = shown();
    expect(canRemoveFromCanvas(graph, hood, 'shop', { nest: true })).toBe(false);
    expect(canRemoveFromCanvas(graph, hood, 'site', { nest: true })).toBe(false);
    expect(canRemoveFromCanvas(graph, hood, 'site', { nest: false })).toBe(true);
    expect(canRemoveFromCanvas(graph, hood, 'hall', { nest: true })).toBe(true);
    expect(canRemoveFromCanvas(graph, hood, 'missing', { nest: true })).toBe(false);
    expect(withoutElements(graph, hood, ['shop', 'site', 'missing'], { nest: true })).toBe(hood);
  });
});

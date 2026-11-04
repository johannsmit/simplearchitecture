import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { nodeTypes } from '@simplearchitecture/shared';
import { cardShape } from '../src/metamodel-ui';
import {
  cardSize,
  isCircleNameCut,
  maxCardWidth,
  minCardHeight,
  minCardWidth,
} from '../src/viewing/explorer/canvas/cardSize';
import { circleAngles, circleHandles } from '../src/viewing/explorer/canvas/circle';
import {
  buildElkGraph,
  layoutCards,
  layoutDirection,
  portId,
  type LayoutCard,
  type LayoutLink,
} from '../src/viewing/explorer/canvas/elkLayout';
import {
  layoutLinks,
  linkText,
  mergeRelationships,
  nearestInDirection,
} from '../src/viewing/explorer/canvas/view';

// The real ELK, in-process (the browser runs the same code in a web worker).
const elk = new ELK();

const card = (id: string, partition: number, height = 64): LayoutCard => ({
  id,
  width: 200,
  height,
  partition,
});

describe('ELK graph builder', () => {
  it('asks for a layered layout, top to bottom, with partitions and free ports', () => {
    const graph = buildElkGraph(
      [card('a', 0), card('b', 2)],
      [{ id: 'l0', source: 'a', target: 'b' }],
    );
    expect(layoutDirection).toBe('DOWN');
    expect(graph.layoutOptions).toMatchObject({
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.partitioning.activate': 'true',
    });
    expect(graph.children?.[1]?.layoutOptions).toMatchObject({
      'elk.partitioning.partition': '2',
      'elk.portConstraints': 'FREE',
    });
    // One port per end of every link, and the edge runs between those ports.
    expect(graph.children?.[0]?.ports?.map((p) => p.id)).toEqual(['l0:s']);
    expect(graph.children?.[1]?.ports?.map((p) => p.id)).toEqual(['l0:t']);
    expect(graph.edges).toEqual([{ id: 'l0', sources: ['l0:s'], targets: ['l0:t'] }]);
  });

  it('switches to left to right with one argument', () => {
    expect(buildElkGraph([], [], 'RIGHT').layoutOptions?.['elk.direction']).toBe('RIGHT');
  });

  it('skips links to unknown cards', () => {
    const graph = buildElkGraph([card('a', 0)], [{ id: 'l0', source: 'a', target: 'x' }]);
    expect(graph.edges).toEqual([]);
    expect(graph.children?.[0]?.ports).toEqual([]);
  });
});

describe('ELK layout', () => {
  it('orders the node types as rows from top to bottom, whatever the links say', async () => {
    // Partitions as metamodel order: 0 Stakeholder … 4 Other. Links point every which way.
    const cards = [
      card('other', 4),
      card('app', 2),
      card('stake', 0),
      card('infra', 3),
      card('biz', 1),
    ];
    const links: LayoutLink[] = [
      { id: 'l0', source: 'other', target: 'stake' },
      { id: 'l1', source: 'app', target: 'biz' },
      { id: 'l2', source: 'infra', target: 'app' },
      { id: 'l3', source: 'stake', target: 'infra' },
    ];
    const placed = await layoutCards(elk, cards, links);
    const y = (id: string) => placed.get(id)?.y ?? Number.NaN;
    expect(y('stake')).toBeLessThan(y('biz'));
    expect(y('biz')).toBeLessThan(y('app'));
    expect(y('app')).toBeLessThan(y('infra'));
    expect(y('infra')).toBeLessThan(y('other'));
  });

  it('gives every link its own ports on the top and bottom sides', async () => {
    const cards = [
      card('hub', 1),
      ...Array.from({ length: 6 }, (_, i) => card(`n${i}`, i % 2 === 0 ? 0 : 2)),
    ];
    const links: LayoutLink[] = Array.from({ length: 6 }, (_, i) =>
      i % 2 === 0
        ? { id: `l${i}`, source: `n${i}`, target: 'hub' }
        : { id: `l${i}`, source: 'hub', target: `n${i}` },
    );
    // Two links between the same pair of cards (another type, or the other direction).
    links.push(
      { id: 'l6', source: 'hub', target: 'n1' },
      { id: 'l7', source: 'n1', target: 'hub' },
    );
    const placed = await layoutCards(elk, cards, links);
    const hub = placed.get('hub');
    expect(hub?.handles).toHaveLength(8);

    // Distinct handles: no two share a side and an offset.
    const spots = hub?.handles.map((h) => `${h.side}@${Math.round(h.offset)}`) ?? [];
    expect(new Set(spots).size).toBe(spots.length);
    // Ports sit on the top and bottom sides only (top to bottom layout).
    expect(new Set(hub?.handles.map((h) => h.side))).toEqual(new Set(['top', 'bottom']));
    // Every handle id is a port of a link, with the right kind.
    for (const handle of hub?.handles ?? []) {
      const [link, end] = handle.id.split(':');
      const expected = links.find((l) => l.id === link);
      expect(end === 's' ? expected?.source : expected?.target).toBe('hub');
      expect(handle.kind).toBe(end === 's' ? 'source' : 'target');
      expect(handle.id).toBe(portId(link ?? '', end === 's' ? 'source' : 'target'));
    }
    // Links into the hub from the row above it arrive on its top side.
    const fromAbove = hub?.handles.find((h) => h.id === 'l0:t');
    expect(fromAbove?.side).toBe('top');
  });

  it('grows a card that needs room for its ports, never shrinks one', async () => {
    const cards = [card('hub', 1), ...Array.from({ length: 24 }, (_, i) => card(`n${i}`, 0))];
    const links = Array.from({ length: 24 }, (_, i) => ({
      id: `l${i}`,
      source: `n${i}`,
      target: 'hub',
    }));
    const placed = await layoutCards(elk, cards, links);
    expect(placed.get('hub')?.width).toBeGreaterThan(200);
    expect(placed.get('n0')).toMatchObject({ width: 200, height: 64 });
  });
});

describe('canvas helpers', () => {
  it('merges parallel relationships and says how many there are', () => {
    const links = mergeRelationships([
      {
        id: 'a',
        source: 'x',
        target: 'y',
        type: 'Relation',
        label: 'API',
        architectureState: 'Current',
        metadata: {},
      },
      {
        id: 'b',
        source: 'x',
        target: 'y',
        type: 'Relation',
        architectureState: 'Current',
        metadata: {},
      },
      {
        id: 'c',
        source: 'x',
        target: 'y',
        type: 'Relation',
        twoWay: true,
        label: 'Orders',
        architectureState: 'Current',
        metadata: {},
      },
      {
        id: 'd',
        source: 'y',
        target: 'x',
        type: 'Relation',
        architectureState: 'Current',
        metadata: {},
      },
    ]);
    expect(links.map((l) => [l.id, l.count, linkText(l)])).toEqual([
      ['l0', 2, '×2'],
      ['l2', 1, 'Orders'],
      ['l3', 1, ''],
    ]);
  });

  it('gives ELK the same input whether lines merge or not, so a change moves no card', async () => {
    const relation = (id: string, twoWay: boolean) => ({
      id,
      source: 'x',
      target: 'y',
      type: 'Relation' as const,
      architectureState: 'Current' as const,
      metadata: {},
      ...(twoWay ? { twoWay } : {}),
    });
    const apart = [relation('a', true), relation('b', false)];
    const merged = [relation('a', false), relation('b', false)];
    const all = () => true;
    expect(layoutLinks(apart, all)).toEqual(layoutLinks(merged, all));
    expect(mergeRelationships(apart).map((l) => l.id)).toEqual(['l0', 'l1']);
    expect(mergeRelationships(merged).map((l) => l.id)).toEqual(['l0']);
    expect(layoutLinks(apart, (r) => r.id !== 'a').map((l) => l.id)).toEqual(['l1']);
    const cards = [card('x', 0), card('y', 2)];
    const positions = async () =>
      [...(await layoutCards(elk, cards, layoutLinks(merged, all))).values()].map((c) => [
        c.x,
        c.y,
      ]);
    expect(await positions()).toEqual(await positions());
  });

  it('finds the nearest card in a direction within a 60° cone', () => {
    const cards = [
      { id: 'a', x: 0, y: 0 },
      { id: 'right', x: 300, y: 50 },
      { id: 'far-right', x: 600, y: 0 },
      { id: 'steep', x: 100, y: 300 },
      { id: 'up', x: 10, y: -200 },
    ];
    const from = { id: 'a', x: 0, y: 0 };
    expect(nearestInDirection(from, cards, 'right')).toBe('right');
    expect(nearestInDirection(from, cards, 'down')).toBe('steep');
    expect(nearestInDirection(from, cards, 'up')).toBe('up');
    expect(nearestInDirection(from, cards, 'left')).toBeUndefined();
  });

  it('sizes rectangle cards between 168 and 280px wide, 44px for one line, taller per line', () => {
    const size = (name: string, focused = false) => cardSize({ name, focused, shape: 'card' });
    expect(minCardHeight).toBe(44);
    // Padding 12px and a 1px border: 26px plus 16px per line (focused: 18px), at least 44px.
    expect(size('Till')).toEqual({ width: minCardWidth, height: 44 });
    expect(size('Till', true)).toEqual({ width: minCardWidth, height: 44 });
    // Wider until the name fits on 2 lines.
    const two = size('Customer relationship management platform');
    expect(two.width).toBeGreaterThan(minCardWidth);
    expect(two.height).toBe(58);
    expect(size('Customer relationship management platform', true).height).toBe(62);
    // Past 280px the card grows taller, without a limit.
    const long = size('word '.repeat(40));
    expect(long.width).toBe(maxCardWidth);
    expect((long.height - 26) % 16).toBe(0);
    expect(long.height).toBeGreaterThan(74);
  });

  it('sizes circle nodes 120px wide: the 48px circle, a 6px gap and up to 3 label lines', () => {
    const size = (name: string, focused = false) => cardSize({ name, focused, shape: 'circle' });
    expect(size('Customer')).toEqual({ width: 120, height: 70 });
    expect(size('Customer', true)).toEqual({ width: 120, height: 72 });
    expect(size('Customer service desk')).toEqual({ width: 120, height: 86 });
    expect(size('Customer service desk', true)).toEqual({ width: 120, height: 90 });
    const long = 'Regional field engineers for installation and maintenance partners in the north';
    expect(size(long)).toEqual({ width: 120, height: 102 });
    expect(size(long, true)).toEqual({ width: 120, height: 108 });
    expect(size('')).toEqual({ width: 120, height: 70 });
    expect(isCircleNameCut(long, false)).toBe(true);
    expect(isCircleNameCut('Customer service desk', false)).toBe(false);
  });

  it('draws the type with the user icon as a circle and every other type as a card', () => {
    expect(nodeTypes.map((type) => [type, cardShape(type)])).toEqual(
      nodeTypes.map((type) => [type, type === 'Stakeholder' ? 'circle' : 'card']),
    );
  });
});

describe('circle handles', () => {
  it('spreads handles over the allowed arc on each side', () => {
    expect(circleAngles('right', 0)).toEqual([]);
    expect(circleAngles('right', 1)).toEqual([0]);
    expect(circleAngles('right', 2)).toEqual([-14, 14]);
    expect(circleAngles('right', 3)).toEqual([-15, 13, 41]);
    expect(circleAngles('right', 4)).toEqual([-15, 10, 35, 60]);
    const many = circleAngles('right', 16);
    expect(many[0]).toBeCloseTo(-15);
    expect(many.at(-1)).toBeCloseTo(60);
    expect(circleAngles('left', 1)).toEqual([0]);
    expect(circleAngles('left', 3)).toEqual([-28, 0, 28]);
    const left = circleAngles('left', 6);
    expect(left[0]).toBeCloseTo(-50);
    expect(left.at(-1)).toBeCloseTo(50);
  });

  it('puts every handle on the circle, top and bottom ports on the nearest side', () => {
    const handles = circleHandles([
      { id: 'r2', kind: 'source', side: 'right', offset: 40 },
      { id: 'r1', kind: 'source', side: 'right', offset: 10 },
      { id: 'b', kind: 'target', side: 'bottom', offset: 90 },
      { id: 't', kind: 'target', side: 'top', offset: 20 },
      { id: 'l', kind: 'target', side: 'left', offset: 30 },
    ]);
    expect(handles.map((h) => [h.id, h.side])).toEqual([
      ['l', 'left'],
      ['t', 'left'],
      ['r1', 'right'],
      ['r2', 'right'],
      ['b', 'right'],
    ]);
    for (const handle of handles) {
      // Centre (60, 24), radius 24.
      expect(Math.hypot(handle.x - 60, handle.y - 24)).toBeCloseTo(24);
      expect(handle.x > 60).toBe(handle.side === 'right');
      // Never on the label (it starts at 54px) and never under the pill (it ends at 10px).
      expect(handle.y).toBeGreaterThan(10);
      expect(handle.y).toBeLessThan(54);
    }
    // Three on the right: -15°, +13° and +41°, top first.
    const right = handles.filter((h) => h.side === 'right');
    expect(right[0]?.y).toBeCloseTo(24 - 24 * Math.sin((15 * Math.PI) / 180));
    expect(right[2]?.y).toBeCloseTo(24 + 24 * Math.sin((41 * Math.PI) / 180));
    expect(handles.find((h) => h.id === 'b')?.kind).toBe('target');
  });

  it('lets ELK keep a circle at its measured size (no room for ports)', () => {
    const graph = buildElkGraph(
      [card('a', 0), { id: 'c', width: 120, height: 70, partition: 0, shape: 'circle' }],
      [{ id: 'l0', source: 'c', target: 'a' }],
    );
    const options = (id: string) =>
      graph.children?.find((child) => child.id === id)?.layoutOptions?.['elk.nodeSize.constraints'];
    expect(options('a')).toBe('PORTS MINIMUM_SIZE');
    expect(options('c')).toBe('MINIMUM_SIZE');
  });
});

describe('merged edges and Architecture state', () => {
  const rel = (id: string, architectureState: 'Current' | 'Target' | 'Deprecate') => ({
    id,
    source: 'x',
    target: 'y',
    type: 'Relation' as const,
    architectureState,
    metadata: {},
  });

  it('keeps a state all merged relationships share, and falls back to Current when mixed', () => {
    expect(mergeRelationships([rel('a', 'Target'), rel('b', 'Target')])[0]?.state).toBe('Target');
    expect(mergeRelationships([rel('a', 'Deprecate')])[0]?.state).toBe('Deprecate');
    expect(mergeRelationships([rel('a', 'Target'), rel('b', 'Deprecate')])[0]?.state).toBe(
      'Current',
    );
    expect(
      mergeRelationships([rel('a', 'Target'), rel('b', 'Current'), rel('c', 'Target')])[0]?.state,
    ).toBe('Current');
  });
});

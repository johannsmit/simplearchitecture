import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import {
  currentBends,
  edgeLine,
  linePath,
  routedLine,
  steppedLine,
} from '../src/viewing/explorer/canvas/edgeLine';
import {
  absoluteBoxes,
  buildElkGraph,
  layoutCards,
  portId,
  type LayoutCard,
  type PlacedCard,
} from '../src/viewing/explorer/canvas/elkLayout';
import { arrangeCards, type Point } from '../src/viewing/explorer/canvas/positions';

// Lines along ELK's routes, with right angles. Made-up data only.

const elk = new ELK();
const card = (id: string, partition: number, parent?: string): LayoutCard => ({
  id,
  width: 200,
  height: 64,
  partition,
  ...(parent === undefined ? {} : { parent }),
});
const box = (x: number, y: number) => ({ x, y, width: 200, height: 64 });
const sourceRoute = (placed: Map<string, PlacedCard>, linkId: string, cardId: string) =>
  placed.get(cardId)?.handles.find((handle) => handle.id === portId(linkId, 'source'))?.route;

function expectRightAngles(line: readonly Point[]) {
  line.slice(1).forEach((point, index) => {
    const before = line[index] as Point;
    expect(point.x === before.x || point.y === before.y).toBe(true);
  });
}

describe('routes from the layout', () => {
  it('asks ELK for right-angled lines and a thorough search for few crossings', () => {
    const { layoutOptions } = buildElkGraph([card('a', 0)], []);
    expect(layoutOptions).toMatchObject({
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.thoroughness': '30',
    });
  });

  it('keeps each line’s route, relative to its source card', async () => {
    const placed = await layoutCards(
      elk,
      [card('a', 0), card('b', 0), card('c', 1), card('d', 2)],
      [
        { id: 'ac', source: 'a', target: 'c' },
        { id: 'bd', source: 'b', target: 'd' },
        { id: 'ad', source: 'a', target: 'd' },
      ],
    );
    const a = placed.get('a');
    const d = placed.get('d');
    const route = sourceRoute(placed, 'ad', 'a');
    expect(route?.target).toEqual({ x: (d?.x ?? 0) - (a?.x ?? 0), y: (d?.y ?? 0) - (a?.y ?? 0) });
    // Only the source handle carries the route.
    expect(
      d?.handles.find((handle) => handle.id === portId('ad', 'target'))?.route,
    ).toBeUndefined();
  });

  it('routes every line around the cards it isn’t attached to', async () => {
    const cards = [
      ...Array.from({ length: 6 }, (_, i) => card(`left${i}`, 0)),
      ...Array.from({ length: 6 }, (_, i) => card(`mid${i}`, 1)),
      ...Array.from({ length: 6 }, (_, i) => card(`right${i}`, 2)),
    ];
    const links = Array.from({ length: 6 }, (_, i) => ({
      id: `long${i}`,
      source: `left${i}`,
      target: `right${5 - i}`,
    }));
    const placed = await layoutCards(elk, cards, links);
    const boxes = absoluteBoxes(placed);
    for (const link of links) {
      const source = boxes.get(link.source);
      const target = boxes.get(link.target);
      const route = sourceRoute(placed, link.id, link.source);
      if (!source || !target || !route) throw new Error('no route');
      const handle = (cardId: string, end: 'source' | 'target') =>
        placed.get(cardId)?.handles.find((h) => h.id === portId(link.id, end))?.offset ?? 0;
      const line = routedLine(
        { x: source.x + source.width, y: source.y + handle(link.source, 'source'), side: 'right' },
        currentBends(route, source, target) ?? [],
        { x: target.x, y: target.y + handle(link.target, 'target'), side: 'left' },
      );
      expectRightAngles(line);
      for (const other of placed.values()) {
        if (other.id === link.source || other.id === link.target) continue;
        const at = boxes.get(other.id);
        if (!at) continue;
        line.slice(1).forEach((point, index) => {
          const before = line[index] as Point;
          // A stretch is level or upright, so it hits a box only if it overlaps on both axes.
          const hits =
            Math.min(before.x, point.x) < at.x + at.width &&
            Math.max(before.x, point.x) > at.x &&
            Math.min(before.y, point.y) < at.y + at.height &&
            Math.max(before.y, point.y) > at.y;
          expect(hits).toBe(false);
        });
      }
    }
  });

  it('has routes inside a container and for a line that crosses into one', async () => {
    const placed = await layoutCards(
      elk,
      [card('box', 0), card('in1', 0, 'box'), card('in2', 1, 'box'), card('out', 2)],
      [
        { id: 'inside', source: 'in1', target: 'in2' },
        { id: 'crossing', source: 'in2', target: 'out' },
      ],
    );
    expect(sourceRoute(placed, 'inside', 'in1')).toBeDefined();
    expect(sourceRoute(placed, 'crossing', 'in2')).toBeDefined();
    expect(placed.get('in2')?.handles.map((handle) => handle.id)).toContain(
      portId('crossing', 'source'),
    );
  });

  describe('a line across levels of nesting', () => {
    const cards = [
      card('box', 1),
      card('in1', 1, 'box'),
      card('in2', 2, 'box'),
      card('box2', 3),
      card('in3', 3, 'box2'),
      card('out', 0),
    ];
    const links = [
      { id: 'across', source: 'in1', target: 'in3' },
      { id: 'within', source: 'in1', target: 'in2' },
      { id: 'into', source: 'out', target: 'in2' },
    ];
    const handleEnd = (placed: Map<string, PlacedCard>, cardId: string, id: string) => {
      const at = absoluteBoxes(placed).get(cardId);
      const handle = placed.get(cardId)?.handles.find((h) => h.id === id);
      if (!at || !handle) throw new Error('no handle');
      const sideways = handle.side === 'left' || handle.side === 'right';
      return {
        x: at.x + (sideways ? (handle.side === 'left' ? 0 : at.width) : handle.offset),
        y: at.y + (sideways ? handle.offset : handle.side === 'top' ? 0 : at.height),
        side: handle.side,
      };
    };

    it('is in the canvas’s coordinates: it leaves its handle and arrives at the other', async () => {
      const placed = await layoutCards(elk, cards, links);
      const boxes = absoluteBoxes(placed);
      for (const link of links) {
        const route = sourceRoute(placed, link.id, link.source);
        const bends = currentBends(route, boxes.get(link.source), boxes.get(link.target));
        if (!bends) throw new Error(`no route for ${link.id}`);
        const start = handleEnd(placed, link.source, portId(link.id, 'source'));
        const end = handleEnd(placed, link.target, portId(link.id, 'target'));
        // Right angles straight from ELK's bends, before routedLine lines anything up.
        const raw = [start, ...bends, end];
        raw.slice(1).forEach((point, index) => {
          const before = raw[index] as Point;
          expect(Math.min(Math.abs(point.x - before.x), Math.abs(point.y - before.y))).toBeLessThan(
            1,
          );
        });
      }
    });

    it('moves with a container holding both ends, and falls back when one end moves', async () => {
      const placed = await layoutCards(elk, cards, links);
      const bendsOf = (
        linkId: string,
        source: string,
        target: string,
        moved: ReadonlyMap<string, PlacedCard> = placed,
      ) => {
        const boxes = absoluteBoxes(moved);
        return currentBends(
          moved.get(source)?.handles.find((h) => h.id === portId(linkId, 'source'))?.route,
          boxes.get(source),
          boxes.get(target),
        );
      };
      const before = bendsOf('within', 'in1', 'in2') ?? [];
      const at = placed.get('box');
      if (!at) throw new Error('not placed');
      const movedBox = arrangeCards(placed, new Map([['box', { x: at.x + 40, y: at.y + 30 }]]));
      // Both ends move together: the same route, 40 and 30 further on.
      expect(bendsOf('within', 'in1', 'in2', movedBox)).toEqual(
        before.map((bend) => ({ x: bend.x + 40, y: bend.y + 30 })),
      );
      // Only one end moves with it: the route no longer holds.
      expect(bendsOf('across', 'in1', 'in3')).toBeDefined();
      expect(bendsOf('across', 'in1', 'in3', movedBox)).toBeUndefined();
      expect(bendsOf('into', 'out', 'in2')).toBeDefined();
      expect(bendsOf('into', 'out', 'in2', movedBox)).toBeUndefined();
      // A card moved inside its container: its lines fall back too.
      const inner = placed.get('in2');
      if (!inner) throw new Error('not placed');
      const movedCard = arrangeCards(placed, new Map([['in2', { x: inner.x + 30, y: inner.y }]]));
      expect(bendsOf('within', 'in1', 'in2', movedCard)).toBeUndefined();
    });

    it('routes every line around the cards it isn’t attached to, on a made-up model', async () => {
      let seed = 7;
      const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      const many: LayoutCard[] = [];
      const parents = new Map<string, string>();
      for (let i = 0; i < 60; i++) {
        const parent = i % 7 > 2 ? `n${i - (i % 7)}` : undefined;
        if (parent) parents.set(`n${i}`, parent);
        many.push(card(`n${i}`, Math.floor(next() * 5), parent));
      }
      const ids = many.map((c) => c.id);
      const lines = Array.from({ length: 90 }, (_, i) => ({
        id: `m${i}`,
        source: ids[Math.floor(next() * 60)] as string,
        target: ids[Math.floor(next() * 60)] as string,
      })).filter((link) => link.source !== link.target);
      const placed = await layoutCards(elk, many, lines);
      const boxes = absoluteBoxes(placed);
      const family = (id: string) => {
        const chain = new Set([id]);
        for (let up = parents.get(id); up !== undefined; up = parents.get(up)) chain.add(up);
        return chain;
      };
      for (const link of lines) {
        const route = sourceRoute(placed, link.id, link.source);
        const bends = currentBends(route, boxes.get(link.source), boxes.get(link.target));
        if (!bends) throw new Error(`no route for ${link.id}`);
        const line = routedLine(
          handleEnd(placed, link.source, portId(link.id, 'source')),
          bends,
          handleEnd(placed, link.target, portId(link.id, 'target')),
        );
        const own = new Set([...family(link.source), ...family(link.target)]);
        for (const [id, at] of boxes) {
          if (own.has(id)) continue;
          line.slice(1).forEach((point, index) => {
            const from = line[index] as Point;
            for (let step = 0; step <= 20; step++) {
              const x = from.x + ((point.x - from.x) * step) / 20;
              const y = from.y + ((point.y - from.y) * step) / 20;
              const over =
                x > at.x + 1 && x < at.x + at.width - 1 && y > at.y + 1 && y < at.y + at.height - 1;
              expect(over).toBe(false);
            }
          });
        }
      }
    });
  });

  it('keeps a route when the whole layout is shifted', async () => {
    const cards = [card('a', 0), card('b', 1), card('c', 1)];
    const links = [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'ac', source: 'a', target: 'c' },
    ];
    const placed = await layoutCards(elk, cards, links);
    const shifted = new Map(
      [...placed].map(([id, at]) => [id, { ...at, x: at.x + 40, y: at.y - 30 }] as const),
    );
    const boxes = absoluteBoxes(shifted);
    const route = sourceRoute(shifted, 'ac', 'a');
    const bends = currentBends(route, boxes.get('a'), boxes.get('c'));
    expect(bends).toEqual(
      route?.bends.map((bend) => ({
        x: bend.x + (boxes.get('a')?.x ?? 0),
        y: bend.y + (boxes.get('a')?.y ?? 0),
      })),
    );
  });
});

describe('whether a route still holds', () => {
  const route = {
    bends: [
      { x: 250, y: 20 },
      { x: 250, y: 120 },
    ],
    target: { x: 300, y: 100 },
  };

  it('holds while the target is where it was, and moves with the source', () => {
    expect(currentBends(route, box(0, 0), box(300, 100))).toEqual(route.bends);
    expect(currentBends(route, box(10, 20), box(310, 120))).toEqual([
      { x: 260, y: 40 },
      { x: 260, y: 140 },
    ]);
  });

  it('ends when one card moves, and comes back when it is back in place', () => {
    expect(currentBends(route, box(0, 0), box(300, 140))).toBeUndefined();
    expect(currentBends(route, box(8, 0), box(300, 100))).toBeUndefined();
    expect(currentBends(route, box(0, 0), box(300, 100))).toBeDefined();
  });

  it('has nothing without a route or a card', () => {
    expect(currentBends(undefined, box(0, 0), box(1, 1))).toBeUndefined();
    expect(currentBends(route, undefined, box(1, 1))).toBeUndefined();
    expect(currentBends(route, box(0, 0), undefined)).toBeUndefined();
  });
});

describe('the line between two handles', () => {
  const start = { x: 0, y: 20, side: 'right' as const };
  const end = { x: 300, y: 120, side: 'left' as const };

  it('runs through ELK’s bends', () => {
    expect(
      routedLine(
        start,
        [
          { x: 150, y: 20 },
          { x: 150, y: 120 },
        ],
        end,
      ),
    ).toEqual([
      { x: 0, y: 20 },
      { x: 150, y: 20 },
      { x: 150, y: 120 },
      { x: 300, y: 120 },
    ]);
  });

  it('keeps its right angles when a handle sits off the port, as on a circle', () => {
    const line = routedLine(
      { x: 84, y: 30, side: 'right' },
      [
        { x: 150, y: 20 },
        { x: 150, y: 90 },
        { x: 220, y: 90 },
        { x: 220, y: 110 },
      ],
      { x: 300, y: 124, side: 'left' },
    );
    expectRightAngles(line);
    expect(line[0]).toEqual({ x: 84, y: 30 });
    expect(line[line.length - 1]).toEqual({ x: 300, y: 124 });
  });

  it('goes out past the side of a circle when ELK’s port is under or above its label', () => {
    // A circle's handle at (84, 30) in a 120px box; ELK's port was on the box's bottom, at x 90.
    const out = routedLine(
      { x: 84, y: 30, side: 'right' },
      [
        { x: 90, y: 150 },
        { x: 400, y: 150 },
      ],
      { x: 400, y: 200, side: 'top' },
    );
    // Back into ELK's lane (x 90) once clear of the label: only that lane is free of other cards.
    expect(out).toEqual([
      { x: 84, y: 30 },
      { x: 140, y: 30 },
      { x: 140, y: 126 },
      { x: 90, y: 126 },
      { x: 90, y: 150 },
      { x: 400, y: 150 },
      { x: 400, y: 200 },
    ]);
    // A bend too close for that: the next stretch starts from the side of the box.
    expect(
      routedLine(
        { x: 84, y: 30, side: 'right' },
        [
          { x: 90, y: 100 },
          { x: 400, y: 100 },
        ],
        { x: 400, y: 200, side: 'top' },
      ),
    ).toEqual([
      { x: 84, y: 30 },
      { x: 140, y: 30 },
      { x: 140, y: 100 },
      { x: 400, y: 100 },
      { x: 400, y: 200 },
    ]);
    // Arriving at a circle's left handle, from a port that was on the box's bottom.
    const arriving = routedLine(
      { x: 400, y: 300, side: 'top' },
      [
        { x: 400, y: 150 },
        { x: 30, y: 150 },
      ],
      { x: 36, y: 30, side: 'left' },
    );
    expect(arriving).toEqual([
      { x: 400, y: 300 },
      { x: 400, y: 150 },
      { x: 30, y: 150 },
      { x: 30, y: 126 },
      { x: -20, y: 126 },
      { x: -20, y: 30 },
      { x: 36, y: 30 },
    ]);
  });

  it('goes out past a circle with no bends too, when the other end is under it', () => {
    const line = routedLine({ x: 84, y: 30, side: 'right' }, [], { x: 90, y: 200, side: 'top' });
    expect(line).toEqual([
      { x: 84, y: 30 },
      { x: 140, y: 30 },
      { x: 140, y: 126 },
      { x: 90, y: 126 },
      { x: 90, y: 200 },
    ]);
    expect(routedLine({ x: 90, y: 300, side: 'top' }, [], { x: 36, y: 30, side: 'left' })).toEqual([
      { x: 90, y: 300 },
      { x: 90, y: 126 },
      { x: -20, y: 126 },
      { x: -20, y: 30 },
      { x: 36, y: 30 },
    ]);
    // Stacked circles, both handles on the same side.
    expect(
      routedLine({ x: 84, y: 30, side: 'right' }, [], { x: 84, y: 200, side: 'right' }),
    ).toEqual([
      { x: 84, y: 30 },
      { x: 140, y: 30 },
      { x: 140, y: 200 },
      { x: 84, y: 200 },
    ]);
  });

  it('is straight with no bends when the handles line up, and a step when they don’t', () => {
    expect(routedLine(start, [], { x: 300, y: 20, side: 'left' })).toEqual([
      { x: 0, y: 20 },
      { x: 300, y: 20 },
    ]);
    const step = routedLine(start, [], end);
    expectRightAngles(step);
    expect(step).toHaveLength(4);
    const corner = routedLine(start, [], { x: 300, y: 120, side: 'top' });
    expect(corner).toEqual([
      { x: 0, y: 20 },
      { x: 300, y: 20 },
      { x: 300, y: 120 },
    ]);
  });

  it('falls back to a right-angled step when there is no route', () => {
    for (const [from, to] of [
      [start, end],
      // Against the flow: it must still leave and arrive on the right sides.
      [
        { x: 300, y: 20, side: 'right' as const },
        { x: 0, y: 120, side: 'left' as const },
      ],
    ] as const) {
      const line = steppedLine(from, to);
      expectRightAngles(line);
      expect(line[0]).toEqual({ x: from.x, y: from.y });
      expect(line[line.length - 1]).toEqual({ x: to.x, y: to.y });
      // It leaves the card outwards.
      expect((line[1]?.x ?? 0) > from.x).toBe(true);
      expect(edgeLine(from, to, undefined)).toEqual(line);
    }
  });

  it('rounds corners only as far as the stretches allow', () => {
    expect(
      linePath([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ]),
    ).toBe('M0 0L92 0Q100 0 100 8L100 100');
    expect(
      linePath([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 6 },
      ]),
    ).toBe('M0 0L97 0Q100 0 100 3L100 6');
    expect(linePath([])).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { crossesAny, floatingEnds, type EndBox } from '../src/viewing/explorer/canvas/edgeLine';
import { orthogonalRoute, type Heading } from '../src/viewing/explorer/canvas/orthogonalRoute';
import type { Box, Point } from '../src/viewing/explorer/canvas/positions';

// Lines without a route go round the cards in their way, with more bends where they must.
// Made-up data only.

const at = (x: number, y: number, more: Partial<EndBox> = {}): EndBox => ({
  x,
  y,
  width: 160,
  height: 44,
  ...more,
});

const lineOf = (boxes: Record<string, EndBox>, source: string, target: string) =>
  floatingEnds([{ id: 'l0', source, target }], new Map(Object.entries(boxes))).get('l0');

/** How far a right-angled stretch keeps from a box: the larger of the gaps across and along. */
function gap(a: Point, b: Point, box: Box): number {
  const dx = Math.max(box.x - Math.max(a.x, b.x), Math.min(a.x, b.x) - (box.x + box.width), 0);
  const dy = Math.max(box.y - Math.max(a.y, b.y), Math.min(a.y, b.y) - (box.y + box.height), 0);
  return Math.max(dx, dy);
}

const nearest = (line: readonly Point[], box: Box) =>
  Math.min(...line.slice(1).map((point, index) => gap(line[index] as Point, point, box)));

function expectRightAngled(line: readonly Point[]) {
  line.slice(1).forEach((point, index) => {
    const before = line[index] as Point;
    expect(point.x === before.x || point.y === before.y).toBe(true);
  });
}

/**
 * Two cards with a tall card between them, and cards above and below each end: no line with two
 * bends or fewer is clear, while a detour over or under the tall card is.
 */
const boxedIn = (more: Record<string, EndBox> = {}) => ({
  left: at(0, 0),
  right: at(600, 0),
  pillar: at(300, -100, { height: 244 }),
  overLeft: at(0, -120),
  overRight: at(600, -120),
  underLeft: at(0, 120),
  underRight: at(600, 120),
  ...more,
});

describe('a line round the cards in its way', () => {
  it('goes round a card between its ends when no line with two bends is clear', () => {
    const boxes = boxedIn();
    const line = lineOf(boxes, 'left', 'right');
    const points = line?.points ?? [];
    expect(points.length).toBeGreaterThan(4);
    expectRightAngled(points);
    expect(crossesAny(points, [boxes.pillar])).toBe(false);
    for (const [id, box] of Object.entries(boxes)) {
      if (id === 'left' || id === 'right') continue;
      expect(nearest(points, box)).toBeGreaterThanOrEqual(12);
    }
    // Out of the facing sides, and in by them, by more than the stub.
    expect(line?.start.side).toBe('right');
    expect(line?.end.side).toBe('left');
    expect((points[1]?.x ?? 0) - (points[0]?.x ?? 0)).toBeGreaterThanOrEqual(8);
    const [last, beforeLast] = [points[points.length - 1], points[points.length - 2]];
    expect((last?.x ?? 0) - (beforeLast?.x ?? 0)).toBeGreaterThanOrEqual(8);
    // Never back through its own cards.
    expect(crossesAny(points, [boxes.left, boxes.right])).toBe(false);
  });

  it('draws the same line for the same cards', () => {
    expect(lineOf(boxedIn(), 'left', 'right')).toEqual(lineOf(boxedIn(), 'left', 'right'));
  });

  it('keeps clear of cards far out, where a detour has to go wide', () => {
    // The pillar is so tall the way over it runs far above the ends, past a card up there.
    const boxes = boxedIn({
      pillar: at(300, -400, { height: 900 }),
      far: at(200, -440, { width: 360 }),
    });
    const points = lineOf(boxes, 'left', 'right')?.points ?? [];
    expect(points.length).toBeGreaterThan(4);
    expectRightAngled(points);
    for (const [id, box] of Object.entries(boxes)) {
      if (id === 'left' || id === 'right') continue;
      expect(crossesAny(points, [box])).toBe(false);
      expect(nearest(points, box)).toBeGreaterThanOrEqual(12);
    }
  });

  it('keeps off the header of the container it leaves', () => {
    const boxes = {
      shelf: at(0, 0, { width: 192, height: 116 }),
      jar: at(16, 56, { parent: 'shelf' }),
      under: at(0, 140, { width: 192 }),
      pillar: at(300, -200, { height: 500 }),
      lid: at(600, -20, { height: 32 }),
      basket: at(600, 56),
      floor: at(600, 140),
    };
    const points = lineOf(boxes, 'jar', 'basket')?.points ?? [];
    expectRightAngled(points);
    expect(crossesAny(points, [{ x: 0, y: 0, width: 192, height: 40 }])).toBe(false);
    expect(crossesAny(points, [boxes.pillar, boxes.under, boxes.lid, boxes.floor])).toBe(false);
  });

  it('still draws a line, through as few cards as it must, round a card shut in', () => {
    // Cards all round the first, too close to pass between.
    const boxes: Record<string, EndBox> = {
      shut: at(0, 0),
      away: at(800, 0),
      north: at(-40, -60, { width: 240 }),
      south: at(-40, 60, { width: 240 }),
      west: at(-60, -60, { width: 44, height: 164 }),
      east: at(176, -60, { width: 44, height: 164 }),
    };
    const line = lineOf(boxes, 'shut', 'away');
    expect(line?.points.length).toBeGreaterThanOrEqual(2);
    expectRightAngled(line?.points ?? []);
    const others = [boxes.north, boxes.south, boxes.west, boxes.east] as Box[];
    expect(others.filter((box) => crossesAny(line?.points ?? [], [box]))).toHaveLength(1);
  });

  it('takes the sides of a clear detour over those of a shorter line through a card', () => {
    // A post hard against the first card's facing side leaves no way out of it there: the line
    // leaves by another side and goes round, rather than through the post and the pillar.
    const boxes = boxedIn({ post: at(166, -10, { width: 20, height: 64 }) });
    const line = lineOf(boxes, 'left', 'right');
    const points = line?.points ?? [];
    expect(line?.start.side).not.toBe('right');
    expectRightAngled(points);
    for (const [id, box] of Object.entries(boxes)) {
      if (id === 'left' || id === 'right') continue;
      expect(crossesAny(points, [box])).toBe(false);
      expect(nearest(points, box)).toBeGreaterThanOrEqual(12);
    }
    expect(crossesAny(points, [boxes.left, boxes.right])).toBe(false);
  });

  it('keeps today’s line when one with two bends or fewer is clear', () => {
    const boxes = { one: at(0, 0), two: at(188, 0), three: at(376, 0) };
    const points = lineOf(boxes, 'one', 'three')?.points ?? [];
    expect(points).toHaveLength(4);
    expect(crossesAny(points, [boxes.two])).toBe(false);
  });

  it('keeps up with a drag on a view of a hundred cards', () => {
    // A 10 by 10 grid of cards, each linked to cards some rows and columns away, so many lines
    // have cards in their way.
    const boxes = new Map<string, EndBox>();
    for (let row = 0; row < 10; row++) {
      for (let column = 0; column < 10; column++) {
        boxes.set(`c${row}-${column}`, at(column * 220, row * 120));
      }
    }
    const links: { id: string; source: string; target: string }[] = [];
    let seed = 7;
    const next = (below: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % below;
    };
    for (let index = 0; index < 150; index++) {
      const source = `c${next(10)}-${next(10)}`;
      const target = `c${next(10)}-${next(10)}`;
      if (source !== target) links.push({ id: `l${index}`, source, target });
    }
    floatingEnds(links, boxes);
    // Every card a little further on, so no line can keep its detour from the last time.
    const moved = new Map(
      [...boxes].map(([id, box]) => [id, { ...box, x: box.x + 4, y: box.y + 4 }]),
    );
    const started = performance.now();
    const lines = floatingEnds(links, moved);
    const took = performance.now() - started;
    expect(lines.size).toBe(links.length);
    for (const line of lines.values()) expectRightAngled(line.points);
    // About 50 to 80 ms in a test run (about 20 ms once warm): the bound is some three times that,
    // so it catches a big slowdown without failing on a busy machine.
    expect(took).toBeLessThan(250);
  });

  it('draws the same lines again for cards that haven’t moved', () => {
    const boxes = boxedIn();
    const links = [
      { id: 'a', source: 'left', target: 'right' },
      { id: 'b', source: 'overLeft', target: 'underRight' },
    ];
    const first = floatingEnds(links, new Map(Object.entries(boxes)));
    // Moving a card far from both lines leaves them as they were.
    const again = floatingEnds(links, new Map(Object.entries({ ...boxes, away: at(5000, 5000) })));
    expect(again).toEqual(first);
    // Moving a card in a line's way changes it.
    const changed = floatingEnds(
      links,
      new Map(Object.entries({ ...boxes, pillar: at(300, -140, { height: 324 }) })),
    );
    expect(changed.get('a')?.points).not.toEqual(first.get('a')?.points);
  });

  it('still goes round from an end spread along its side close to another card', () => {
    // Two lines between the boxed-in cards share each side. The upper end sits within 12px of a
    // card at the corner: the line leaves there with less room, rather than crossing a card.
    const boxes = boxedIn({ corner: at(176, -40, { width: 100 }) });
    const all = floatingEnds(
      [
        { id: 'a', source: 'left', target: 'right' },
        { id: 'b', source: 'left', target: 'right' },
      ],
      new Map(Object.entries(boxes)),
    );
    for (const id of ['a', 'b']) {
      const points = all.get(id)?.points ?? [];
      expect(points.length).toBeGreaterThan(4);
      expectRightAngled(points);
      for (const [name, box] of Object.entries(boxes)) {
        if (name === 'left' || name === 'right') continue;
        expect(crossesAny(points, [box])).toBe(false);
        // As much room as its end leaves; the full 12px from every other card.
        expect(nearest(points, box)).toBeGreaterThanOrEqual(name === 'corner' ? 10 : 12);
      }
    }
  });
});

describe('the right-angled router', () => {
  const route = (
    from: Point,
    fromHeading: Heading,
    to: Point,
    toHeading: Heading,
    avoid: Box[] = [],
    bendCost = 40,
  ) =>
    orthogonalRoute({
      starts: [{ at: from, heading: fromHeading }],
      ends: [{ at: to, heading: toHeading }],
      avoid,
      bendCost,
    });

  it('runs straight when nothing is in the way', () => {
    expect(route({ x: 0, y: 0 }, 0, { x: 300, y: 0 }, 0)?.cost).toBe(300);
  });

  it('counts each bend, the turn into the end included', () => {
    expect(route({ x: 0, y: 0 }, 0, { x: 200, y: 100 }, 1)?.cost).toBe(300 + 40);
  });

  it('goes round a box, touching its edge at most', () => {
    const box = { x: 100, y: -50, width: 100, height: 100 };
    const found = route({ x: 0, y: 0 }, 0, { x: 300, y: 0 }, 0, [box]);
    expect(found?.cost).toBe(300 + 100 + 4 * 40);
    expect(crossesAny(found?.points ?? [], [box])).toBe(false);
  });

  it('prefers fewer bends at the cost of some length', () => {
    // Over one box and under the next is shorter, with six bends; round both, four.
    const avoid = [
      { x: 100, y: -20, width: 50, height: 120 },
      { x: 250, y: -100, width: 50, height: 120 },
    ];
    // Its cost less its length, counting the turn into the end's heading.
    const bends = (bendCost: number) => {
      const found = route({ x: 0, y: 0 }, 0, { x: 400, y: 0 }, 0, avoid, bendCost);
      const points = found?.points ?? [];
      const length = points
        .slice(1)
        .reduce(
          (sum, point, index) =>
            sum +
            Math.abs(point.x - (points[index] as Point).x) +
            Math.abs(point.y - (points[index] as Point).y),
          0,
        );
      return ((found?.cost ?? 0) - length) / bendCost;
    };
    expect(bends(1)).toBe(6);
    expect(bends(100)).toBe(4);
  });

  it('takes the cheapest of several starts and ends, an extra cost breaking a tie', () => {
    const found = orthogonalRoute({
      starts: [
        { at: { x: 0, y: 0 }, heading: 2 },
        { at: { x: 0, y: 10 }, heading: 0, extra: 0.25 },
        { at: { x: 0, y: 20 }, heading: 0 },
      ],
      ends: [
        { at: { x: 300, y: 10 }, heading: 0, extra: 0.25 },
        { at: { x: 300, y: 20 }, heading: 0 },
      ],
      avoid: [],
      bendCost: 40,
    });
    expect(found).toMatchObject({ start: 2, end: 1, cost: 300 });
  });

  it('finds nothing from inside a box, or where boxes shut the end in', () => {
    const box = { x: 100, y: -50, width: 100, height: 100 };
    expect(route({ x: 150, y: 0 }, 0, { x: 300, y: 0 }, 0, [box])).toBeUndefined();
    const ring = [
      { x: 250, y: -50, width: 100, height: 40 },
      { x: 250, y: 10, width: 100, height: 40 },
      { x: 250, y: -50, width: 40, height: 100 },
      { x: 310, y: -50, width: 40, height: 100 },
    ];
    expect(route({ x: 0, y: 0 }, 0, { x: 300, y: 0 }, 0, ring)).toBeUndefined();
  });
});

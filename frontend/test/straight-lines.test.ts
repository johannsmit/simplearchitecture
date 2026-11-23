import ELK from 'elkjs/lib/elk.bundled.js';
import { describe, expect, it } from 'vitest';
import { crossesAny, floatingEnds, type EndBox } from '../src/viewing/explorer/canvas/edgeLine';
import {
  absoluteBoxes,
  containerBox,
  layoutCards,
  portId,
  spacing,
  type LayoutCard,
  type PlacedCard,
} from '../src/viewing/explorer/canvas/elkLayout';
import { laidLine } from '../src/viewing/explorer/canvas/lineRoutes';
import type { Box, Point } from '../src/viewing/explorer/canvas/positions';
import { straightLaid } from '../src/viewing/explorer/canvas/straightLines';

// Lines run straight where two cards face each other with room for it. Made-up data only.

const elk = new ELK();

type Segment = [Point, Point];

const segmentsOf = (line: readonly Point[]): Segment[] =>
  line.slice(1).map((point, index) => [line[index] as Point, point]);

/** Whether two right-angled stretches cross or touch, other than at a shared end point. */
function meet([a, b]: Segment, [c, d]: Segment): boolean {
  const between = (v: number, p: number, q: number) => v >= Math.min(p, q) && v <= Math.max(p, q);
  const shared = [a, b].some((p) => [c, d].some((q) => p.x === q.x && p.y === q.y));
  if (shared) return false;
  const upright = (p: Point, q: Point) => p.x === q.x;
  if (upright(a, b) !== upright(c, d)) {
    const [v, h] = upright(a, b)
      ? [
          [a, b],
          [c, d],
        ]
      : [
          [c, d],
          [a, b],
        ];
    const [v0, v1] = v as [Point, Point];
    const [h0, h1] = h as [Point, Point];
    return between(v0.x, h0.x, h1.x) && between(h0.y, v0.y, v1.y);
  }
  if (upright(a, b))
    return (
      a.x === c.x &&
      Math.max(a.y, b.y) >= Math.min(c.y, d.y) &&
      Math.max(c.y, d.y) >= Math.min(a.y, b.y)
    );
  return (
    a.y === c.y &&
    Math.max(a.x, b.x) >= Math.min(c.x, d.x) &&
    Math.max(c.x, d.x) >= Math.min(a.x, b.x)
  );
}

function crossings(lines: readonly (readonly Point[])[]): number {
  let count = 0;
  lines.forEach((line, index) => {
    for (const other of lines.slice(index + 1)) {
      for (const one of segmentsOf(line)) {
        for (const two of segmentsOf(other)) if (meet(one, two)) count++;
      }
    }
  });
  return count;
}

const isStraight = (line: readonly Point[]) => line.length === 2;

/** Every line as the canvas draws it from the layout: handle, ELK's bends, handle. */
function laidLines(
  placed: Map<string, PlacedCard>,
  links: readonly { id: string; source: string; target: string }[],
) {
  const boxes = absoluteBoxes(placed);
  const pointOf = (cardId: string, port: string): Point => {
    const box = boxes.get(cardId) as { x: number; y: number; width: number; height: number };
    const handle = placed.get(cardId)?.handles.find((h) => h.id === port);
    if (!handle) throw new Error(`no handle ${port}`);
    switch (handle.side) {
      case 'top':
        return { x: box.x + handle.offset, y: box.y };
      case 'bottom':
        return { x: box.x + handle.offset, y: box.y + box.height };
      case 'left':
        return { x: box.x, y: box.y + handle.offset };
      case 'right':
        return { x: box.x + box.width, y: box.y + handle.offset };
    }
  };
  return links.map((link) => {
    const source = boxes.get(link.source) as Point;
    const handle = placed.get(link.source)?.handles.find((h) => h.id === portId(link.id, 'source'));
    const start = pointOf(link.source, portId(link.id, 'source'));
    const end = pointOf(link.target, portId(link.id, 'target'));
    const bends = (handle?.route?.bends ?? []).map((b) => ({
      x: b.x + source.x,
      y: b.y + source.y,
    }));
    // The canvas draws no route as a step; a route with no bends between level ends is straight.
    const line = [start, ...bends, end];
    return {
      id: link.id,
      routed: handle?.route !== undefined,
      line: line.filter((p, i) => i === 0 || p.x !== line[i - 1]?.x || p.y !== line[i - 1]?.y),
    };
  });
}

/** Ends on each card's side keep `spacing.ports` apart. */
function expectPortSpacing(placed: Map<string, PlacedCard>) {
  for (const card of placed.values()) {
    for (const side of ['top', 'bottom', 'left', 'right'] as const) {
      const offsets = card.handles
        .filter((h) => h.side === side)
        .map((h) => h.offset)
        .sort((a, b) => a - b);
      offsets.slice(1).forEach((offset, index) => {
        expect(offset - (offsets[index] as number)).toBeGreaterThanOrEqual(spacing.ports - 0.5);
      });
    }
  }
}

const hubCase = (hubWidth: number) => {
  const cards: LayoutCard[] = [
    { id: 'hub', width: hubWidth, height: 100 },
    ...[0, 1, 2].map((i) => ({ id: `t${i}`, width: 390, height: 100 })),
  ];
  const links = [0, 1, 2].map((i) => ({ id: `l${i}`, source: 'hub', target: `t${i}` }));
  return { cards, links };
};

describe('straight lines after the automatic layout', () => {
  it('runs all three lines straight from a wide card to the three cards under it', async () => {
    const { cards, links } = hubCase(1600);
    const placed = await layoutCards(elk, cards, links);
    const lines = laidLines(placed, links);
    for (const { line, routed } of lines) {
      expect(routed).toBe(true);
      expect(isStraight(line)).toBe(true);
    }
    expectPortSpacing(placed);
    expect(crossings(lines.map((l) => l.line))).toBe(0);
  });

  it('still bends where a narrow card has three cards side by side under it, with no crossings', async () => {
    const { cards, links } = hubCase(390);
    const placed = await layoutCards(elk, cards, links);
    const lines = laidLines(placed, links);
    expect(lines.filter((l) => isStraight(l.line)).length).toBeLessThan(3);
    expect(crossings(lines.map((l) => l.line))).toBe(0);
    expectPortSpacing(placed);
  });

  it('runs straight with a line coming in from above as well', async () => {
    const { cards, links } = hubCase(1600);
    cards.push({ id: 'up', width: 390, height: 100 });
    links.push({ id: 'lu', source: 'up', target: 'hub' });
    const placed = await layoutCards(elk, cards, links);
    const lines = laidLines(placed, links);
    expect(lines.filter((l) => isStraight(l.line)).length).toBe(4);
    expect(crossings(lines.map((l) => l.line))).toBe(0);
    expectPortSpacing(placed);
  });

  it('keeps a line into a card in a container on its way beside the name', async () => {
    // The line from above into a nested card isn't straightened across the container's header.
    const cards: LayoutCard[] = [
      { id: 'top', width: 390, height: 64 },
      { id: 'box', width: 200, height: 116, shape: 'container', nameWidth: 120 },
      { id: 'inner', width: 200, height: 64, parent: 'box' },
    ];
    const links = [{ id: 'l0', source: 'top', target: 'inner' }];
    const placed = await layoutCards(elk, cards, links);
    const [line] = laidLines(placed, links);
    expect(line?.routed).toBe(true);
    const boxes = absoluteBoxes(placed);
    const box = boxes.get('box') as { x: number; y: number; width: number; height: number };
    // Not through the header's middle, where the name is.
    const header = { x: box.x + box.width / 2 - 60, y: box.y, width: 120, height: 40 };
    expect(crossesAny(line?.line ?? [], [header])).toBe(false);
  });
});

describe('straight lines without a route', () => {
  const at = (x: number, y: number, width = 390, height = 100): EndBox => ({ x, y, width, height });
  const draw = (boxes: Record<string, EndBox>, links: [string, string][]) => {
    const all = floatingEnds(
      links.map(([source, target], index) => ({ id: `l${index}`, source, target })),
      new Map(Object.entries(boxes)),
    );
    return links.map((_, index) => all.get(`l${index}`));
  };

  it('runs all three lines straight from a wide card to the three cards under it', () => {
    // Where the layout puts them: under the wide card, not centred under its ends.
    const lines = draw(
      { hub: at(12, 12, 1600), t0: at(635, 208), t1: at(1053, 208), t2: at(217, 208) },
      [
        ['hub', 't0'],
        ['hub', 't1'],
        ['hub', 't2'],
      ],
    );
    for (const line of lines) {
      expect(line?.start.side).toBe('bottom');
      expect(line?.points).toHaveLength(2);
    }
    const xs = lines.map((line) => line?.start.x ?? 0).sort((a, b) => a - b);
    xs.slice(1).forEach((x, index) => {
      expect(x - (xs[index] as number)).toBeGreaterThanOrEqual(spacing.ports);
    });
  });

  it('runs straight sideways too, from a tall card to the cards beside it', () => {
    const lines = draw(
      {
        hub: at(0, 0, 200, 900),
        r0: at(400, 40, 200, 100),
        r1: at(400, 380, 200, 100),
        r2: at(400, 720, 200, 100),
      },
      [
        ['hub', 'r0'],
        ['hub', 'r1'],
        ['hub', 'r2'],
      ],
    );
    for (const line of lines) {
      expect(line?.start.side).toBe('right');
      expect(line?.points).toHaveLength(2);
    }
  });

  it('still bends where a narrow card has three cards side by side under it, with no crossings', () => {
    const lines = draw({ hub: at(110, 12), t0: at(430, 208), t1: at(848, 208), t2: at(12, 208) }, [
      ['hub', 't0'],
      ['hub', 't1'],
      ['hub', 't2'],
    ]);
    expect(lines.filter((line) => line?.points.length === 2).length).toBeLessThan(3);
    expect(crossings(lines.map((line) => line?.points ?? []))).toBe(0);
  });

  it('keeps the ends in order along a side, so the lines don’t cross', () => {
    // The far card sits under the other line's end: lining up with it would swap the ends.
    const lines = draw({ hub: at(0, 0, 600), a: at(0, 300, 200), b: at(40, 500, 200) }, [
      ['hub', 'a'],
      ['hub', 'b'],
    ]);
    expect(crossings(lines.map((line) => line?.points ?? []))).toBe(0);
  });

  it('doesn’t run a straight line through another card', () => {
    // A card in the gap, right where the straight line would run.
    const boxes = { hub: at(0, 0, 1600), t0: at(600, 400), wall: at(780, 200, 60, 60) };
    const [line] = draw(boxes, [['hub', 't0']]);
    expect(crossesAny(line?.points ?? [], [boxes.wall])).toBe(false);
  });

  it('doesn’t run a straight line from outside a container through its header', () => {
    // A card above a container, and a card inside it right under the first one.
    const boxes: Record<string, EndBox> = {
      above: at(0, 0),
      box: at(0, 300, 422, 172),
      inner: { ...at(16, 356), parent: 'box' },
    };
    const [line] = draw(boxes, [['above', 'inner']]);
    expect(line).toBeDefined();
    // Not straight down through the header, where the container's name is.
    const header = { x: 0, y: 300, width: 422, height: containerBox.header };
    expect(line?.points.length === 2 && crossesAny(line.points, [header])).toBe(false);
  });

  it('brings a line from above into a container’s only card in below its header, not across it', () => {
    // As the canvas draws it after Tidy relations: no route, the ends already level.
    for (const shift of [0, 40]) {
      const boxes: Record<string, EndBox> = {
        desk: at(416 + shift, 20, 168, 44),
        yard: at(400, 200, 200, 116),
        crane: { ...at(416, 256, 168, 44), parent: 'yard' },
      };
      const [line] = draw(boxes, [['desk', 'crane']]);
      expect(line, `shifted ${String(shift)}`).toBeDefined();
      const header = { x: 400, y: 200, width: 200, height: containerBox.header };
      expect(crossesAny(line?.points ?? [], [header]), `shifted ${String(shift)}`).toBe(false);
      expect(crossesAny(line?.points ?? [], [boxes.desk as EndBox])).toBe(false);
    }
  });

  it('still leaves a container’s card down out of it, and in from a card that holds it', () => {
    const boxes: Record<string, EndBox> = {
      yard: at(400, 200, 200, 116),
      crane: { ...at(416, 256, 168, 44), parent: 'yard' },
      quay: at(416, 420, 168, 44),
    };
    const [out, inside] = draw(boxes, [
      ['crane', 'quay'],
      ['yard', 'crane'],
    ]);
    expect(out?.points).toHaveLength(2);
    expect(inside).toBeDefined();
  });

  it('still runs straight between two cards in the same container', () => {
    const boxes: Record<string, EndBox> = {
      box: at(0, 0, 1000, 400),
      wide: { ...at(16, 56, 900, 100), parent: 'box' },
      under: { ...at(300, 260), parent: 'box' },
    };
    const [line] = draw(boxes, [['wide', 'under']]);
    expect(line?.points).toHaveLength(2);
  });
});

describe('straight lines between a circle and a card level with it', () => {
  // A Stakeholder circle's end sits on its circle (24px down its box with one line on a side), not
  // where ELK put the port, so the card's end moves to line up with it.
  const isCircle = (id: string) => id === 'clerk';
  const circleCard = (route: { x: number; y: number }): PlacedCard => ({
    id: 'clerk',
    x: 12,
    y: 12,
    width: 120,
    height: 70,
    handles: [
      {
        id: portId('l0', 'source'),
        kind: 'source',
        side: 'right',
        offset: 35,
        route: { bends: [], target: route },
      },
    ],
  });
  /** The line from the circle to the desk as the canvas draws it after the layout. */
  const drawnLine = (placed: Map<string, PlacedCard>, link = 'l0') => {
    const boxes = absoluteBoxes(placed);
    const box = (id: string) => ({ ...(boxes.get(id) as Box), circle: isCircle(id) });
    const source = [...placed.values()].find((card) =>
      card.handles.some((h) => h.id === portId(link, 'source')),
    ) as PlacedCard;
    const target = [...placed.values()].find((card) =>
      card.handles.some((h) => h.id === portId(link, 'target')),
    ) as PlacedCard;
    const handle = source.handles.find((h) => h.id === portId(link, 'source'));
    const at = boxes.get(source.id) as Box;
    const bends = (handle?.route?.bends ?? []).map((b) => ({ x: b.x + at.x, y: b.y + at.y }));
    return laidLine(
      bends,
      { handles: source.handles, box: box(source.id), port: portId(link, 'source') },
      { handles: target.handles, box: box(target.id), port: portId(link, 'target') },
    );
  };

  it('runs straight after Tidy up when it is the only line on the card’s side', () => {
    const placed = new Map<string, PlacedCard>([
      ['clerk', circleCard({ x: 288, y: -12 })],
      [
        'desk',
        {
          id: 'desk',
          x: 300,
          y: 0,
          width: 390,
          height: 100,
          handles: [{ id: portId('l0', 'target'), kind: 'target', side: 'left', offset: 47 }],
        },
      ],
    ]);
    const line = drawnLine(straightLaid(placed, isCircle));
    expect(line).toHaveLength(2);
    expect(line?.[0]).toEqual({ x: 96, y: 36 });
    expect(line?.[1]?.y).toBe(36);
  });

  it('runs straight after Tidy up with another line ending on the same side of the card', () => {
    const placed = new Map<string, PlacedCard>([
      ['clerk', circleCard({ x: 288, y: -12 })],
      [
        'ledger',
        {
          id: 'ledger',
          x: 12,
          y: 150,
          width: 200,
          height: 60,
          handles: [
            {
              id: portId('l1', 'source'),
              kind: 'source',
              side: 'right',
              offset: 30,
              route: {
                bends: [
                  { x: 238, y: 30 },
                  { x: 238, y: -70 },
                ],
                target: { x: 288, y: -150 },
              },
            },
          ],
        },
      ],
      [
        'desk',
        {
          id: 'desk',
          x: 300,
          y: 0,
          width: 390,
          height: 100,
          handles: [
            { id: portId('l0', 'target'), kind: 'target', side: 'left', offset: 45 },
            { id: portId('l1', 'target'), kind: 'target', side: 'left', offset: 80 },
          ],
        },
      ],
    ]);
    const laid = straightLaid(placed, isCircle);
    const line = drawnLine(laid);
    expect(line).toHaveLength(2);
    expect(line?.[0]?.y).toBe(36);
    expect(line?.[1]?.y).toBe(36);
    // The other line keeps its end and its route.
    const other = laid.get('desk')?.handles.find((h) => h.id === portId('l1', 'target'));
    expect(other?.offset).toBe(80);
    expect(drawnLine(laid, 'l1')).toHaveLength(4);
    expectPortSpacing(laid);
  });

  it('keeps the route where the card isn’t level with the circle’s end', () => {
    const placed = new Map<string, PlacedCard>([
      ['clerk', circleCard({ x: 288, y: 88 })],
      [
        'desk',
        {
          id: 'desk',
          x: 300,
          y: 100,
          width: 390,
          height: 100,
          handles: [{ id: portId('l0', 'target'), kind: 'target', side: 'left', offset: 20 }],
        },
      ],
    ]);
    expect(straightLaid(placed, isCircle)).toEqual(placed);
  });

  const at = (x: number, y: number, width = 390, height = 100): EndBox => ({ x, y, width, height });
  const clerk: EndBox = { ...at(12, 12, 120, 70), circle: true };

  it('runs straight without a route when it is the only line on the card’s side', () => {
    const lines = floatingEnds(
      [{ id: 'l0', source: 'clerk', target: 'desk' }],
      new Map([
        ['clerk', clerk],
        ['desk', at(300, 0)],
      ]),
    );
    const line = lines.get('l0');
    expect(line?.start).toEqual({ x: 96, y: 36, side: 'right' });
    expect(line?.end.y).toBe(36);
    expect(line?.points).toHaveLength(2);
  });

  it('runs straight without a route with another line ending on the same side of the card', () => {
    const boxes = new Map<string, EndBox>([
      ['clerk', clerk],
      ['ledger', at(12, 300, 200, 60)],
      ['desk', at(300, 0, 390, 400)],
    ]);
    const lines = floatingEnds(
      [
        { id: 'l0', source: 'clerk', target: 'desk' },
        { id: 'l1', source: 'ledger', target: 'desk' },
      ],
      boxes,
    );
    const line = lines.get('l0');
    expect(line?.end.side).toBe('left');
    expect(line?.end.y).toBe(line?.start.y);
    expect(line?.points).toHaveLength(2);
    expect(lines.get('l1')?.end.side).toBe('left');
    expect(crossings([...lines.values()].map((each) => each.points))).toBe(0);
  });

  it('runs straight without a route beside a routed line’s end on the card’s side', () => {
    const lines = floatingEnds(
      [{ id: 'l0', source: 'desk', target: 'clerk' }],
      new Map([
        ['clerk', { ...clerk, x: 600 }],
        ['desk', at(12, 0, 390, 100)],
      ]),
      new Map([['desk', [{ side: 'right' as const, offset: 60 }]]]),
    );
    const line = lines.get('l0');
    expect(line?.end).toEqual({ x: 636, y: 36, side: 'left' });
    expect(line?.start.y).toBe(36);
    expect(line?.points).toHaveLength(2);
  });

  it('runs straight without a route from a circle with two lines on its side', () => {
    // The circle's ends spread on an arc, off its middle: the desk's end still lines up exactly.
    const lines = floatingEnds(
      [
        { id: 'l0', source: 'clerk', target: 'desk' },
        { id: 'l1', source: 'clerk', target: 'shelf' },
      ],
      new Map([
        ['clerk', clerk],
        ['desk', at(300, -50)],
        ['shelf', at(300, 140)],
      ]),
    );
    const line = lines.get('l0');
    expect(line?.start.y).toBeLessThan(36);
    expect(line?.end.y).toBe(line?.start.y);
    expect(line?.points).toHaveLength(2);
  });

  it('keeps the card’s end where a straight line would run through a card in the way', () => {
    const wall = at(200, 20, 40, 40);
    const lines = floatingEnds(
      [{ id: 'l0', source: 'clerk', target: 'desk' }],
      new Map([
        ['clerk', clerk],
        ['wall', wall],
        ['desk', at(300, 0)],
      ]),
    );
    // In the middle of the desk's side, as before: not level with the circle's end.
    expect(lines.get('l0')?.end).toEqual({ x: 300, y: 50, side: 'left' });
  });
});

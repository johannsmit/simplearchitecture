import { describe, expect, it } from 'vitest';
import {
  absoluteBoxes,
  containerBox,
  portId,
  spacing,
  type PlacedCard,
  type PlacedHandle,
} from '../src/viewing/explorer/canvas/elkLayout';
import {
  facingSide,
  freeOffset,
  freeSpot,
  keepCards,
  relinkHandles,
  samePlacement,
  type KeepInput,
} from '../src/viewing/explorer/canvas/placeCards';
import type { Box } from '../src/viewing/explorer/canvas/positions';

// New cards on a canvas that is not laid out again: every other card stays where it is.

const card = (
  id: string,
  x: number,
  y: number,
  options: { parent?: string; width?: number; height?: number; handles?: PlacedHandle[] } = {},
): PlacedCard => ({
  id,
  x,
  y,
  width: options.width ?? 160,
  height: options.height ?? 44,
  handles: options.handles ?? [],
  ...(options.parent === undefined ? {} : { parent: options.parent }),
});

const canvas = (...cards: PlacedCard[]) => new Map(cards.map((c) => [c.id, c]));

const small = { width: 160, height: 44 };
const containerSize = { width: containerBox.minWidth, height: containerBox.minHeight };

function input(
  previous: Map<string, PlacedCard>,
  cards: KeepInput['cards'],
  more: Partial<KeepInput> = {},
): KeepInput {
  return {
    previous,
    previousContainers: new Set(),
    cards,
    related: [],
    sizeOf: (_id, container) => (container ? containerSize : small),
    hints: new Map(),
    centre: { x: 0, y: 0 },
    ...more,
  };
}

/** No two top-level boxes (or two boxes in one container) overlap. */
function expectNoOverlap(placed: ReadonlyMap<string, PlacedCard>) {
  const boxes = absoluteBoxes(placed);
  const cards = [...placed.values()];
  for (const a of cards) {
    for (const b of cards) {
      if (a.id >= b.id || a.parent !== b.parent) continue;
      const [p, q] = [boxes.get(a.id) as Box, boxes.get(b.id) as Box];
      const apart =
        p.x + p.width <= q.x ||
        q.x + q.width <= p.x ||
        p.y + p.height <= q.y ||
        q.y + q.height <= p.y;
      expect(apart, `${a.id} and ${b.id}`).toBe(true);
    }
  }
}

const positionsOf = (placed: ReadonlyMap<string, PlacedCard>, ids: string[]) =>
  ids.map((id) => {
    const c = placed.get(id);
    return [id, c?.x, c?.y, c?.width, c?.height, c?.parent];
  });

describe('freeSpot', () => {
  it('takes the preferred point when it is free', () => {
    expect(freeSpot([{ x: 0, y: 0, ...small }], small, { x: 400, y: 0 })).toEqual({ x: 400, y: 0 });
  });

  it('takes the nearest spot that keeps the spacing from every box', () => {
    const boxes = [
      { x: 0, y: 0, ...small },
      { x: 188, y: 0, ...small },
    ];
    const spot = freeSpot(boxes, small, { x: 100, y: 0 });
    for (const box of boxes) {
      const apart =
        spot.x >= box.x + box.width + spacing.cards ||
        box.x >= spot.x + small.width + spacing.cards ||
        spot.y >= box.y + box.height + spacing.cards ||
        box.y >= spot.y + small.height + spacing.cards;
      expect(apart).toBe(true);
    }
    expect(spot.y === 0 || spot.x === 100).toBe(true);
  });

  it('always finds one on a crowded canvas', () => {
    const boxes = Array.from({ length: 30 }, (_, i) => ({
      x: (i % 6) * 170,
      y: Math.floor(i / 6) * 50,
      ...small,
    }));
    const spot = freeSpot(boxes, small, { x: 300, y: 100 });
    expect(
      boxes.every(
        (box) =>
          spot.x >= box.x + box.width ||
          box.x >= spot.x + small.width ||
          spot.y >= box.y + box.height ||
          box.y >= spot.y + small.height,
      ),
    ).toBe(true);
  });
});

describe('keepCards', () => {
  const before = canvas(card('a', 0, 0), card('b', 188, 0), card('c', 0, 140));

  it('leaves every card where it is when one is taken off', () => {
    const kept = keepCards(input(before, [{ id: 'a' }, { id: 'c' }]));
    expect([...kept.placed.keys()]).toEqual(['a', 'c']);
    expect(positionsOf(kept.placed, ['a', 'c'])).toEqual(positionsOf(before, ['a', 'c']));
  });

  it('puts a related card next to the card it came from, covering none', () => {
    const kept = keepCards(
      input(before, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'n' }], {
        hints: new Map([['n', { near: 'c' }]]),
      }),
    );
    expect(positionsOf(kept.placed, ['a', 'b', 'c'])).toEqual(positionsOf(before, ['a', 'b', 'c']));
    // Right of the card it came from: free there.
    expect(kept.placed.get('n')).toMatchObject({ x: 188, y: 140 });
    expectNoOverlap(kept.placed);
  });

  it('goes to the nearest free spot when the place next to the card is taken', () => {
    const kept = keepCards(
      input(before, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'n' }], {
        hints: new Map([['n', { near: 'a' }]]),
      }),
    );
    expect(positionsOf(kept.placed, ['a', 'b', 'c'])).toEqual(positionsOf(before, ['a', 'b', 'c']));
    expectNoOverlap(kept.placed);
  });

  it('lands a dropped card at the drop point, or the nearest free spot to it', () => {
    const free = keepCards(
      input(before, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'n' }], {
        hints: new Map([['n', { at: { x: 500, y: 300 } }]]),
      }),
    );
    expect(free.placed.get('n')).toMatchObject({ x: 500, y: 300 });
    const onCard = keepCards(
      input(before, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'n' }], {
        hints: new Map([['n', { at: { x: 10, y: 10 } }]]),
      }),
    );
    expect(positionsOf(onCard.placed, ['a', 'b', 'c'])).toEqual(
      positionsOf(before, ['a', 'b', 'c']),
    );
    expectNoOverlap(onCard.placed);
  });

  it('puts a card with no hint next to a related card, else in the middle of the view', () => {
    const related = keepCards(
      input(before, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'n' }], {
        related: [{ source: 'c', target: 'n' }],
      }),
    );
    expect(related.placed.get('n')).toMatchObject({ x: 188, y: 140 });
    const alone = keepCards(
      input(before, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'n' }], {
        centre: { x: 1000, y: 1000 },
      }),
    );
    expect(alone.placed.get('n')).toMatchObject({ x: 920, y: 978 });
  });

  it('packs the cards a new container brings inside it', () => {
    const kept = keepCards(
      input(
        before,
        [
          { id: 'a' },
          { id: 'b' },
          { id: 'c' },
          { id: 'box' },
          { id: 'x', parent: 'box' },
          { id: 'y', parent: 'box' },
        ],
        { hints: new Map([['box', { near: 'b' }]]) },
      ),
    );
    expect(kept.containers.has('box')).toBe(true);
    expect(kept.placed.get('x')).toMatchObject({ parent: 'box' });
    expect(kept.placed.get('y')).toMatchObject({ parent: 'box' });
    // Parents first.
    const order = [...kept.placed.keys()];
    expect(order.indexOf('box')).toBeLessThan(order.indexOf('x'));
    const box = kept.placed.get('box') as PlacedCard;
    for (const id of ['x', 'y']) {
      const inner = kept.placed.get(id) as PlacedCard;
      expect(inner.x).toBeGreaterThanOrEqual(containerBox.padding.left);
      expect(inner.y).toBeGreaterThanOrEqual(containerBox.padding.top);
      expect(inner.x + inner.width).toBeLessThanOrEqual(box.width - containerBox.padding.right);
      expect(inner.y + inner.height).toBeLessThanOrEqual(box.height - containerBox.padding.bottom);
    }
    expect(positionsOf(kept.placed, ['a', 'b', 'c'])).toEqual(positionsOf(before, ['a', 'b', 'c']));
    expectNoOverlap(kept.placed);
  });

  it('puts a card into a container on the canvas, which grows without moving other cards', () => {
    const withBox = canvas(
      card('box', 0, 0, { width: 200, height: 116 }),
      card('x', 16, 56, { parent: 'box' }),
      card('far', 600, 0),
      card('below', 0, 400),
    );
    const kept = keepCards(
      input(
        withBox,
        [
          { id: 'box' },
          { id: 'x', parent: 'box' },
          { id: 'far' },
          { id: 'below' },
          { id: 'n', parent: 'box' },
        ],
        { previousContainers: new Set(['box']) },
      ),
    );
    expect(kept.placed.get('n')?.parent).toBe('box');
    const box = kept.placed.get('box') as PlacedCard;
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width * box.height).toBeGreaterThan(200 * 116);
    const n = kept.placed.get('n') as PlacedCard;
    expect(n.x + n.width).toBeLessThanOrEqual(box.width - containerBox.padding.right);
    expect(n.y + n.height).toBeLessThanOrEqual(box.height - containerBox.padding.bottom);
    expect(positionsOf(kept.placed, ['x', 'far', 'below'])).toEqual(
      positionsOf(withBox, ['x', 'far', 'below']),
    );
    expectNoOverlap(kept.placed);
  });

  it('puts the card outside, next to its container, when growing would cover a card', () => {
    const boxed = canvas(
      card('box', 0, 0, { width: 200, height: 116 }),
      card('x', 16, 56, { parent: 'box' }),
      card('right', 210, 0),
      card('under', 0, 124),
    );
    const kept = keepCards(
      input(
        boxed,
        [
          { id: 'box' },
          { id: 'x', parent: 'box' },
          { id: 'right' },
          { id: 'under' },
          { id: 'n', parent: 'box' },
        ],
        { previousContainers: new Set(['box']) },
      ),
    );
    expect(kept.placed.get('n')?.parent).toBeUndefined();
    expect(positionsOf(kept.placed, ['box', 'x', 'right', 'under'])).toEqual(
      positionsOf(boxed, ['box', 'x', 'right', 'under']),
    );
    expectNoOverlap(kept.placed);
  });

  it('keeps a card in place, outside its container, once its Contains is gone', () => {
    const boxed = canvas(
      card('box', 100, 50, { width: 300, height: 200 }),
      card('x', 16, 56, { parent: 'box' }),
    );
    const kept = keepCards(
      input(boxed, [{ id: 'box' }, { id: 'x' }], { previousContainers: new Set(['box']) }),
    );
    expect(kept.placed.get('x')).toMatchObject({ x: 116, y: 106 });
    expect(kept.placed.get('x')?.parent).toBeUndefined();
    expect(kept.placed.get('box')).toMatchObject({ x: 100, y: 50, width: 300, height: 200 });
  });

  it('leaves a card where it is when a new Contains would nest it', () => {
    const kept = keepCards(input(before, [{ id: 'a' }, { id: 'b', parent: 'a' }, { id: 'c' }]));
    expect(positionsOf(kept.placed, ['a', 'b', 'c'])).toEqual(positionsOf(before, ['a', 'b', 'c']));
  });

  it('lets a card grow when its name grows, in place', () => {
    const kept = keepCards(
      input(before, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
        sizeOf: (id) => (id === 'a' ? { width: 220, height: 44 } : small),
      }),
    );
    expect(kept.placed.get('a')).toMatchObject({ x: 0, y: 0, width: 220 });
    expect(positionsOf(kept.placed, ['b', 'c'])).toEqual(positionsOf(before, ['b', 'c']));
  });
});

describe('relinkHandles', () => {
  const route = { bends: [{ x: 80, y: 60 }], target: { x: 188, y: 140 } };
  const placed = canvas(
    card('a', 0, 0, {
      handles: [
        { id: portId('l1', 'source'), kind: 'source', side: 'bottom', offset: 80, route },
        { id: portId('l0', 'source'), kind: 'source', side: 'right', offset: 22 },
      ],
    }),
    card('b', 188, 140, {
      handles: [{ id: portId('l1', 'target'), kind: 'target', side: 'top', offset: 80 }],
    }),
    card('c', 400, 0, {
      handles: [{ id: portId('l0', 'target'), kind: 'target', side: 'left', offset: 22 }],
    }),
  );
  const previousLinks = new Map([
    ['l0', 'r-ac'],
    ['l1', 'r-ab'],
  ]);

  it('keeps the handles and route of a line under its new id, and drops a line that went', () => {
    // r-ac was deleted, so r-ab is now the first relationship.
    const next = relinkHandles(placed, previousLinks, [
      { id: 'l0', relationshipId: 'r-ab', source: 'a', target: 'b' },
    ]);
    expect(next.get('a')?.handles).toEqual([
      { id: portId('l0', 'source'), kind: 'source', side: 'bottom', offset: 80, route },
    ]);
    expect(next.get('b')?.handles).toEqual([
      { id: portId('l0', 'target'), kind: 'target', side: 'top', offset: 80 },
    ]);
    expect(next.get('c')?.handles).toEqual([]);
    expect(positionsOf(next, ['a', 'b', 'c'])).toEqual(positionsOf(placed, ['a', 'b', 'c']));
  });

  it('gives a new line handles on the facing sides, apart from the others', () => {
    const next = relinkHandles(placed, previousLinks, [
      { id: 'l0', relationshipId: 'r-ac', source: 'a', target: 'c' },
      { id: 'l1', relationshipId: 'r-ab', source: 'a', target: 'b' },
      { id: 'l2', relationshipId: 'r-new', source: 'a', target: 'c' },
    ]);
    const added = next.get('a')?.handles.find((h) => h.id === portId('l2', 'source'));
    expect(added).toMatchObject({ kind: 'source', side: 'right' });
    expect(added?.route).toBeUndefined();
    expect(Math.abs((added?.offset ?? 0) - 22)).toBeGreaterThanOrEqual(spacing.ports);
    expect(next.get('c')?.handles.find((h) => h.id === portId('l2', 'target'))).toMatchObject({
      kind: 'target',
      side: 'left',
    });
  });

  it('moves the handles of a reversed line to the right ends', () => {
    const next = relinkHandles(placed, previousLinks, [
      { id: 'l0', relationshipId: 'r-ac', source: 'a', target: 'c' },
      { id: 'l1', relationshipId: 'r-ab', source: 'b', target: 'a' },
    ]);
    expect(next.get('b')?.handles.map((h) => [h.id, h.kind, h.side])).toEqual([
      [portId('l1', 'source'), 'source', 'top'],
    ]);
    expect(next.get('a')?.handles.find((h) => h.id === portId('l1', 'target'))?.side).toBe(
      'bottom',
    );
  });
});

describe('facingSide and freeOffset', () => {
  it('picks the side towards the other card', () => {
    const at = { x: 0, y: 0, ...small };
    expect(facingSide(at, { x: 300, y: 0, ...small })).toBe('right');
    expect(facingSide(at, { x: -300, y: 10, ...small })).toBe('left');
    expect(facingSide(at, { x: 0, y: 200, ...small })).toBe('bottom');
    expect(facingSide(at, { x: 20, y: -200, ...small })).toBe('top');
  });

  it('starts in the middle and keeps the port spacing', () => {
    expect(freeOffset([], 'top', 160)).toBe(80);
    const taken: PlacedHandle[] = [{ id: 'h', kind: 'source', side: 'top', offset: 80 }];
    expect(freeOffset(taken, 'top', 160)).toBe(92);
    expect(freeOffset(taken, 'left', 44)).toBe(22);
  });
});

describe('samePlacement', () => {
  it('tells a change of place, size or handles', () => {
    const a = canvas(card('a', 0, 0));
    expect(samePlacement(a, canvas(card('a', 0, 0)))).toBe(true);
    expect(samePlacement(a, canvas(card('a', 1, 0)))).toBe(false);
    expect(samePlacement(a, canvas(card('a', 0, 0), card('b', 300, 0)))).toBe(false);
    expect(
      samePlacement(
        a,
        canvas(card('a', 0, 0, { handles: [{ id: 'x', kind: 'source', side: 'top', offset: 1 }] })),
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { spacing, type PlacedCard } from '../src/viewing/explorer/canvas/elkLayout';
import {
  arrangeCards,
  draggedPositions,
  hasMovedCards,
  isMoveKey,
  movedBy,
  moveStep,
  noMovedPositions,
  panToKeepInView,
  withMovedCard,
} from '../src/viewing/explorer/canvas/positions';

const card = (id: string, x: number, y: number, width = 100, height = 50): PlacedCard => ({
  id,
  x,
  y,
  width,
  height,
  handles: [],
});

const layout = (...cards: PlacedCard[]) => new Map(cards.map((c) => [c.id, c]));
const at = (map: ReadonlyMap<string, PlacedCard>, id: string) => {
  const c = map.get(id);
  return c && { x: c.x, y: c.y };
};

describe('moved positions', () => {
  it('adds, replaces and removes a moved card without changing the old map', () => {
    const one = withMovedCard(noMovedPositions, 'a', { x: 1, y: 2 });
    const two = withMovedCard(one, 'a', { x: 5, y: 6 });
    expect([...one]).toEqual([['a', { x: 1, y: 2 }]]);
    expect([...two]).toEqual([['a', { x: 5, y: 6 }]]);
    expect([...withMovedCard(two, 'a', undefined)]).toEqual([]);
    expect(noMovedPositions.size).toBe(0);
  });

  it('counts only moved cards that are on the canvas', () => {
    const moved = withMovedCard(noMovedPositions, 'gone', { x: 0, y: 0 });
    expect(hasMovedCards(moved, new Set(['a']))).toBe(false);
    expect(hasMovedCards(moved, new Set(['a', 'gone']))).toBe(true);
    expect(hasMovedCards(noMovedPositions, new Set(['a']))).toBe(false);
  });

  it('moves a point one step in each direction', () => {
    const p = { x: 10, y: 20 };
    expect(movedBy(p, 'left', 8)).toEqual({ x: 2, y: 20 });
    expect(movedBy(p, 'right', 8)).toEqual({ x: 18, y: 20 });
    expect(movedBy(p, 'up', 40)).toEqual({ x: 10, y: -20 });
    expect(movedBy(p, 'down', 40)).toEqual({ x: 10, y: 60 });
  });

  it('uses 8px steps, and 40px with Shift; M (without Ctrl, Alt or Cmd) is the move key', () => {
    expect(moveStep({ shiftKey: false })).toBe(8);
    expect(moveStep({ shiftKey: true })).toBe(40);
    const keys = { altKey: false, ctrlKey: false, metaKey: false };
    expect(isMoveKey({ key: 'm', ...keys })).toBe(true);
    expect(isMoveKey({ key: 'M', ...keys })).toBe(true);
    expect(isMoveKey({ key: 'n', ...keys })).toBe(false);
    expect(isMoveKey({ key: 'm', ...keys, ctrlKey: true })).toBe(false);
    expect(isMoveKey({ key: 'm', ...keys, metaKey: true })).toBe(false);
    expect(isMoveKey({ key: 'm', ...keys, altKey: true })).toBe(false);
  });
});

describe('arrangeCards', () => {
  it('returns the layout itself when nothing on it has moved', () => {
    const placed = layout(card('a', 0, 0));
    expect(arrangeCards(placed, noMovedPositions)).toBe(placed);
    expect(arrangeCards(placed, withMovedCard(noMovedPositions, 'gone', { x: 9, y: 9 }))).toBe(
      placed,
    );
  });

  it('puts moved cards where they were moved and leaves cards they don’t cover alone', () => {
    const placed = layout(card('a', 0, 0), card('b', 0, 100), card('c', 300, 0));
    const result = arrangeCards(placed, withMovedCard(noMovedPositions, 'a', { x: 600, y: 400 }));
    expect(at(result, 'a')).toEqual({ x: 600, y: 400 });
    expect(result.get('b')).toBe(placed.get('b'));
    expect(result.get('c')).toBe(placed.get('c'));
    // Same order as the layout, so React Flow's node order doesn't change.
    expect([...result.keys()]).toEqual(['a', 'b', 'c']);
    // Size and handles come from the layout.
    expect(result.get('a')?.width).toBe(100);
  });

  it('pushes a covered card down below the moved card, and the cards under it along', () => {
    // A column: b above c. "a" is dropped onto b.
    const placed = layout(card('a', 400, 0), card('b', 0, 0), card('c', 0, 78));
    const result = arrangeCards(placed, withMovedCard(noMovedPositions, 'a', { x: 10, y: 10 }));
    expect(at(result, 'a')).toEqual({ x: 10, y: 10 });
    const b = result.get('b');
    const c = result.get('c');
    expect(b?.x).toBe(0);
    expect(b?.y).toBe(10 + 50 + spacing.cards);
    // c was below b: it moves down too, so b doesn't cover it.
    expect(c?.y).toBeGreaterThanOrEqual((b?.y ?? 0) + 50 + 12);
    expect(c?.x).toBe(0);
  });

  it('never leaves a laid-out card under a moved one', () => {
    const placed = layout(
      ...Array.from({ length: 12 }, (_, i) => card(`k${i}`, (i % 3) * 200, Math.floor(i / 3) * 80)),
    );
    const moved = withMovedCard(withMovedCard(noMovedPositions, 'k0', { x: 210, y: 90 }), 'k1', {
      x: 20,
      y: 170,
    });
    const result = [...arrangeCards(placed, moved).values()];
    for (const a of result) {
      for (const b of result) {
        if (a === b) continue;
        const overlap =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlap, `${a.id} and ${b.id}`).toBe(false);
      }
    }
  });
});

describe('draggedPositions', () => {
  it('keeps only position changes with a position, as element ids', () => {
    const ids = new Map([['n0', 'element "a"']]);
    expect(
      draggedPositions(
        [
          { type: 'position', id: 'n0', position: { x: 4, y: 5 }, dragging: true },
          { type: 'position', id: 'n0', dragging: false },
          { type: 'position', id: 'n9', position: { x: 1, y: 1 } },
          { type: 'dimensions', id: 'n0', dimensions: { width: 1, height: 1 } },
          { type: 'select', id: 'n0', selected: true },
        ],
        (id) => ids.get(id),
      ),
    ).toEqual([['element "a"', { x: 4, y: 5 }]]);
  });
});

describe('panToKeepInView', () => {
  const size = { width: 800, height: 600 };
  const view = { x: 0, y: 0, zoom: 1 };

  it('does nothing while the card is 24px inside the canvas', () => {
    expect(panToKeepInView({ x: 24, y: 24, width: 100, height: 50 }, view, size)).toBeUndefined();
    expect(panToKeepInView({ x: 676, y: 526, width: 100, height: 50 }, view, size)).toBeUndefined();
  });

  it('pans just enough at each edge, taking zoom into account', () => {
    expect(panToKeepInView({ x: 10, y: 100, width: 100, height: 50 }, view, size)).toEqual({
      x: 14,
      y: 0,
      zoom: 1,
    });
    expect(panToKeepInView({ x: 700, y: 560, width: 100, height: 50 }, view, size)).toEqual({
      x: -24,
      y: -34,
      zoom: 1,
    });
    // At 50%, a card at x 1500 is drawn at 750 - 300 = 450 … 500: inside.
    expect(
      panToKeepInView(
        { x: 1500, y: 0, width: 100, height: 50 },
        { x: -300, y: 24, zoom: 0.5 },
        size,
      ),
    ).toBeUndefined();
  });

  it('keeps the top left corner in view when the card is larger than the canvas', () => {
    expect(
      panToKeepInView({ x: 100, y: 0, width: 2000, height: 50 }, { x: 0, y: 24, zoom: 1 }, size),
    ).toEqual({ x: -76, y: 24, zoom: 1 });
  });

  it('does nothing before the canvas has a size', () => {
    expect(
      panToKeepInView({ x: -500, y: 0, width: 10, height: 10 }, view, { width: 0, height: 0 }),
    ).toBeUndefined();
  });
});

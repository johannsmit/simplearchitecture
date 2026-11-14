import { maxViewCardWidth, minViewCardWidth } from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import { maxSetCardWidth, minCardWidth } from '../src/viewing/explorer/canvas/cardSize';
import { containerBox, type PlacedCard } from '../src/viewing/explorer/canvas/elkLayout';
import {
  layoutOfCanvas,
  storedPlacement,
  storedPositions,
  storedWidths,
} from '../src/viewing/explorer/canvas/viewLayout';

// A view's stored layout on the canvas, worked out without a browser. Made-up ids.

const sizeOf = (id: string, container: boolean) =>
  container ? { width: 200, height: 116 } : { width: id === 'wide' ? 240 : 168, height: 44 };

const card = (id: string, x: number, y: number, extra: Partial<PlacedCard> = {}): PlacedCard => ({
  id,
  x,
  y,
  width: 168,
  height: 44,
  handles: [],
  ...extra,
});

describe('a stored layout', () => {
  it('holds the same width bounds as the canvas', () => {
    expect(minViewCardWidth).toBe(minCardWidth);
    expect(maxViewCardWidth).toBe(maxSetCardWidth);
  });

  it('puts each card with a position there, and leaves out the others', () => {
    const { placed, containers } = storedPlacement({
      cards: [{ id: 'a' }, { id: 'b' }, { id: 'wide' }],
      stored: new Map([
        ['wide', { x: -50, y: 12.5 }],
        ['a', { x: 10, y: 20 }],
      ]),
      sizeOf,
    });
    expect([...placed.values()]).toEqual([
      card('a', 10, 20),
      card('wide', -50, 12.5, { width: 240 }),
    ]);
    expect(containers.size).toBe(0);
  });

  it('nests a card inside its container when both have a position, relative to it', () => {
    const { placed, containers } = storedPlacement({
      cards: [{ id: 'inner', parent: 'box' }, { id: 'box' }, { id: 'loose', parent: 'gone' }],
      stored: new Map([
        ['inner', { x: 116, y: 156 }],
        ['box', { x: 100, y: 100 }],
        ['loose', { x: 500, y: 0 }],
      ]),
      sizeOf,
    });
    // Parents first; the container holds what is inside it.
    expect([...placed.keys()]).toEqual(['box', 'loose', 'inner']);
    expect(placed.get('inner')).toEqual(card('inner', 16, 56, { parent: 'box' }));
    const { padding } = containerBox;
    expect(placed.get('box')).toEqual(
      card('box', 100, 100, {
        width: Math.max(200, 16 + 168 + padding.right),
        height: Math.max(116, 56 + 44 + padding.bottom),
      }),
    );
    // Its container isn't on the canvas: on the canvas where it was.
    expect(placed.get('loose')).toEqual(card('loose', 500, 0));
    expect([...containers]).toEqual(['box']);
  });

  it('keeps a nested card within its container content area', () => {
    const { placed } = storedPlacement({
      cards: [{ id: 'box' }, { id: 'inner', parent: 'box' }],
      stored: new Map([
        ['box', { x: 100, y: 100 }],
        // Saved with nesting off: above and left of the container's top left corner.
        ['inner', { x: 60, y: 90 }],
      ]),
      sizeOf,
    });
    expect(placed.get('inner')).toMatchObject({
      x: containerBox.padding.left,
      y: containerBox.padding.top,
    });
  });

  it('nests no card in a loop of containers', () => {
    const { placed } = storedPlacement({
      cards: [
        { id: 'a', parent: 'b' },
        { id: 'b', parent: 'a' },
      ],
      stored: new Map([
        ['a', { x: 0, y: 0 }],
        ['b', { x: 300, y: 0 }],
      ]),
      sizeOf,
    });
    expect(placed.size).toBe(2);
    expect([...placed.values()].some((c) => c.parent === undefined)).toBe(true);
  });

  it('reads positions and widths from a view', () => {
    const layout = [
      { elementId: 'a', x: 1, y: 2 },
      { elementId: 'b', x: 3, y: 4, width: 300 },
    ];
    expect(storedPositions(layout)).toEqual(
      new Map([
        ['a', { x: 1, y: 2 }],
        ['b', { x: 3, y: 4 }],
      ]),
    );
    expect(storedWidths(layout)).toEqual(new Map([['b', 300]]));
  });
});

describe('the layout a view saves of the canvas', () => {
  it('has every card on the canvas, to a tenth of a pixel, and widths set by hand only', () => {
    const shown = new Map([
      ['box', card('box', 100.04, 50, { width: 400, height: 200 })],
      ['inner', card('inner', 16.26, 56, { parent: 'box', width: 250.6 })],
      ['plain', card('plain', -10.55, 0)],
    ]);
    expect(layoutOfCanvas(shown, (id) => id === 'inner')).toEqual([
      { elementId: 'box', x: 100, y: 50 },
      { elementId: 'inner', x: 116.3, y: 106, width: 251 },
      { elementId: 'plain', x: -10.5, y: 0 },
    ]);
  });

  it('keeps within the bounds the server takes', () => {
    const shown = new Map([
      ['far', card('far', 5_000_000, -5_000_000, { width: 900 })],
      ['narrow', card('narrow', Number.NaN, 0, { width: 20 })],
      ['thin', card('thin', 0, 0, { width: 20 })],
    ]);
    expect(layoutOfCanvas(shown, () => true)).toEqual([
      { elementId: 'far', x: 1_000_000, y: -1_000_000, width: 480 },
      { elementId: 'thin', x: 0, y: 0, width: 168 },
    ]);
  });
});

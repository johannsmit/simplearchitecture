import { describe, expect, it } from 'vitest';
import { holdingOf, settleAfterDrop } from '../src/viewing/explorer/canvas/cardDrag';
import {
  groupDragMoves,
  groupDragOf,
  isPickClick,
  selectedCards,
  toggledCard,
} from '../src/viewing/explorer/canvas/cardSelection';
import type { Laid } from '../src/viewing/explorer/canvas/canvasModel';
import type { PlacedCard } from '../src/viewing/explorer/canvas/elkLayout';
import { fitContainers, type Holding, type Point } from '../src/viewing/explorer/canvas/positions';

// Several cards selected at once and dragged together: which cards are selected, which move, and
// by how much. Made-up cards.

const card = (id: string, x: number, y: number, parent?: string, size = 100): PlacedCard => ({
  id,
  x,
  y,
  width: size,
  height: size / 2,
  handles: [],
  ...(parent === undefined ? {} : { parent }),
});
const layout = (...cards: PlacedCard[]) => new Map(cards.map((c) => [c.id, c]));

/** The drag that starts on `grabbed`, which must be one of several selected cards. */
function dragOf(shown: ReadonlyMap<string, PlacedCard>, selected: string[], grabbed: string) {
  const drag = groupDragOf(shown, selected, grabbed);
  if (!drag) throw new Error(`no drag of several cards from ${grabbed}`);
  return drag;
}

describe('the selected cards', () => {
  const onCanvas = new Set(['kettle', 'teapot', 'mug', 'saucer']);

  it('is the details card alone without picks, or nothing when none is selected', () => {
    expect(selectedCards(null, 'k', 'mug', onCanvas)).toEqual(['mug']);
    expect(selectedCards(null, 'k', undefined, onCanvas)).toEqual([]);
    expect(selectedCards(null, 'k', 'elsewhere', onCanvas)).toEqual([]);
  });

  it('are the picks, in the order added, while they end with the details card', () => {
    const picks = { key: 'k', ids: ['kettle', 'teapot', 'mug'] };
    expect(selectedCards(picks, 'k', 'mug', onCanvas)).toEqual(['kettle', 'teapot', 'mug']);
  });

  it('leave only the details card once another canvas shows, or another card is selected', () => {
    const picks = { key: 'k', ids: ['kettle', 'mug'] };
    expect(selectedCards(picks, 'other canvas', 'mug', onCanvas)).toEqual(['mug']);
    expect(selectedCards(picks, 'k', 'saucer', onCanvas)).toEqual(['saucer']);
  });

  it('lose a card taken off the canvas', () => {
    const picks = { key: 'k', ids: ['kettle', 'gone', 'mug'] };
    expect(selectedCards(picks, 'k', 'mug', onCanvas)).toEqual(['kettle', 'mug']);
  });

  it('a modifier click adds a card last, or takes a selected one out, keeping the order', () => {
    expect(toggledCard(['kettle'], 'mug')).toEqual(['kettle', 'mug']);
    expect(toggledCard(['kettle', 'teapot', 'mug'], 'mug')).toEqual(['kettle', 'teapot']);
    expect(toggledCard(['kettle', 'teapot', 'mug'], 'kettle')).toEqual(['teapot', 'mug']);
    expect(toggledCard(['mug'], 'mug')).toEqual([]);
  });

  it('Shift, Ctrl or Cmd make a click add or take out', () => {
    const none = { shiftKey: false, ctrlKey: false, metaKey: false };
    expect(isPickClick(none)).toBe(false);
    expect(isPickClick({ ...none, shiftKey: true })).toBe(true);
    expect(isPickClick({ ...none, ctrlKey: true })).toBe(true);
    expect(isPickClick({ ...none, metaKey: true })).toBe(true);
  });
});

describe('dragging several selected cards', () => {
  // A container (the cupboard) holding two cards, and two cards beside it.
  const shown = layout(
    card('cupboard', 400, 0, undefined, 300),
    card('cup', 16, 56, 'cupboard'),
    card('plate', 140, 56, 'cupboard'),
    card('kettle', 0, 0),
    card('mug', 0, 200),
  );

  it('moves nothing together when the grabbed card is alone or not selected', () => {
    expect(groupDragOf(shown, ['kettle'], 'kettle')).toBeUndefined();
    expect(groupDragOf(shown, ['kettle', 'mug'], 'cup')).toBeUndefined();
  });

  it('moves every selected card by the grabbed card’s offset, keeping their places', () => {
    const drag = dragOf(shown, ['kettle', 'mug', 'plate'], 'mug');
    const moves = new Map(groupDragMoves(drag, { x: 30, y: 240 }, shown));
    expect(moves).toEqual(
      new Map<string, Point>([
        ['kettle', { x: 30, y: 40 }],
        ['mug', { x: 30, y: 240 }],
        ['plate', { x: 170, y: 96 }],
      ]),
    );
  });

  it('keeps a card inside its container: never left of or above its content area', () => {
    const drag = dragOf(shown, ['kettle', 'cup'], 'kettle');
    const moves = new Map(groupDragMoves(drag, { x: -50, y: -50 }, shown));
    expect(moves.get('kettle')).toEqual({ x: -50, y: -50 });
    expect(moves.get('cup')).toEqual({ x: 16, y: 56 });
  });

  it('moves a selected card inside a selected container only with its container', () => {
    const drag = dragOf(shown, ['cup', 'cupboard', 'kettle'], 'kettle');
    expect([...drag.starts.keys()].sort()).toEqual(['cupboard', 'kettle']);
    // Grabbing the card inside moves the container (and the card with it), not the card twice.
    const inner = dragOf(shown, ['cup', 'cupboard'], 'cup');
    const moves = new Map(groupDragMoves(inner, { x: 36, y: 66 }, shown));
    expect(moves).toEqual(new Map([['cupboard', { x: 420, y: 10 }]]));
  });

  it('the containers of every card held only grow until the drop', () => {
    const before = layout(
      card('cupboard', 400, 0, undefined, 300),
      // Moved right, away from the cupboard's padding: a fit would pull it back.
      card('cup', 60, 56, 'cupboard'),
      card('kettle', 0, 0),
    );
    const hold: Holding = holdingOf(before, 'kettle', ['cup']);
    expect(fitContainers(before, ['cupboard'], { holding: hold }).get('cup')?.x).toBe(60);
    expect(fitContainers(before, ['cupboard']).get('cup')?.x).toBe(16);
  });

  it('on the drop, a container pushes only the cards that were not dropped with it', () => {
    // The cupboard grew down over the kettle and the mug while both it and the mug were held.
    const shownNow = layout(
      card('cupboard', 0, 0, undefined, 300),
      card('cup', 16, 56, 'cupboard'),
      card('kettle', 0, 160),
      card('mug', 120, 160),
    );
    const sizes = new Map([
      ['cupboard', { width: 300, height: 100 }],
      ['cup', { width: 100, height: 50 }],
      ['kettle', { width: 100, height: 50 }],
      ['mug', { width: 100, height: 50 }],
    ]);
    const drop: Holding = { id: 'cup', sizes, others: ['mug'] };
    const moves: [string, Point | undefined][] = [];
    settleAfterDrop({
      laid: { placed: shownNow } as unknown as Laid,
      shown: shownNow,
      moved: new Map([['cup', { x: 16, y: 56 }]]),
      holding: undefined,
      onMove: (id, point) => moves.push([id, point]),
      wantArranged: () => undefined,
      dropped: { current: drop },
      settling: { current: false },
    });
    expect(moves.map(([id]) => id)).toEqual(['kettle']);
  });
});

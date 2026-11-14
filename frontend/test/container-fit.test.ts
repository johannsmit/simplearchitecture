import { describe, expect, it } from 'vitest';
import {
  absoluteBoxes,
  containerBox,
  type PlacedCard,
} from '../src/viewing/explorer/canvas/elkLayout';
import {
  arrangeCards,
  clampToContainer,
  fitContainers,
  pushedByContainer,
  type Holding,
} from '../src/viewing/explorer/canvas/positions';
import { storedPlacement } from '../src/viewing/explorer/canvas/viewLayout';

// Containers fit what they hold: their cards start at the padding on the left and top, and the
// container is just big enough for them. Its own corner stays where it is. Made-up ids.

const { padding } = containerBox;
const card = (id: string, x: number, y: number, extra: Partial<PlacedCard> = {}): PlacedCard => ({
  id,
  x,
  y,
  width: 168,
  height: 44,
  handles: [],
  ...extra,
});
const sizesOf = (cards: ReadonlyMap<string, PlacedCard>) =>
  new Map([...cards].map(([id, each]) => [id, { width: each.width, height: each.height }]));
const holding = (id: string, cards: ReadonlyMap<string, PlacedCard>): Holding => ({
  id,
  sizes: sizesOf(cards),
});
const smallest = { width: containerBox.minWidth, height: containerBox.minHeight };

describe('a stored layout opens with every container fitted', () => {
  const sizeOf = (_id: string, container: boolean) =>
    container ? smallest : { width: 168, height: 44 };

  it('a container holding a container holding one card far to the right has no empty room', () => {
    const { placed } = storedPlacement({
      cards: [{ id: 'site' }, { id: 'hall', parent: 'site' }, { id: 'pump', parent: 'hall' }],
      stored: new Map([
        ['site', { x: 0, y: 0 }],
        ['hall', { x: 16, y: 56 }],
        ['pump', { x: 600, y: 112 }],
      ]),
      sizeOf,
    });
    expect(placed.get('pump')).toEqual(card('pump', 16, 56, { parent: 'hall' }));
    // Just big enough: the smallest container holds one card.
    expect(placed.get('hall')).toEqual(card('hall', 16, 56, { parent: 'site', ...smallest }));
    expect(placed.get('site')).toEqual(
      card('site', 0, 0, {
        width: 16 + smallest.width + padding.right,
        height: 56 + smallest.height + padding.bottom,
      }),
    );
  });

  it('closes room on the left and top, the cards keeping their places relative to each other', () => {
    const { placed, asLeft } = storedPlacement({
      cards: [{ id: 'box' }, { id: 'a', parent: 'box' }, { id: 'b', parent: 'box' }],
      stored: new Map([
        ['box', { x: 100, y: 100 }],
        ['a', { x: 180, y: 200 }],
        ['b', { x: 400, y: 260 }],
      ]),
      sizeOf,
    });
    expect(placed.get('a')).toMatchObject({ x: 16, y: 56 });
    expect(placed.get('b')).toMatchObject({ x: 236, y: 116 });
    expect(placed.get('box')).toMatchObject({ x: 100, y: 100, width: 420, height: 176 });
    // As the layout was left, for reading the lines' stored routes.
    expect(absoluteBoxes(asLeft).get('b')).toMatchObject({ x: 400, y: 260 });
  });

  it('moves cards saved left of or above their container in together, not one by one', () => {
    const { placed } = storedPlacement({
      cards: [{ id: 'box' }, { id: 'a', parent: 'box' }, { id: 'b', parent: 'box' }],
      stored: new Map([
        ['box', { x: 100, y: 100 }],
        ['a', { x: 60, y: 90 }],
        ['b', { x: 300, y: 200 }],
      ]),
      sizeOf,
    });
    expect(placed.get('a')).toMatchObject({ x: 16, y: 56 });
    expect(placed.get('b')).toMatchObject({ x: 256, y: 166 });
  });
});

describe('fitting containers', () => {
  it('changes nothing in a container that already fits', () => {
    const cards = new Map([
      ['box', card('box', 10, 20, { width: 420, height: 176 })],
      ['a', card('a', 16, 56, { parent: 'box' })],
      ['b', card('b', 236, 116, { parent: 'box' })],
    ]);
    expect(fitContainers(cards, ['box'])).toEqual(cards);
  });

  it('keeps a container at least big enough for its name', () => {
    const cards = new Map([
      ['box', card('box', 0, 0, { width: 900, height: 400 })],
      ['a', card('a', 16, 56, { parent: 'box' })],
    ]);
    const fitted = fitContainers(cards, ['box'], {
      minSizeOf: () => ({ width: 260, height: 116 }),
    });
    expect(fitted.get('box')).toMatchObject({ width: 260, height: 116 });
  });
});

describe('moving a card inside a container', () => {
  // A container with two cards side by side, fitted.
  const placed = new Map([
    ['box', card('box', 100, 100, { width: 400, height: 116 })],
    ['a', card('a', 16, 56, { parent: 'box' })],
    ['b', card('b', 216, 56, { parent: 'box' })],
  ]);

  it('left and up, it stops at the padding: the container’s corner stays', () => {
    expect(clampToContainer({ x: -50, y: 0 })).toEqual({ x: padding.left, y: padding.top });
    expect(clampToContainer({ x: 900, y: 900 })).toEqual({ x: 900, y: 900 });
    const shown = arrangeCards(placed, new Map([['a', { x: -50, y: 0 }]]), {
      holding: holding('a', placed),
    });
    expect(shown.get('a')).toMatchObject({ x: 16, y: 56 });
    expect(shown.get('box')).toMatchObject({ x: 100, y: 100, width: 400, height: 116 });
  });

  it('dragged past the right or bottom edge, the container grows to hold it', () => {
    const shown = arrangeCards(placed, new Map([['b', { x: 500, y: 200 }]]), {
      holding: holding('b', placed),
    });
    expect(shown.get('b')).toMatchObject({ x: 500, y: 200, parent: 'box' });
    expect(shown.get('a')).toEqual(placed.get('a'));
    expect(shown.get('box')).toMatchObject({
      x: 100,
      y: 100,
      width: 500 + 168 + padding.right,
      height: 200 + 44 + padding.bottom,
    });
  });

  it('while held, nothing else in the container moves and it doesn’t shrink', () => {
    // The leftmost card dragged right: the room it leaves stays until the drop.
    const shown = arrangeCards(placed, new Map([['a', { x: 300, y: 56 }]]), {
      holding: holding('a', placed),
    });
    expect(shown.get('a')).toMatchObject({ x: 300, y: 56 });
    expect(shown.get('b')).toEqual(placed.get('b'));
    expect(shown.get('box')).toMatchObject({ width: 300 + 168 + padding.right, height: 116 });
    const back = arrangeCards(placed, new Map([['b', { x: 100, y: 56 }]]), {
      holding: holding('b', placed),
    });
    expect(back.get('box')).toMatchObject({ width: 400, height: 116 });
  });

  it('on the drop the container fits: room on the left is closed by its cards moving together', () => {
    const shown = arrangeCards(placed, new Map([['a', { x: 300, y: 56 }]]));
    expect(shown.get('b')).toMatchObject({ x: 16, y: 56 });
    expect(shown.get('a')).toMatchObject({ x: 100, y: 56 });
    expect(shown.get('box')).toMatchObject({
      x: 100,
      y: 100,
      width: 100 + 168 + padding.right,
      height: 116,
    });
  });

  it('on the drop the container can shrink', () => {
    const shown = arrangeCards(placed, new Map([['b', { x: 16, y: 120 }]]));
    expect(shown.get('box')).toMatchObject({
      width: smallest.width,
      height: 120 + 44 + padding.bottom,
    });
  });

  it('nested containers grow and fit from the innermost out', () => {
    const nested = new Map([
      ['site', card('site', 0, 0, { width: 232, height: 188 })],
      ['hall', card('hall', 16, 56, { parent: 'site', ...smallest })],
      ['pump', card('pump', 16, 56, { parent: 'hall' })],
    ]);
    const held = arrangeCards(nested, new Map([['pump', { x: 400, y: 56 }]]), {
      holding: holding('pump', nested),
    });
    expect(held.get('hall')).toMatchObject({ x: 16, y: 56, width: 400 + 168 + padding.right });
    expect(held.get('site')).toMatchObject({ x: 0, y: 0, width: 16 + 584 + padding.right });
    // Dropped there: the only card goes back to the padding, and both fit again.
    const dropped = arrangeCards(nested, new Map([['pump', { x: 400, y: 56 }]]));
    expect(dropped.get('pump')).toMatchObject({ x: 16, y: 56 });
    expect(dropped.get('hall')).toMatchObject(smallest);
    expect(dropped.get('site')).toMatchObject({ width: 232, height: 188 });
  });

  it('nothing outside the container moves when it grows', () => {
    const withNeighbour = new Map([
      ...placed,
      ['next', card('next', 540, 100)],
      ['below', card('below', 100, 260)],
    ]);
    const shown = arrangeCards(withNeighbour, new Map([['b', { x: 500, y: 200 }]]), {
      holding: holding('b', withNeighbour),
    });
    expect(shown.get('next')).toEqual(withNeighbour.get('next'));
    expect(shown.get('below')).toEqual(withNeighbour.get('below'));
    const dropped = arrangeCards(withNeighbour, new Map([['b', { x: 500, y: 200 }]]));
    expect(dropped.get('next')).toEqual(withNeighbour.get('next'));
    expect(dropped.get('below')).toEqual(withNeighbour.get('below'));
  });
});

describe('a container with no cards left', () => {
  it('is just big enough for its name', () => {
    const cards = new Map([['box', card('box', 0, 0, { width: 600, height: 300 })]]);
    expect(fitContainers(cards, ['box']).get('box')).toMatchObject({ x: 0, y: 0, ...smallest });
  });
});

describe('a container that grew on a drop', () => {
  // Site holds Pump; Site grew from 232 wide to 600 when Pump was dropped further right.
  const shown = new Map([
    ['site', card('site', 0, 0, { width: 600, height: 188 })],
    ['pump', card('pump', 416, 56, { parent: 'site' })],
    ['tank', card('tank', 400, 40)],
    ['valve', card('valve', 400, 260)],
    ['far', card('far', 900, 0)],
  ]);
  const before = new Map([['site', { width: 232, height: 188 }]]);

  it('pushes a card it now covers down below it, and the cards further down along with it', () => {
    expect(pushedByContainer(shown, 'pump', before)).toEqual(
      new Map([
        ['tank', { x: 400, y: 188 + 28 }],
        ['valve', { x: 400, y: 188 + 28 + 44 + 28 }],
      ]),
    );
  });

  it('pushes no card it already covered before the drop, and none for a top-level card', () => {
    const covering = new Map([...shown, ['old', card('old', 100, 100)]]);
    expect(pushedByContainer(covering, 'pump', before).has('old')).toBe(false);
    expect(pushedByContainer(shown, 'tank', before).size).toBe(0);
  });
});

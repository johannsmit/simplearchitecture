import { maxViewLineBends } from '@simplearchitecture/shared';
import { describe, expect, it } from 'vitest';
import {
  bendAt,
  bendsOf,
  endPlace,
  fitEnds,
  followCards,
  handleEnd,
  heldFromStored,
  isRightAngled,
  laidLine,
  moveBend,
  routesToSave,
  squared,
  storedPoints,
  type HeldRoute,
} from '../src/viewing/explorer/canvas/lineRoutes';

// Lines moved by hand in a view: the pure rules, on made-up boxes.

const source = { x: 0, y: 0, width: 168, height: 44 };
const target = { x: 400, y: 200, width: 168, height: 44 };
// Out of the source's right side, across, down, across into the target's left side.
const zigzag = [
  { x: 168, y: 22 },
  { x: 280, y: 22 },
  { x: 280, y: 222 },
  { x: 400, y: 222 },
];
const held: HeldRoute = {
  source: 'a',
  target: 'b',
  points: zigzag,
  sourceBox: source,
  targetBox: target,
};

describe('moving a bend', () => {
  it('a line’s bends are the points between its ends; a straight line has none', () => {
    expect(bendsOf(zigzag)).toEqual([1, 2]);
    expect(bendsOf(zigzag.slice(0, 3))).toEqual([1]);
    expect(bendsOf(zigzag.slice(0, 2))).toEqual([]);
  });

  it('moves the stretches beside the bend with it, and leaves the other bends', () => {
    // Out of the source, across, down, across, down, across into the target.
    const line = [
      { x: 168, y: 22 },
      { x: 220, y: 22 },
      { x: 220, y: 120 },
      { x: 330, y: 120 },
      { x: 330, y: 222 },
      { x: 400, y: 222 },
    ];
    const moved = moveBend(line, 2, { x: 240, y: 140 }, source, target);
    expect(moved).toEqual([
      { x: 168, y: 22 },
      { x: 240, y: 22 },
      { x: 240, y: 140 },
      { x: 330, y: 140 },
      { x: 330, y: 222 },
      { x: 400, y: 222 },
    ]);
    expect(isRightAngled(moved ?? [])).toBe(true);
    // The line given is unchanged.
    expect(line[2]).toEqual({ x: 220, y: 120 });
  });

  it('slides the end next to the bend along its card’s side', () => {
    expect(moveBend(zigzag, 1, { x: 300, y: 30 }, source, target)).toEqual([
      { x: 168, y: 30 },
      { x: 300, y: 30 },
      { x: 300, y: 222 },
      { x: 400, y: 222 },
    ]);
  });

  it('keeps the end 8px clear of its side’s corners, and never on another side', () => {
    // Down past the source's bottom right corner: the bend stops 8px above it.
    expect(moveBend(zigzag, 1, { x: 280, y: 100 }, source, target)).toEqual([
      { x: 168, y: 36 },
      { x: 280, y: 36 },
      { x: 280, y: 222 },
      { x: 400, y: 222 },
    ]);
    expect(moveBend(zigzag, 1, { x: 280, y: -50 }, source, target)?.[0]).toEqual({ x: 168, y: 8 });
    // The bend beside the target: its end stays on the target's left side.
    expect(moveBend(zigzag, 2, { x: 300, y: 400 }, source, target)?.slice(1)).toEqual([
      { x: 300, y: 22 },
      { x: 300, y: 236 },
      { x: 400, y: 236 },
    ]);
  });

  it('stops a bend dragged over its end’s card just beside it; past the card, the end goes to the other side', () => {
    expect(moveBend(zigzag, 1, { x: 100, y: 22 }, source, target)).toEqual([
      { x: 168, y: 22 },
      { x: 176, y: 22 },
      { x: 176, y: 222 },
      { x: 400, y: 222 },
    ]);
    expect(moveBend(zigzag, 1, { x: -60, y: 22 }, source, target)).toEqual([
      { x: 0, y: 22 },
      { x: -60, y: 22 },
      { x: -60, y: 222 },
      { x: 400, y: 222 },
    ]);
  });

  it('moves a line with one corner by that corner: both ends slide', () => {
    const below = { x: 300, y: 200, width: 168, height: 44 };
    const corner = [
      { x: 168, y: 22 },
      { x: 384, y: 22 },
      { x: 384, y: 200 },
    ];
    expect(moveBend(corner, 1, { x: 360, y: 30 }, source, below)).toEqual([
      { x: 168, y: 30 },
      { x: 360, y: 30 },
      { x: 360, y: 200 },
    ]);
    // Past the target's left corner: the bend stops 8px inside it.
    expect(moveBend(corner, 1, { x: 250, y: 30 }, source, below)?.[1]).toEqual({ x: 308, y: 30 });
    // Over its source: just beside it, the target's end sliding with it.
    const under = { x: 100, y: 200, width: 168, height: 44 };
    const short = [
      { x: 168, y: 22 },
      { x: 220, y: 22 },
      { x: 220, y: 200 },
    ];
    expect(moveBend(short, 1, { x: 150, y: 22 }, source, under)).toEqual([
      { x: 168, y: 22 },
      { x: 176, y: 22 },
      { x: 176, y: 200 },
    ]);
  });

  it('slides an end on a Stakeholder along its circle, between its top and bottom', () => {
    // A circle 48 across, centred at x 860, y 214.
    const keeper = { x: 800, y: 190, width: 120, height: 70, circle: true };
    const scheduler = { x: 500, y: 56, width: 168, height: 44 };
    const line = [
      { x: 836, y: 214 },
      { x: 760, y: 214 },
      { x: 760, y: 78 },
      { x: 668, y: 78 },
    ];
    const moved = moveBend(line, 1, { x: 760, y: 224 }, keeper, scheduler);
    expect(moved?.[0]?.y).toBe(224);
    expect(moved?.[0]?.x).toBeCloseTo(860 - Math.sqrt(24 * 24 - 10 * 10), 6);
    const far = moveBend(line, 1, { x: 760, y: 400 }, keeper, scheduler);
    expect(far?.[0]?.y).toBe(230);
    expect(far?.[0]?.x).toBeCloseTo(860 - Math.sqrt(24 * 24 - 16 * 16), 6);
  });

  it('snaps within 6px to the line’s other points; bends that line up merge', () => {
    const line = [
      { x: 168, y: 22 },
      { x: 220, y: 22 },
      { x: 220, y: 120 },
      { x: 330, y: 120 },
      { x: 330, y: 222 },
      { x: 400, y: 222 },
    ];
    expect(moveBend(line, 2, { x: 326, y: 124 }, source, target)).toEqual([
      { x: 168, y: 22 },
      { x: 326, y: 22 },
      { x: 326, y: 124 },
      { x: 330, y: 124 },
      { x: 330, y: 222 },
      { x: 400, y: 222 },
    ]);
    // With snapping: x lines up with the bend at 330, and the line becomes a Z.
    expect(moveBend(line, 2, { x: 326, y: 124 }, source, target, 6)).toEqual(
      zigzag.map((point, index) => (index === 1 || index === 2 ? { ...point, x: 330 } : point)),
    );
    // Further than 6px: no snap.
    expect(moveBend(line, 2, { x: 323, y: 124 }, source, target, 6)?.[1]).toEqual({
      x: 323,
      y: 22,
    });
  });

  it('snaps to the middle of an end’s card, so the end leaves from the middle of its side', () => {
    const low = [
      { x: 168, y: 22 },
      { x: 280, y: 22 },
      { x: 280, y: 210 },
      { x: 400, y: 210 },
    ];
    expect(moveBend(low, 2, { x: 280, y: 218 }, source, target, 6)?.slice(2)).toEqual([
      { x: 280, y: 222 },
      { x: 400, y: 222 },
    ]);
  });

  it('a Z-shaped line whose middle bends line up becomes straight', () => {
    const beside = { x: 400, y: 10, width: 168, height: 44 };
    const z = [
      { x: 168, y: 22 },
      { x: 280, y: 22 },
      { x: 280, y: 40 },
      { x: 400, y: 40 },
    ];
    expect(moveBend(z, 2, { x: 280, y: 24 }, source, beside, 6)).toEqual([
      { x: 168, y: 22 },
      { x: 400, y: 22 },
    ]);
  });

  it('a straight line has no bend to move', () => {
    expect(moveBend(zigzag.slice(0, 2), 1, { x: 200, y: 100 }, source, target)).toBeUndefined();
    expect(moveBend(zigzag, 0, { x: 200, y: 100 }, source, target)).toBeUndefined();
  });

  it('squares a line that is nearly right-angled, keeping both ends', () => {
    const line = [
      { x: 168, y: 22 },
      { x: 280.0004, y: 22.0003 },
      { x: 279.9998, y: 222 },
      { x: 400, y: 222.0002 },
    ];
    const square = squared(line);
    expect(isRightAngled(square)).toBe(true);
    expect(square[0]).toEqual({ x: 168, y: 22 });
    expect(square[3]).toEqual({ x: 400, y: 222.0002 });
  });
});

describe('a held route as its cards move', () => {
  it('stays as it is while neither card moved', () => {
    expect(followCards(held, source, target)).toEqual(zigzag);
  });

  it('keeps the moved stretch, and only the stretch at the moved end follows the card', () => {
    // The target moves 30 down and 40 right: its end goes with it, and so does the stretch into
    // it (down); the upright stretch in the middle stays where it was put, and grows.
    const moved = followCards(held, source, { ...target, x: 440, y: 230 });
    expect(moved).toEqual([
      { x: 168, y: 22 },
      { x: 280, y: 22 },
      { x: 280, y: 252 },
      { x: 440, y: 252 },
    ]);
    // The source moves up: the stretch out of it goes up with it.
    expect(followCards(held, { ...source, y: -50 }, target)).toEqual([
      { x: 168, y: -28 },
      { x: 280, y: -28 },
      { x: 280, y: 222 },
      { x: 400, y: 222 },
    ]);
  });

  it('keeps an end on its side when the card is resized', () => {
    const moved = followCards(held, { ...source, width: 240, height: 66 }, target);
    expect(moved?.[0]).toEqual({ x: 240, y: 33 });
    expect(moved?.[1]).toEqual({ x: 280, y: 33 });
  });

  it('follows both ends of a line with one bend', () => {
    const corner: HeldRoute = {
      ...held,
      points: [
        { x: 168, y: 22 },
        { x: 484, y: 22 },
        { x: 484, y: 200 },
      ],
    };
    expect(followCards(corner, { ...source, y: 10 }, { ...target, x: 420, y: 260 })).toEqual([
      { x: 168, y: 32 },
      { x: 504, y: 32 },
      { x: 504, y: 260 },
    ]);
  });

  it('gives up on a straight line whose cards no longer line up', () => {
    const straight: HeldRoute = {
      ...held,
      points: [
        { x: 168, y: 22 },
        { x: 400, y: 22 },
      ],
      targetBox: { ...target, y: 0 },
    };
    expect(followCards(straight, source, { ...target, y: 0, x: 500 })).toEqual([
      { x: 168, y: 22 },
      { x: 500, y: 22 },
    ]);
    expect(followCards(straight, source, { ...target, y: 40 })).toBeUndefined();
  });
});

describe("a line's ends leave their cards outward, so the arrowheads show", () => {
  it('pushes a stretch dragged over the target out beside it, where the end comes in', () => {
    // The upright stretch was dragged over the target: the line came down into its top and ran
    // back out of its left side, with the arrowhead under the card.
    const over: HeldRoute = {
      ...held,
      points: [
        { x: 168, y: 22 },
        { x: 480, y: 22 },
        { x: 480, y: 222 },
        { x: 400, y: 222 },
      ],
    };
    expect(followCards(over, source, target)).toEqual([
      { x: 168, y: 22 },
      { x: 392, y: 22 },
      { x: 392, y: 222 },
      { x: 400, y: 222 },
    ]);
  });

  it('puts the end on the far side when the stretch was dragged past the card', () => {
    expect(
      fitEnds(
        [
          { x: 168, y: 22 },
          { x: 600, y: 22 },
          { x: 600, y: 222 },
          { x: 400, y: 222 },
        ],
        source,
        target,
      ),
    ).toEqual([
      { x: 168, y: 22 },
      { x: 600, y: 22 },
      { x: 600, y: 222 },
      { x: 568, y: 222 },
    ]);
  });

  it('keeps the ends outward when either card moves under a bend', () => {
    // The target moves left, under the upright stretch.
    expect(followCards(held, source, { ...target, x: 200 })).toEqual([
      { x: 168, y: 22 },
      { x: 192, y: 22 },
      { x: 192, y: 222 },
      { x: 200, y: 222 },
    ]);
    // The source moves right, under it.
    expect(followCards(held, { ...source, x: 200 }, target)).toEqual([
      { x: 368, y: 22 },
      { x: 376, y: 22 },
      { x: 376, y: 222 },
      { x: 400, y: 222 },
    ]);
  });

  it('keeps the source end outward too, for a two-way arrow or a Contains diamond', () => {
    expect(
      fitEnds(
        [
          { x: 168, y: 22 },
          { x: 100, y: 22 },
          { x: 100, y: 222 },
          { x: 400, y: 222 },
        ],
        source,
        target,
      ),
    ).toEqual([
      { x: 168, y: 22 },
      { x: 176, y: 22 },
      { x: 176, y: 222 },
      { x: 400, y: 222 },
    ]);
  });

  it('gives an end at least 8px straight out of its card', () => {
    const short = [
      { x: 84, y: 44 },
      { x: 84, y: 47 },
      { x: 484, y: 47 },
      { x: 484, y: 200 },
    ];
    expect(fitEnds(short, source, target)).toEqual([
      { x: 84, y: 44 },
      { x: 84, y: 52 },
      { x: 484, y: 52 },
      { x: 484, y: 200 },
    ]);
  });

  it('leaves a line that already fits as it is, and a straight one between facing cards', () => {
    expect(fitEnds(zigzag, source, target)).toEqual(zigzag);
    const facing = { ...target, y: 0 };
    const straight = [
      { x: 168, y: 22 },
      { x: 400, y: 22 },
    ];
    expect(fitEnds(straight, source, facing)).toEqual(straight);
  });

  it('fits an end on a Stakeholder against its circle, not its box', () => {
    // A circle 48 across at the top middle of a 120 by 70 box: centre 60, 24; right edge at x 84.
    const person = { x: 0, y: 0, width: 120, height: 70, circle: true };
    const out = [
      { x: 84, y: 24 },
      { x: 100, y: 24 },
      { x: 100, y: 222 },
      { x: 400, y: 222 },
    ];
    // Inside the box but clear of the circle: as it is.
    expect(fitEnds(out, person, target)).toEqual(out);
    // A bend over the circle: pushed 8px beside it, the end stays on the circle.
    const over = out.map((point, index) =>
      index === 1 || index === 2 ? { ...point, x: 70 } : point,
    );
    expect(fitEnds(over, person, target)?.slice(0, 2)).toEqual([
      { x: 84, y: 24 },
      { x: 92, y: 24 },
    ]);
    // Past the circle's far side: the end goes round to that side of the circle.
    const past = out.map((point, index) =>
      index === 1 || index === 2 ? { ...point, x: 20 } : point,
    );
    expect(fitEnds(past, person, target)?.[0]).toEqual({ x: 36, y: 24 });
    // Off the middle, where the circle is narrower: still on the circle.
    const low = { x: 60 + Math.sqrt(24 * 24 - 12 * 12), y: 36 };
    const offMiddle = [low, { x: 100, y: 36 }, { x: 100, y: 222 }, { x: 400, y: 222 }];
    expect(fitEnds(offMiddle, person, target)).toEqual(offMiddle);
    // An end up or down from the circle (no automatic line does that): left where it is.
    const down = [
      { x: 60, y: 48 },
      { x: 60, y: 120 },
      { x: 400, y: 120 },
      { x: 400, y: 200 },
    ];
    expect(fitEnds(down, person, target)).toEqual(down);
  });

  it('gives up on a line it cannot fit: drawn automatically', () => {
    // One bend, over the target, coming out of its bottom: it is the source's bend too.
    expect(
      fitEnds(
        [
          { x: 168, y: 22 },
          { x: 480, y: 22 },
          { x: 480, y: 44 },
        ],
        source,
        { ...target, x: 440, y: 0 },
      ),
    ).toBeUndefined();
    // One stretch between two cards too close for it to clear both.
    expect(
      fitEnds(
        [
          { x: 168, y: 22 },
          { x: 180, y: 22 },
          { x: 180, y: 222 },
          { x: 100, y: 222 },
        ],
        source,
        { ...target, x: 100 },
      ),
    ).toBeUndefined();
  });
});

describe('stored routes', () => {
  it('are held when both ends are on their cards and every stretch is straight', () => {
    expect(heldFromStored(zigzag, { source: 'a', target: 'b' }, source, target)).toEqual(held);
    // An end off its card (the card was placed afresh): drawn automatically.
    expect(
      heldFromStored(zigzag, { source: 'a', target: 'b' }, source, { ...target, x: 700 }),
    ).toBeUndefined();
    expect(
      heldFromStored(
        [
          { x: 168, y: 22 },
          { x: 400, y: 222 },
        ],
        { source: 'a', target: 'b' },
        source,
        target,
      ),
    ).toBeUndefined();
    expect(heldFromStored(zigzag, { source: 'a', target: 'b' }, undefined, target)).toBeUndefined();
  });

  it('are saved to a tenth of a pixel, right-angled, with no extra points', () => {
    expect(
      storedPoints([
        { x: 168, y: 22.04 },
        { x: 250.123, y: 22.04 },
        { x: 250.123, y: 100 },
        { x: 250.123, y: 222 },
        { x: 400, y: 222 },
      ]),
    ).toEqual([
      { x: 168, y: 22 },
      { x: 250.1, y: 22 },
      { x: 250.1, y: 222 },
      { x: 400, y: 222 },
    ]);
    const tooMany = Array.from({ length: maxViewLineBends + 3 }, (_, index) => ({
      x: Math.ceil(index / 2) * 10,
      y: Math.floor(index / 2) * 10,
    }));
    expect(storedPoints(tooMany)).toBeUndefined();
    expect(storedPoints(tooMany.slice(0, maxViewLineBends + 2))).toHaveLength(maxViewLineBends + 2);
  });

  it('save the held routes as drawn now, leaving out a line with other ends or a card gone', () => {
    const boxes = new Map([
      ['a', source],
      ['b', { ...target, y: 230 }],
      ['c', { x: 0, y: 400, width: 168, height: 44 }],
    ]);
    const routes = new Map<string, HeldRoute>([
      ['r1', held],
      ['r2', { ...held, target: 'c' }],
      ['r3', held],
      ['r4', { ...held, source: 'gone' }],
    ]);
    const ends = new Map([
      ['r1', { source: 'a', target: 'b' }],
      // Reversed since: its route ran the other way.
      ['r2', { source: 'c', target: 'a' }],
      ['r4', { source: 'gone', target: 'b' }],
    ]);
    expect(routesToSave(routes, ends, boxes)).toEqual([
      {
        relationshipId: 'r1',
        points: [
          { x: 168, y: 22 },
          { x: 280, y: 22 },
          { x: 280, y: 252 },
          { x: 400, y: 252 },
        ],
      },
    ]);
  });
});

describe('a line from the automatic layout, moved by hand', () => {
  // As the automatic layout draws a line: coordinates with rounding noise, the ends
  // on the cards' edges as laid out.
  const from = { x: 78.4999912780347, y: 0.999998482875064, width: 120, height: 70 };
  const to = { x: 269.000051177414, y: 178.49996732068794, width: 168, height: 44 };
  const laidOut = [
    { x: 198.4999912780347, y: 35.999998482875064 },
    { x: 254.4999912780347, y: 35.999998482875064 },
    { x: 254.4999912780347, y: 92 },
    { x: 353.000051177414, y: 92 },
    { x: 353.000051177414, y: 178.49996732068794 },
  ];

  it('saves right-angled to a tenth of a pixel, and opens again with the same route', () => {
    // Its second bend dragged right.
    const dragged = moveBend(laidOut, 2, { x: 254.4999912780347 + 40.26, y: 92 }, from, to);
    const saved = dragged && storedPoints(dragged);
    expect(saved).toEqual([
      { x: 198.5, y: 36 },
      { x: 294.8, y: 36 },
      { x: 294.8, y: 92 },
      { x: 353, y: 92 },
      { x: 353, y: 178.5 },
    ]);
    expect(saved && isRightAngled(saved)).toBe(true);
    // Opened again with the cards where they were saved: held, and drawn as saved.
    const again = saved && heldFromStored(saved, { source: 'a', target: 'b' }, from, to);
    expect(again).toBeDefined();
    expect(again && followCards(again, from, to)).toEqual(saved);
  });
});

describe('where an end sits', () => {
  it('names the side and the offset along it', () => {
    expect(endPlace({ x: 168, y: 22 }, source)).toEqual({ side: 'right', offset: 22 });
    expect(endPlace({ x: 0, y: 10 }, source)).toEqual({ side: 'left', offset: 10 });
    expect(endPlace({ x: 484, y: 200 }, target)).toEqual({ side: 'top', offset: 84 });
    expect(endPlace({ x: 420, y: 244 }, target)).toEqual({ side: 'bottom', offset: 20 });
    expect(endPlace({ x: 84, y: 22 }, source)).toBeUndefined();
  });
});

describe('which bend a press grabs', () => {
  // Another line whose bend lies 4px from the zigzag's first bend.
  const beside = [
    { x: 168, y: 26 },
    { x: 284, y: 26 },
    { x: 284, y: 230 },
    { x: 400, y: 230 },
  ];
  const lines = new Map([
    ['zig', zigzag],
    ['beside', beside],
  ]);

  it('takes the bend nearest the pointer, among the lines whose bends show', () => {
    expect(bendAt(lines, { x: 281, y: 23 })).toEqual({ id: 'zig', index: 1 });
    expect(bendAt(lines, { x: 283, y: 25 })).toEqual({ id: 'beside', index: 1 });
    expect(bendAt(lines, { x: 279, y: 221 })).toEqual({ id: 'zig', index: 2 });
  });

  it('grabs nothing on a straight line', () => {
    expect(
      bendAt(
        new Map([
          [
            'straight',
            [
              { x: 168, y: 22 },
              { x: 400, y: 22 },
            ],
          ],
        ]),
        { x: 200, y: 22 },
      ),
    ).toBeUndefined();
  });
});

describe('lines on the layout’s route', () => {
  const handles = [
    { id: 'l0:s', kind: 'source' as const, side: 'bottom' as const, offset: 60 },
    { id: 'l1:t', kind: 'target' as const, side: 'left' as const, offset: 30 },
    { id: 'l2:s', kind: 'source' as const, side: 'right' as const, offset: 10 },
  ];
  const box = { x: 100, y: 50, width: 168, height: 44 };

  it('puts a handle on its card’s side, or on a Stakeholder’s circle', () => {
    expect(handleEnd(handles, 'l0:s', box)).toEqual({ x: 160, y: 94, side: 'bottom' });
    expect(handleEnd(handles, 'l1:t', box)).toEqual({ x: 100, y: 80, side: 'left' });
    expect(handleEnd(handles, 'l2:s', box)).toEqual({ x: 268, y: 60, side: 'right' });
    expect(handleEnd(handles, 'l9:s', box)).toBeUndefined();
    // On a circle (48px, centred at the top of its 120px box), a bottom port goes to the side of
    // the circle, as the card draws it.
    const end = handleEnd(handles, 'l0:s', { ...box, width: 120, height: 80, circle: true });
    expect(end?.side).toBe('right');
    expect(end?.x).toBeGreaterThan(160);
    expect(Math.hypot((end?.x ?? 0) - 160, (end?.y ?? 0) - 74)).toBeCloseTo(24, 5);
  });

  it('draws the line from handle to handle through the bends', () => {
    const top = { x: 0, y: 0, width: 168, height: 44 };
    const below = { x: 0, y: 200, width: 168, height: 44 };
    const line = laidLine(
      [
        { x: 84, y: 100 },
        { x: 40, y: 100 },
      ],
      {
        handles: [{ id: 'l0:s', kind: 'source', side: 'bottom', offset: 84 }],
        box: top,
        port: 'l0:s',
      },
      {
        handles: [{ id: 'l0:t', kind: 'target', side: 'top', offset: 40 }],
        box: below,
        port: 'l0:t',
      },
    );
    expect(line).toEqual([
      { x: 84, y: 44 },
      { x: 84, y: 100 },
      { x: 40, y: 100 },
      { x: 40, y: 200 },
    ]);
  });
});

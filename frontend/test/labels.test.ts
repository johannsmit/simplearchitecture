import { describe, expect, it } from 'vitest';
import {
  cardTopReach,
  labelHeight,
  labelHeightOf,
  labelLineHeight,
  labelMaxWidth,
  labelWidth,
  placeLabel,
  placeRestingLabel,
  placeStateMark,
  pointOnLine,
  restingLabelMaxWidth,
  stateMarkSize,
} from '../src/viewing/explorer/canvas/labels';
import { isGrayed, linkText } from '../src/viewing/explorer/canvas/view';

// A straight line from (0,0) to (400,0): the point at t is (400 t, 0).
const straight = [
  { x: 0, y: 0 },
  { x: 400, y: 0 },
];
const box = (x: number, y = -20, width = 20, height = 40) => ({ x, y, width, height });

describe('edge label placement', () => {
  it('finds points along a right-angled line by its length', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 300 },
    ];
    expect(pointOnLine(line, 0)).toEqual({ x: 0, y: 0 });
    expect(pointOnLine(line, 0.25)).toEqual({ x: 100, y: 0 });
    expect(pointOnLine(line, 0.5)).toEqual({ x: 100, y: 100 });
    expect(pointOnLine(line, 1)).toEqual({ x: 100, y: 300 });
    expect(pointOnLine([], 0.5)).toBeUndefined();
  });

  it('puts the label at 50% when that covers no card', () => {
    expect(placeLabel(straight, 40, [])).toEqual({ x: 200, y: 0 });
  });

  it('tries 30%, then 70%, then hides the label', () => {
    const at = (cards: ReturnType<typeof box>[]) => placeLabel(straight, 40, cards);
    expect(at([box(190)])?.x).toBeCloseTo(120);
    expect(at([box(190), box(110)])?.x).toBeCloseTo(280);
    expect(at([box(190), box(110), box(270)])).toBeUndefined();
  });

  it('counts a 4px margin around the label as covering', () => {
    // The label spans 180–220 at 50%; with the margin 176–224.
    expect(placeLabel(straight, 40, [box(223, -20, 10)])?.x).toBeCloseTo(120);
    expect(placeLabel(straight, 40, [box(225, -20, 10)])).toEqual({ x: 200, y: 0 });
    // Above and below: the label is 18px high, so 9 + 4 = 13px from the line. A card counts
    // 10px taller at the top (its state badge and pill), so one below must start 23px down.
    expect(placeLabel(straight, 40, [box(190, 24, 20)])).toEqual({ x: 200, y: 0 });
    expect(placeLabel(straight, 40, [box(190, 22, 20)])?.x).toBeCloseTo(120);
    // A card above only reaches the label with its bottom edge, which doesn't grow.
    expect(placeLabel(straight, 40, [box(190, -53, 20, 40)])).toEqual({ x: 200, y: 0 });
    expect(placeLabel(straight, 40, [box(190, -52, 20, 40)])?.x).toBeCloseTo(120);
    expect(cardTopReach).toBe(10);
    expect(labelHeight).toBe(18);
  });

  it('cuts long labels at 88px', () => {
    expect(labelWidth('×3')).toBeLessThan(labelMaxWidth);
    expect(labelWidth('A very long relationship label that goes on and on')).toBe(88);
  });
});

describe('edge state marks', () => {
  it('places a 14px mark like a label: 50%, then 30%, then 70%, else nowhere', () => {
    expect(stateMarkSize).toBe(14);
    expect(placeStateMark(straight, [])).toEqual({ x: 200, y: 0 });
    // A card on the middle: the mark moves to 30%.
    expect(placeStateMark(straight, [box(190)])?.x).toBeCloseTo(120);
    // Cards on all three spots: no mark (the line weight still shows the state).
    expect(placeStateMark(straight, [box(190), box(110), box(270)])).toBeUndefined();
  });

  it('makes room for the mark in a lit label, within the 88px cut', () => {
    expect(labelWidth('API', true)).toBe(labelWidth('API') + 16);
    expect(labelWidth('A very long relationship label indeed', true)).toBe(labelMaxWidth);
  });
});

describe('a label that is always visible', () => {
  const box = (x: number, y: number, width = 100, height = 40) => ({ x, y, width, height });
  const long = 'A label long enough to be cut well before the end of it';

  it('takes its full width where that covers no card', () => {
    const at = placeRestingLabel(straight, long, false, []);
    expect(at).toMatchObject({ x: 200, y: 0, width: restingLabelMaxWidth });
  });

  it('narrows to the column gap before it covers a card', () => {
    // 140px wide reaches 130–270 at 50%; 88px reaches 156–244. The cards leave only the narrow one.
    const cards = [box(40, -20, 100), box(260, -20, 100)];
    const at = placeRestingLabel(straight, long, false, cards);
    expect(at).toMatchObject({ x: 200, y: 0, width: labelMaxWidth });
  });

  it('falls back to the line’s middle when every spot covers a card', () => {
    const covering = [box(-20, -50, 500, 100)];
    expect(placeLabel(straight, 40, covering)).toBeUndefined();
    expect(placeRestingLabel(straight, long, false, covering)).toEqual({
      x: 200,
      y: 0,
      width: labelMaxWidth,
    });
  });

  it('leaves room for the state mark, and has no place on a path that isn’t a curve', () => {
    expect(placeRestingLabel(straight, 'Ab', true, [])?.width).toBe(labelWidth('Ab', true));
    expect(placeRestingLabel([], 'Ab', false, [])).toBeUndefined();
  });

  it('measures a label of two lines (Data) by its widest line and both lines’ height', () => {
    const two = 'Req: A\nResp: Order numbers';
    expect(labelWidth(two, false, 500)).toBe(labelWidth('Resp: Order numbers', false, 500));
    expect(labelHeightOf('One line')).toBe(labelHeight);
    expect(labelHeightOf(two)).toBe(labelHeight + labelLineHeight);
  });

  it('keeps the extra line clear of a card just below the line', () => {
    // A card under the middle, its top (with the badge's reach) 15px below the line: a one-line
    // label (13px down with its margin) fits at 50%, a two-line one (20px down) moves along.
    const under = [box(150, 15 + cardTopReach, 100, 40)];
    expect(placeRestingLabel(straight, 'Req: A', false, under)).toMatchObject({ x: 200, y: 0 });
    const two = placeRestingLabel(straight, 'Req: A\nResp: B', false, under);
    expect(two?.x).not.toBe(200);
    if (two === undefined) throw new Error('not placed');
    const height = labelHeightOf('Req: A\nResp: B') + 8;
    const covers = under.some(
      (card) =>
        two.x - two.width / 2 - 4 < card.x + card.width &&
        card.x < two.x + two.width / 2 + 4 &&
        two.y + height / 2 > card.y - cardTopReach,
    );
    expect(covers).toBe(false);
  });
});

describe('what a line says at rest', () => {
  const link = {
    id: 'l0',
    source: 'a',
    target: 'b',
    type: 'Relation',
    state: 'Current',
  } as const;
  const member = (metadata: Record<string, unknown>) => ({
    id: 'r',
    source: 'a',
    target: 'b',
    type: 'Relation' as const,
    architectureState: 'Current' as const,
    metadata,
  });
  const base = {
    ...link,
    relationshipIds: ['r'],
    twoWay: false,
    informationFlow: false,
    members: [member({})],
  };

  it('a line shows its label or "×N", and otherwise nothing: never its type', () => {
    expect(linkText({ ...base, count: 1 })).toBe('');
    expect(linkText({ ...base, count: 1, label: 'Orders' })).toBe('Orders');
    expect(linkText({ ...base, count: 3 })).toBe('×3');
  });

  it('selected properties replace the label, and a line without them is grayed out', () => {
    const line = {
      ...base,
      count: 1,
      label: 'Orders',
      members: [member({ protocol: 'REST', auth: 'OAuth', empty: ' ', list: ['a'] })],
    };
    expect(linkText(line, ['protocol'])).toBe('REST');
    expect(linkText(line, ['auth', 'protocol'])).toBe('OAuth · REST');
    expect(isGrayed(line, ['protocol'])).toBe(false);
    // One of several is enough; the missing one adds nothing.
    expect(linkText(line, ['protocol', 'other'])).toBe('REST');
    expect(isGrayed(line, ['protocol', 'other'])).toBe(false);
    // Without any: no text, not even the label. An empty text or a list doesn't count.
    expect(linkText(line, ['other'])).toBe('');
    for (const keys of [['other'], ['empty'], ['list']]) expect(isGrayed(line, keys)).toBe(true);
    // Nothing selected: nothing is grayed out.
    expect(isGrayed(line, [])).toBe(false);
    // Every relationship has an Architecture state: none means Current.
    expect(linkText({ ...line }, ['architectureState'])).toBe('Current');
    expect(isGrayed(line, ['architectureState'])).toBe(false);
  });

  it('merged lines say how many, and are grayed out only if none has the property', () => {
    const merged = { ...base, count: 2, members: [member({}), member({ protocol: 'REST' })] };
    expect(linkText(merged, ['protocol'])).toBe('×2');
    expect(isGrayed(merged, ['protocol'])).toBe(false);
    expect(isGrayed(merged, ['other'])).toBe(true);
  });

  it('never applies a selection to Contains', () => {
    const contains = { ...base, type: 'Contains' as const, count: 1, label: 'Part of' };
    expect(linkText(contains, ['protocol'])).toBe('Part of');
    expect(isGrayed(contains, ['protocol'])).toBe(false);
  });
});

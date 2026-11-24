import {
  maxViewCardCoordinate,
  maxViewLineBends,
  type ViewLineRoute,
} from '@simplearchitecture/shared';
import { circleDiameter, circleHandles, circleNodeWidth } from './circle';
import { edgeLine, simplified, type LineEnd } from './edgeLine';
import type { PlacedHandle, Side } from './elkLayout';
import type { Box, Point } from './positions';

/**
 * Lines moved by hand in a view: dragging one of a line's bends, and keeping that route as its
 * cards move. A line is its points on the canvas, from the source's end to the
 * target's end, each stretch straight across or straight up and down. Pure, so it is tested
 * without a browser.
 */

/** A line's route given by hand, with where its two cards were then. */
export interface HeldRoute {
  /** The relationship's ends then: once it has other ends, the route no longer applies. */
  source: string;
  target: string;
  points: readonly Point[];
  sourceBox: Box;
  targetBox: Box;
}

/** A card as a line's end sees it: a Stakeholder's lines end on its circle, not its box. */
export type EndCard = Box & { circle?: boolean };

/** How far a stored end may be from its card's box and still count as on it. */
const endTolerance = 2;
/**
 * How far a line runs out of a card before it turns, at the least (as an automatic line does), so
 * the arrowhead or diamond at that end is drawn outside the card. Checked with half a pixel to
 * spare, as stored points are rounded.
 */
const endRoom = 8;
const roomSpare = 0.5;

/** A stretch that runs across (rather than up and down). */
export const isLevel = (a: Point, b: Point): boolean => Math.abs(a.y - b.y) <= Math.abs(a.x - b.x);

/**
 * The line with exact right angles: each stretch shares x or y with the one before, whichever it
 * nearly does. The first point stays; the last stays too, and the bend before it lines up with it.
 */
export function squared(line: readonly Point[]): Point[] {
  const points = line.map((point) => ({ ...point }));
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1] as Point;
    const b = points[index] as Point;
    const last = index === points.length - 1;
    if (isLevel(a, b)) {
      if (last) a.y = b.y;
      else b.y = a.y;
    } else if (last) a.x = b.x;
    else b.x = a.x;
  }
  return points;
}

/** True when each stretch runs straight across or straight up and down. */
export function isRightAngled(line: readonly Point[]): boolean {
  return line.every((point, index) => {
    const before = line[index - 1];
    return before === undefined || before.x === point.x || before.y === point.y;
  });
}

/** A point at the same place relative to a box after the box moved or changed size. */
function carried(point: Point, from: Box, to: Box): Point {
  return {
    x: to.x + (from.width > 0 ? ((point.x - from.x) * to.width) / from.width : point.x - from.x),
    y: to.y + (from.height > 0 ? ((point.y - from.y) * to.height) / from.height : point.y - from.y),
  };
}

const sameBox = (a: Box, b: Box) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * The two places a line's end stretch can come in at a card, along x (across) or y (upright): a
 * box's sides; on a circle, where the circle meets the stretch across at the end's height.
 * Undefined for an end a circle has no such places for (up and down, or above or below it): it is
 * left where it is.
 */
function sidesOf(
  card: EndCard,
  across: boolean,
  end: Point,
): { low: number; high: number } | undefined {
  if (card.circle === true) {
    const radius = circleDiameter / 2;
    const centre = { x: card.x + circleNodeWidth / 2, y: card.y + radius };
    const dy = end.y - centre.y;
    if (!across || Math.abs(dy) >= radius) return undefined;
    const half = Math.sqrt(radius * radius - dy * dy);
    return { low: centre.x - half, high: centre.x + half };
  }
  return across
    ? { low: card.x, high: card.x + card.width }
    : { low: card.y, high: card.y + card.height };
}

/** True when a line leaves its card at `end` outward, on a side, `endRoom` before it turns. */
function leavesOutward(end: Point, next: Point, card: EndCard): boolean {
  const across = isLevel(end, next);
  const sides = sidesOf(card, across, end);
  if (!sides) return true;
  const { low, high } = sides;
  const at = across ? end.x : end.y;
  const to = across ? next.x : next.y;
  const room = endRoom - roomSpare;
  return (
    (Math.abs(at - low) <= endTolerance && to <= low - room) ||
    (Math.abs(at - high) <= endTolerance && to >= high + room)
  );
}

/**
 * Puts the end at `line[0]` on the side of its card the line comes from, and pushes the stretch
 * after its first bend out to `endRoom` beside the card when that bend lies over the card. Changes
 * `line`; false when the bend can't move (it is the other end's too).
 */
function fitEnd(line: Point[], card: EndCard): boolean {
  const end = line[0] as Point;
  const next = line[1] as Point;
  const across = isLevel(end, next);
  const key = across ? 'x' : 'y';
  const sides = sidesOf(card, across, end);
  if (!sides) return true;
  const { low, high } = sides;
  const room = endRoom - roomSpare;
  let side: number;
  if (next[key] <= low - room) side = low;
  else if (next[key] >= high + room) side = high;
  else {
    // The bend is over the card: out beside the side the end is nearer, with the stretch after it.
    const after = line[2];
    if (!after || line.length < 4) return false;
    side = Math.abs(end[key] - low) <= Math.abs(end[key] - high) ? low : high;
    next[key] = side === low ? low - endRoom : high + endRoom;
    after[key] = next[key];
  }
  if (Math.abs(end[key] - side) > endTolerance) end[key] = side;
  return true;
}

/**
 * A line moved by hand with each end leaving its card outward, so the arrowhead at the target (and
 * at the source when two-way, or the diamond of a Contains) is drawn outside the card, pointing
 * into it. Where a bend next to an end lies over that end's card (a stretch dragged over it, or
 * the card moved under it), the end goes to the side the line comes from, or the stretch after
 * the bend is pushed out beside the card. Undefined when the line can't be fitted so (too few
 * bends, or cards too close for the one stretch between them): it is drawn automatically.
 */
export function fitEnds(
  line: readonly Point[],
  source: EndCard,
  target: EndCard,
): Point[] | undefined {
  const points = simplified(line.map((point) => ({ ...point })));
  if (points.length < 2) return undefined;
  if (!fitEnd(points, source)) return undefined;
  points.reverse();
  const fitted = fitEnd(points, target);
  points.reverse();
  if (!fitted) return undefined;
  const result = simplified(points);
  const [first, second] = result;
  const [last, beforeLast] = [result.at(-1), result.at(-2)];
  if (!first || !second || !last || !beforeLast) return undefined;
  return leavesOutward(first, second, source) && leavesOutward(last, beforeLast, target)
    ? result
    : undefined;
}

type Axis = 'x' | 'y';

/**
 * How near a dragged bend comes to lining up before it snaps, on the screen (the canvas divides it
 * by the zoom).
 */
export const bendSnap = 6;

/**
 * A line's bends, by their index in the line: every point between its two ends. A straight line
 * has none. The line is taken without repeated points or points in the middle of a stretch.
 */
export function bendsOf(line: readonly Point[]): number[] {
  const result: number[] = [];
  for (let index = 1; index < line.length - 1; index++) result.push(index);
  return result;
}

/** The middle of a card, or of a Stakeholder's circle: where a line leaves the middle of a side. */
function centreOf(card: EndCard): Point {
  return card.circle === true
    ? { x: card.x + circleNodeWidth / 2, y: card.y + circleDiameter / 2 }
    : { x: card.x + card.width / 2, y: card.y + card.height / 2 };
}

/**
 * Where an end may slide along its card's side, along `axis`: `endRoom` clear of the side's
 * corners (on a Stakeholder, of its circle's top and bottom). An end already closer keeps its
 * place, but goes no further. On a circle an end slides only up and down.
 */
function slideRange(card: EndCard, end: Point, axis: Axis): { low: number; high: number } {
  let low: number;
  let high: number;
  if (card.circle === true) {
    if (axis === 'x') return { low: end.x, high: end.x };
    low = card.y + endRoom;
    high = card.y + circleDiameter - endRoom;
  } else {
    low = card[axis] + endRoom;
    high = card[axis] + (axis === 'x' ? card.width : card.height) - endRoom;
  }
  if (low > high) low = high = (low + high) / 2;
  return { low: Math.min(low, end[axis]), high: Math.max(high, end[axis]) };
}

/** The value, or the nearest of `candidates` within `within` of it. */
function snapped(value: number, candidates: readonly number[], within: number): number {
  let best = value;
  let distance = within;
  for (const candidate of candidates) {
    const away = Math.abs(candidate - value);
    if (away <= distance) {
      best = candidate;
      distance = away;
    }
  }
  return best;
}

/**
 * The line with bend `index` dragged to `to`. The stretches either side of the bend move with it,
 * sideways, so the line keeps its right angles; its other bends stay. An end next to the bend
 * slides along its card's side, `endRoom` clear of the corners, and never turns onto another side:
 * past that, the bend stops. The bend first snaps, within `snap`, to the x or y of the line's other
 * points and of its two cards' middles. A bend dragged over the card of an end next to it stops just
 * outside the side the end is on; dragged past the card, the end goes to its other side
 * (`fitEnds`). Bends that line up merge. Undefined when no such line fits: the line stays as it
 * was.
 */
export function moveBend(
  line: readonly Point[],
  index: number,
  to: Point,
  source: EndCard,
  target: EndCard,
  snap = 0,
): Point[] | undefined {
  const points = simplified(squared(line));
  const last = points.length - 1;
  const bend = points[index];
  if (!bend || index < 1 || index >= last) return undefined;
  // The neighbours that move with the bend: up and down on its stretch across, left and right on
  // its stretch up and down.
  const beforeLevel = isLevel(points[index - 1] as Point, bend);
  const along: Record<Axis, number> = {
    x: beforeLevel ? index + 1 : index - 1,
    y: beforeLevel ? index - 1 : index + 1,
  };
  const cardAt = (at: number) => (at === 0 ? source : at === last ? target : undefined);
  const ranges = new Map<number, { axis: Axis; low: number; high: number }>();
  for (const axis of ['x', 'y'] as const) {
    const card = cardAt(along[axis]);
    if (card)
      ranges.set(along[axis], { axis, ...slideRange(card, points[along[axis]] as Point, axis) });
  }
  const middles = [centreOf(source), centreOf(target)];
  const at = { ...to };
  for (const axis of ['x', 'y'] as const) {
    if (snap > 0) {
      const others = points.filter((_, each) => each !== index && each !== along[axis]);
      at[axis] = snapped(
        at[axis],
        [...others, ...middles].map((point) => point[axis]),
        snap,
      );
    }
    const range = ranges.get(along[axis]);
    if (range) at[axis] = Math.min(range.high, Math.max(range.low, at[axis]));
  }
  /** Puts the bend, and the neighbour that moves with it, at `value` along `axis`. */
  const place = (axis: Axis, value: number) => {
    bend[axis] = value;
    const neighbour = points[along[axis]] as Point;
    neighbour[axis] = value;
    const card = cardAt(along[axis]);
    // An end on a circle stays on it as it slides up or down.
    const sides = card && axis === 'y' ? sidesOf(card, true, neighbour) : undefined;
    if (card?.circle === true && sides) {
      neighbour.x = neighbour.x < card.x + circleNodeWidth / 2 ? sides.low : sides.high;
    }
  };
  place('x', at.x);
  place('y', at.y);
  for (const [endIndex, card] of [
    [0, source],
    [last, target],
  ] as const) {
    if (Math.abs(endIndex - index) !== 1) continue;
    const end = points[endIndex] as Point;
    // The end's stretch runs along x when the end moves up and down with the bend.
    const axis: Axis = along.y === endIndex ? 'x' : 'y';
    const sides = sidesOf(card, axis === 'x', end);
    const room = endRoom - roomSpare;
    if (!sides || bend[axis] <= sides.low - room || bend[axis] >= sides.high + room) continue;
    const onLow = Math.abs(end[axis] - sides.low) <= Math.abs(end[axis] - sides.high);
    place(axis, onLow ? sides.low - endRoom : sides.high + endRoom);
  }
  // An end that had to move on with the bend (on a line with one corner) is still on its side.
  for (const [at, range] of ranges) {
    const value = (points[at] as Point)[range.axis];
    if (value < range.low - roomSpare || value > range.high + roomSpare) return undefined;
  }
  return fitEnds(points, source, target);
}

/** How far a point is from a bend. */
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The bend a press grabs: the one nearest the point among the lines given (those whose bends
 * show), as overlapping handles may lie on top of each other. Undefined for lines without bends.
 */
export function bendAt(
  lines: ReadonlyMap<string, readonly Point[]>,
  point: Point,
): { id: string; index: number } | undefined {
  let best: { id: string; index: number; away: number } | undefined;
  for (const [id, line] of lines) {
    const points = simplified(line);
    for (const index of bendsOf(points)) {
      const away = distance(points[index] as Point, point);
      if (!best || away < best.away) best = { id, index, away };
    }
  }
  return best && { id: best.id, index: best.index };
}

/**
 * A held route with its cards where they are now. The stretches the person moved stay; at an end
 * whose card moved, the end goes with the card, and so does the stretch out of it (sideways for a
 * stretch across, up or down for one up and down), the next stretch growing or shrinking to meet
 * it. So the line keeps its right angles. Each end then leaves its card outward (`fitEnds`).
 * Undefined for a straight line whose cards no longer line up (it has no bend to give), or a line
 * that can't be fitted to its cards.
 */
export function followCards(
  held: HeldRoute,
  source: EndCard,
  target: EndCard,
): Point[] | undefined {
  const points = simplified(held.points.map((point) => ({ ...point })));
  const count = points.length;
  if (count < 2) return undefined;
  if (sameBox(held.sourceBox, source) && sameBox(held.targetBox, target)) {
    return fitEnds(points, source, target);
  }
  const first = points[0] as Point;
  const last = points[count - 1] as Point;
  const start = carried(first, held.sourceBox, source);
  const end = carried(last, held.targetBox, target);
  if (count === 2) {
    const level = first.y === last.y;
    return (level ? start.y === end.y : start.x === end.x)
      ? fitEnds([start, end], source, target)
      : undefined;
  }
  const startLevel = isLevel(first, points[1] as Point);
  const endLevel = isLevel(points[count - 2] as Point, last);
  points[0] = start;
  points[count - 1] = end;
  const afterStart = points[1] as Point;
  if (startLevel) afterStart.y = start.y;
  else afterStart.x = start.x;
  const beforeEnd = points[count - 2] as Point;
  if (endLevel) beforeEnd.y = end.y;
  else beforeEnd.x = end.x;
  return fitEnds(points, source, target);
}

/** True when a point lies on a box or within `endTolerance` of it. */
function touches(point: Point, box: Box): boolean {
  return (
    point.x >= box.x - endTolerance &&
    point.x <= box.x + box.width + endTolerance &&
    point.y >= box.y - endTolerance &&
    point.y <= box.y + box.height + endTolerance
  );
}

/**
 * A view's stored route, held for the cards as the canvas first shows them. Undefined when it
 * doesn't fit them: an end isn't on its card (a card placed afresh), or a stretch is slanted.
 * Such a line is drawn automatically.
 */
export function heldFromStored(
  points: readonly Point[],
  ends: { source: string; target: string },
  sourceBox: Box | undefined,
  targetBox: Box | undefined,
): HeldRoute | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (!sourceBox || !targetBox || !first || !last || points.length < 2) return undefined;
  if (!isRightAngled(points) || !touches(first, sourceBox) || !touches(last, targetBox)) {
    return undefined;
  }
  return {
    ...ends,
    points: points.map(({ x, y }) => ({ x, y })),
    sourceBox: { ...sourceBox },
    targetBox: { ...targetBox },
  };
}

const coordinate = (value: number): number =>
  Math.min(maxViewCardCoordinate, Math.max(-maxViewCardCoordinate, Math.round(value * 10) / 10));

/**
 * A line's points as a view stores them: exact right angles, to a tenth of a pixel, without
 * repeated points or points in the middle of a straight stretch. Undefined when there are more
 * bends than a view keeps.
 */
export function storedPoints(line: readonly Point[]): Point[] | undefined {
  const points = simplified(
    squared(line).map((point) => ({ x: coordinate(point.x), y: coordinate(point.y) })),
  );
  if (points.length < 2 || points.length > maxViewLineBends + 2) return undefined;
  return isRightAngled(points) ? points : undefined;
}

/**
 * The routes a view saves, from the routes held and where the cards are now: each relationship
 * still between the same two cards, both on the canvas, gets its route as drawn now. Others
 * (another end, a card gone, a straight line whose cards no longer line up) get none.
 */
export function routesToSave(
  held: ReadonlyMap<string, HeldRoute>,
  relationships: ReadonlyMap<string, { source: string; target: string }>,
  boxes: ReadonlyMap<string, EndCard>,
): ViewLineRoute[] {
  const result: ViewLineRoute[] = [];
  for (const [relationshipId, route] of held) {
    const ends = relationships.get(relationshipId);
    if (ends?.source !== route.source || ends.target !== route.target) continue;
    const source = boxes.get(route.source);
    const target = boxes.get(route.target);
    if (!source || !target) continue;
    const now = followCards(route, source, target);
    const points = now && storedPoints(now);
    if (points) result.push({ relationshipId, points });
  }
  return result;
}

/**
 * Where a line meets its card at a handle the layout placed: on the card's side, `offset` along
 * it, or on a Stakeholder's circle, where the card draws it (`circleHandles`). Undefined for a
 * handle the card doesn't have.
 */
export function handleEnd(
  handles: readonly PlacedHandle[],
  id: string,
  card: EndCard,
): LineEnd | undefined {
  if (card.circle === true) {
    const handle = circleHandles(handles).find((each) => each.id === id);
    return handle && { x: card.x + handle.x, y: card.y + handle.y, side: handle.side };
  }
  const handle = handles.find((each) => each.id === id);
  if (!handle) return undefined;
  const { side, offset } = handle;
  if (side === 'left' || side === 'right') {
    return { x: side === 'left' ? card.x : card.x + card.width, y: card.y + offset, side };
  }
  return { x: card.x + offset, y: side === 'top' ? card.y : card.y + card.height, side };
}

/**
 * A line on the layout's route, as the canvas draws it: from its source's handle, through the
 * layout's bends, to its target's handle.
 */
export function laidLine(
  bends: readonly Point[],
  source: { handles: readonly PlacedHandle[]; box: EndCard; port: string },
  target: { handles: readonly PlacedHandle[]; box: EndCard; port: string },
): Point[] | undefined {
  const start = handleEnd(source.handles, source.port, source.box);
  const end = handleEnd(target.handles, target.port, target.box);
  return start && end ? edgeLine(start, end, bends) : undefined;
}

/**
 * The side of a box a line's end is on, and how far along it: the ends of lines moved by hand
 * keep their places, and automatic lines keep clear of them. Undefined when it is on no side.
 */
export function endPlace(point: Point, box: Box): { side: Side; offset: number } | undefined {
  const near = (a: number, b: number) => Math.abs(a - b) <= endTolerance;
  if (near(point.x, box.x)) return { side: 'left', offset: point.y - box.y };
  if (near(point.x, box.x + box.width)) return { side: 'right', offset: point.y - box.y };
  if (near(point.y, box.y)) return { side: 'top', offset: point.x - box.x };
  if (near(point.y, box.y + box.height)) return { side: 'bottom', offset: point.x - box.x };
  return undefined;
}

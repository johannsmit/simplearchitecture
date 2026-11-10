import {
  maxViewCardCoordinate,
  maxViewLineBends,
  type ViewLineRoute,
} from '@simplearchitecture/shared';
import { simplified } from './edgeLine';
import type { Side } from './elkLayout';
import type { Box, Point } from './positions';

/**
 * Lines moved by hand in a view: dragging one of a line's middle stretches sideways, and keeping
 * that route as its cards move. A line is its points on the canvas, from the source's end to the
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

/** How far a stored end may be from its card's box and still count as on it. */
const endTolerance = 2;

/** A stretch that runs across (rather than up and down). */
export const isLevel = (a: Point, b: Point): boolean => Math.abs(a.y - b.y) <= Math.abs(a.x - b.x);

/**
 * The stretches of a line that can be dragged, by the index of their first point: every one but
 * the first and the last, which stay on their cards.
 */
export function middleStretches(line: readonly Point[]): number[] {
  const result: number[] = [];
  for (let index = 1; index <= line.length - 3; index++) result.push(index);
  return result;
}

/**
 * The line with one middle stretch moved sideways by `by`: a stretch across moves up or down, one
 * up and down moves left or right. The stretches either side of it grow or shrink, so the line
 * keeps its right angles; its other points stay.
 */
export function moveStretch(line: readonly Point[], index: number, by: Point): Point[] {
  const points = line.map((point) => ({ ...point }));
  const a = points[index];
  const b = points[index + 1];
  if (!a || !b || index < 1 || index > line.length - 3) return points;
  if (isLevel(a, b)) {
    a.y += by.y;
    b.y += by.y;
  } else {
    a.x += by.x;
    b.x += by.x;
  }
  return points;
}

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
 * A held route with its cards where they are now. The stretches the person moved stay; at an end
 * whose card moved, the end goes with the card, and so does the stretch out of it (sideways for a
 * stretch across, up or down for one up and down), the next stretch growing or shrinking to meet
 * it. So the line keeps its right angles. Undefined for a straight line whose cards no longer
 * line up: it has no bend to give.
 */
export function followCards(held: HeldRoute, source: Box, target: Box): Point[] | undefined {
  const points = held.points.map((point) => ({ ...point }));
  const count = points.length;
  if (count < 2) return undefined;
  if (sameBox(held.sourceBox, source) && sameBox(held.targetBox, target)) return points;
  const first = points[0] as Point;
  const last = points[count - 1] as Point;
  const start = carried(first, held.sourceBox, source);
  const end = carried(last, held.targetBox, target);
  if (count === 2) {
    const level = first.y === last.y;
    return (level ? start.y === end.y : start.x === end.x) ? [start, end] : undefined;
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
  return points;
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
  boxes: ReadonlyMap<string, Box>,
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

/** How far a point is from a stretch of a line. */
function distanceTo(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** The stretch of a line nearest a point, by the index of its first point, and how far it is. */
function nearestStretch(
  line: readonly Point[],
  point: Point,
  only?: readonly number[],
): { index: number; distance: number } | undefined {
  let best: { index: number; distance: number } | undefined;
  for (let index = 0; index < line.length - 1; index++) {
    if (only && !only.includes(index)) continue;
    const distance = distanceTo(point, line[index] as Point, line[index + 1] as Point);
    if (!best || distance < best.distance) best = { index, distance };
  }
  return best;
}

/**
 * The middle stretch a press on the canvas grabs: that of the line nearest the point, among all the
 * lines drawn, as a click there opens the nearest line. Undefined when the nearest line's nearest
 * stretch is its first or last (attached to a card), so nothing moves.
 */
export function stretchAt(
  lines: ReadonlyMap<string, readonly Point[]>,
  point: Point,
): { id: string; index: number } | undefined {
  let best: { id: string; index: number; distance: number } | undefined;
  for (const [id, line] of lines) {
    const found = nearestStretch(line, point);
    if (found && (!best || found.distance < best.distance)) best = { id, ...found };
  }
  if (!best) return undefined;
  const line = lines.get(best.id) as readonly Point[];
  return middleStretches(line).includes(best.index)
    ? { id: best.id, index: best.index }
    : undefined;
}

/**
 * The middle stretch of a line nearest a point, however far: a press on the line's label grabs
 * it, as the label may cover a short stretch whole. Undefined for a line without one.
 */
export function nearestMiddleStretch(line: readonly Point[], point: Point): number | undefined {
  const middle = middleStretches(line);
  return middle.length === 0 ? undefined : nearestStretch(line, point, middle)?.index;
}

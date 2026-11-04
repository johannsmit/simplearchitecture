import { getSmoothStepPath, Position } from '@xyflow/react';
import type { LinkRoute } from './elkLayout';
import type { Box, Point } from './positions';

/**
 * The shape of a relationship line: right angles with rounded corners, along the route
 * ELK worked out. Without a route that still holds (a card was moved), React Flow's right-angled
 * step between the two handles. Pure, so it is tested without a browser.
 */

const cornerRadius = 8;
/** How far the cards may be from where the route was made: more than rounding. */
const routeTolerance = 0.5;
/** From any handle on a circle to past the side of its box (circle.ts), within the card spacing. */
const circleExit = 56;
/** From any handle on a circle to under its box, with its longest label (cardSize.ts). */
const belowCircle = 96;
/** From any handle on a circle to above its box and the pill on it. */
const aboveCircle = 60;

/** The side of the card a line leaves or arrives at: React Flow's Position, as its text. */
type EndSide = `${Position}`;

export interface LineEnd extends Point {
  side: EndSide;
}

const leavesSideways = (side: EndSide) => side === 'left' || side === 'right';

/** The route on the canvas, or undefined when its cards are no longer where it was made. */
export function currentBends(
  route: LinkRoute | undefined,
  source: Box | undefined,
  target: Box | undefined,
): Point[] | undefined {
  if (!route || !source || !target) return undefined;
  const still =
    Math.abs(target.x - source.x - route.target.x) <= routeTolerance &&
    Math.abs(target.y - source.y - route.target.y) <= routeTolerance;
  if (!still) return undefined;
  return route.bends.map((bend) => ({ x: bend.x + source.x, y: bend.y + source.y }));
}

/** Without repeated points, and without points in the middle of a straight stretch. */
function simplified(line: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of line) {
    const last = result[result.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    const before = result[result.length - 2];
    if (
      before &&
      last &&
      ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))
    ) {
      result[result.length - 1] = point;
    } else {
      result.push(point);
    }
  }
  return result;
}

/** A point this far out from a sideways handle clears the circle's box, and so its label. */
function sideExit(end: LineEnd): number {
  return end.x + (end.side === 'left' ? -circleExit : circleExit);
}

/** A sideways end whose other point lies back behind it, or too close to clear its label. */
const needsExit = (end: LineEnd, x: number) =>
  (end.side === 'left' ? end.x - x : x - end.x) < circleExit;

const level = (a: Point, b: Point) => Math.abs(a.y - b.y) <= routeTolerance;

/**
 * Around a circle's label to ELK's bend, from the handle outwards. The line goes out past the box,
 * and back into ELK's lane once it is clear, as only that lane is free of other cards. A bend too
 * close for that gets the line's next stretch from the side of the box.
 */
function aroundLabel(end: LineEnd, bend: Point): Point[] {
  const x = sideExit(end);
  const clear = end.y + (bend.y > end.y ? belowCircle : -aboveCircle);
  return (bend.y > end.y ? bend.y > clear : bend.y < clear)
    ? [
        { x, y: end.y },
        { x, y: clear },
        { x: bend.x, y: clear },
        { x: bend.x, y: bend.y },
      ]
    : [
        { x, y: end.y },
        { x, y: bend.y },
      ];
}

/**
 * ELK's bends between the two handles. A handle can sit off ELK's port (on a Stakeholder circle,
 * or by rounding), so the first and last bends line up with the handles to keep the right angles.
 * A circle's handles leave sideways, while ELK's port can be under its label or above it: there,
 * the line first goes out past the side of the circle's box.
 */
export function routedLine(start: LineEnd, bends: readonly Point[], end: LineEnd): Point[] {
  const startSideways = leavesSideways(start.side);
  const endSideways = leavesSideways(end.side);
  const inner = bends.map((bend) => ({ ...bend }));
  const first = inner[0];
  if (first) {
    if (startSideways && level(first, inner[1] ?? end)) {
      inner.splice(0, 1, ...aroundLabel(start, first));
    } else if (startSideways) first.y = start.y;
    else first.x = start.x;
    const last = inner[inner.length - 1] as Point;
    if (endSideways && level(inner[inner.length - 2] ?? start, last)) {
      inner.splice(inner.length - 1, 1, ...aroundLabel(end, last).reverse());
    } else if (endSideways) last.y = end.y;
    else last.x = end.x;
  } else if (startSideways && !endSideways && needsExit(start, end.x)) {
    inner.push(...aroundLabel(start, end));
  } else if (!startSideways && endSideways && needsExit(end, start.x)) {
    inner.push(...aroundLabel(end, start).reverse());
  } else if (startSideways !== endSideways) {
    inner.push(startSideways ? { x: end.x, y: start.y } : { x: start.x, y: end.y });
  } else if (startSideways && start.side === end.side && needsExit(start, end.x)) {
    const x = sideExit(start);
    inner.push({ x, y: start.y }, { x, y: end.y });
  } else if (startSideways && Math.abs(start.y - end.y) > routeTolerance) {
    const x = (start.x + end.x) / 2;
    inner.push({ x, y: start.y }, { x, y: end.y });
  } else if (!startSideways && Math.abs(start.x - end.x) > routeTolerance) {
    const y = (start.y + end.y) / 2;
    inner.push({ x: start.x, y }, { x: end.x, y });
  }
  return simplified([{ x: start.x, y: start.y }, ...inner, { x: end.x, y: end.y }]);
}

const positions: Record<EndSide, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

/** React Flow's right-angled step between two handles, as points. */
export function steppedLine(start: LineEnd, end: LineEnd): Point[] {
  // With no rounding, its path is the corners: "M x y L x,yQ x,y x,y ... L x y".
  const [path] = getSmoothStepPath({
    sourceX: start.x,
    sourceY: start.y,
    sourcePosition: positions[start.side],
    targetX: end.x,
    targetY: end.y,
    targetPosition: positions[end.side],
    borderRadius: 0,
  });
  const numbers = path.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)?.map(Number) ?? [];
  const points: Point[] = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) {
    points.push({ x: numbers[index] as number, y: numbers[index + 1] as number });
  }
  return simplified(points);
}

/** The points of a line with its route, or a step without one. */
export function edgeLine(
  start: LineEnd,
  end: LineEnd,
  bends: readonly Point[] | undefined,
): Point[] {
  return bends ? routedLine(start, bends, end) : steppedLine(start, end);
}

/** The SVG path of a line, with each corner rounded as far as its two stretches allow. */
export function linePath(line: readonly Point[]): string {
  const [first] = line;
  if (!first) return '';
  let path = `M${first.x} ${first.y}`;
  line.forEach((corner, index) => {
    if (index === 0) return;
    const before = line[index - 1] as Point;
    const after = line[index + 1];
    if (!after) {
      path += `L${corner.x} ${corner.y}`;
      return;
    }
    const lengthIn = Math.hypot(corner.x - before.x, corner.y - before.y);
    const lengthOut = Math.hypot(after.x - corner.x, after.y - corner.y);
    const radius = Math.min(cornerRadius, lengthIn / 2, lengthOut / 2);
    const inX = corner.x - ((corner.x - before.x) / lengthIn) * radius;
    const inY = corner.y - ((corner.y - before.y) / lengthIn) * radius;
    const outX = corner.x + ((after.x - corner.x) / lengthOut) * radius;
    const outY = corner.y + ((after.y - corner.y) / lengthOut) * radius;
    path += `L${inX} ${inY}Q${corner.x} ${corner.y} ${outX} ${outY}`;
  });
  return path;
}

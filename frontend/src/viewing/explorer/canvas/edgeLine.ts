import { getSmoothStepPath, Position } from '@xyflow/react';
import { circleAngles, circleDiameter, circleNodeWidth } from './circle';
import type { LinkRoute, Side } from './elkLayout';
import { containerBox, crossesAny, groupTextArea, isGroupId, spacing } from './layoutGeometry';
import { orthogonalRoute, reverse, type Heading } from './orthogonalRoute';
import type { Box, Point } from './positions';
import {
  opposite,
  straightEnds,
  straightRoom,
  type SideEnd,
  type StraightCandidate,
} from './straightLines';

export { crossesAny } from './layoutGeometry';

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
export function simplified(line: readonly Point[]): Point[] {
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

/** A card as a line's end sees it: its box on the canvas, and whether it is a Stakeholder circle. */
export interface EndBox extends Box {
  circle?: boolean;
  /** The container it is drawn inside: a line may cross its own cards' containers. */
  parent?: string;
  /** A group box's header text (value and count), as wide as drawn: lines keep clear of it. */
  headerWidth?: number;
}

/** A line without a route: where it leaves and enters, and the corners it takes. */
export interface FloatingLine {
  start: LineEnd;
  end: LineEnd;
  points: Point[];
}

/** One end of a line that has no route: the card it is at and the side it uses. */
interface FloatingEnd {
  link: string;
  end: 'start' | 'end';
  card: string;
  side: Side;
  /** Where the other card is, along this side: ends are ordered by it, so lines don't cross. */
  towards: number;
}

const allSides: readonly Side[] = ['left', 'right', 'top', 'bottom'];
const circleSides: readonly Side[] = ['left', 'right'];

/**
 * The sides of two cards a line without a route leaves and enters: where the cards face each other.
 * Apart more sideways than up or down, the line runs sideways (right to left, or left to right);
 * otherwise up or down. A circle's line always leaves sideways (its label is below it). Cards that
 * overlap (one inside the other) use the direction between their centres.
 */
export function facingSides(source: EndBox, target: EndBox): { start: Side; end: Side } {
  const dx = target.x + target.width / 2 - (source.x + source.width / 2);
  const dy = target.y + target.height / 2 - (source.y + source.height / 2);
  const gapX = Math.max(target.x - (source.x + source.width), source.x - (target.x + target.width));
  const gapY = Math.max(
    target.y - (source.y + source.height),
    source.y - (target.y + target.height),
  );
  let sideways: boolean;
  if (source.circle === true || target.circle === true) sideways = true;
  else if (gapX > 0 || gapY > 0) sideways = gapX >= gapY;
  else {
    sideways =
      Math.abs(dx) / (source.width + target.width) >=
      Math.abs(dy) / (source.height + target.height);
  }
  const start: Side = sideways ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'bottom' : 'top';
  return { start, end: opposite[start] };
}

/** Whether two boxes have a gap between them across or up and down, as `facingSides` sees it. */
function apart(a: Box, b: Box): boolean {
  return b.x > a.x + a.width || a.x > b.x + b.width || b.y > a.y + a.height || a.y > b.y + b.height;
}

/** The point on a box's side at `offset` along it. */
function pointOn(box: Box, side: Side, offset: number): LineEnd {
  switch (side) {
    case 'left':
      return { x: box.x, y: box.y + offset, side };
    case 'right':
      return { x: box.x + box.width, y: box.y + offset, side };
    case 'top':
      return { x: box.x + offset, y: box.y, side };
    case 'bottom':
      return { x: box.x + offset, y: box.y + box.height, side };
  }
}

/** The middle of a side, or of a circle's left or right edge. */
function middleOf(box: EndBox, side: Side): LineEnd {
  if (box.circle === true) {
    const radius = circleDiameter / 2;
    const centre = box.x + circleNodeWidth / 2;
    return { x: side === 'left' ? centre - radius : centre + radius, y: box.y + radius, side };
  }
  return pointOn(box, side, leavesSideways(side) ? box.height / 2 : box.width / 2);
}

/**
 * The ends a pair of sides is judged by: the middles of the sides, or, where the cards face each
 * other across the pair and overlap, a place both share, so a straight line counts as straight.
 */
function judgedEnds(source: EndBox, start: Side, target: EndBox, end: Side): [LineEnd, LineEnd] {
  const room =
    source.circle !== true && target.circle !== true && end === opposite[start]
      ? straightRoom(source, start, target)
      : undefined;
  if (!room) return [middleOf(source, start), middleOf(target, end)];
  const middle = (box: Box) =>
    leavesSideways(start) ? box.y + box.height / 2 : box.x + box.width / 2;
  const at = Math.min(Math.max((middle(source) + middle(target)) / 2, room.low), room.high);
  const offset = (box: Box) => at - (leavesSideways(start) ? box.y : box.x);
  return [pointOn(source, start, offset(source)), pointOn(target, end, offset(target))];
}

/** The free place along a side nearest to `wanted`, keeping `spacing.ports` from `taken`. */
function nearestFree(wanted: number, taken: readonly number[], length: number): number {
  const free = (offset: number) =>
    offset > 0 && offset < length && taken.every((t) => Math.abs(t - offset) >= spacing.ports);
  for (let step = 0; step <= length; step += spacing.ports / 2) {
    if (free(wanted + step)) return wanted + step;
    if (free(wanted - step)) return wanted - step;
  }
  return wanted;
}

/** How far a line runs straight out of a card before it turns. */
const stub = 8;
/** Between a bend and a card it turns beside. */
const bendRoom = 12;
/** Cards further than this from both ends' cards can't be in a line's way, so aren't checked. */
const nearby = 160;
/** The most bend places tried for one pair of sides, nearest to the middle first. */
const maxBends = 12;

function lengthOf(line: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < line.length; index++) {
    const a = line[index - 1] as Point;
    const b = line[index] as Point;
    total += Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
  }
  return total;
}

/** The range of a coordinate (x for a sideways end, else y) that lies out from an end's side. */
function outward(end: LineEnd): [number, number] {
  switch (end.side) {
    case 'right':
      return [end.x + stub, Infinity];
    case 'left':
      return [-Infinity, end.x - stub];
    case 'bottom':
      return [end.y + stub, Infinity];
    case 'top':
      return [-Infinity, end.y - stub];
  }
}

const inRange = (value: number, [low, high]: [number, number]) => value >= low && value <= high;

/**
 * The right-angled lines between two ends with their sides fixed: straight when they meet head on;
 * one bend from a side to a top or bottom; otherwise two bends, at the middle, at either end's
 * limit, or just beside a card in the way (`around`), so a line can turn past it.
 */
export function candidateLines(start: LineEnd, end: LineEnd, around: readonly Box[]): Point[][] {
  const from = { x: start.x, y: start.y };
  const to = { x: end.x, y: end.y };
  const startSideways = leavesSideways(start.side);
  const endSideways = leavesSideways(end.side);
  if (startSideways !== endSideways) {
    const corner = startSideways ? { x: end.x, y: start.y } : { x: start.x, y: end.y };
    const ok = startSideways
      ? inRange(corner.x, outward(start)) && inRange(corner.y, outward(end))
      : inRange(corner.y, outward(start)) && inRange(corner.x, outward(end));
    return ok ? [simplified([from, corner, to])] : [];
  }
  const sideways = startSideways;
  const at = (point: Point) => (sideways ? point.x : point.y);
  const across = (point: Point) => (sideways ? point.y : point.x);
  const [lowA, highA] = outward(start);
  const [lowB, highB] = outward(end);
  const low = Math.max(lowA, lowB);
  const high = Math.min(highA, highB);
  const result: Point[][] = [];
  // Head on and level: straight, however close the cards are.
  if (
    across(start) === across(end) &&
    start.side === opposite[end.side] &&
    (start.side === 'right' || start.side === 'bottom' ? at(end) > at(start) : at(end) < at(start))
  ) {
    result.push([from, to]);
  }
  if (low > high) return result;
  const middle = (at(start) + at(end)) / 2;
  const places = new Set<number>();
  if (Number.isFinite(low) && Number.isFinite(high)) places.add((low + high) / 2);
  else places.add(Math.min(Math.max(middle, low), high));
  if (Number.isFinite(low)) places.add(low);
  if (Number.isFinite(high)) places.add(high);
  for (const box of around) {
    for (const edge of sideways
      ? [box.x - bendRoom, box.x + box.width + bendRoom]
      : [box.y - bendRoom, box.y + box.height + bendRoom]) {
      if (edge >= low && edge <= high) places.add(edge);
    }
  }
  const sorted = [...places].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
  for (const place of sorted.slice(0, maxBends)) {
    result.push(
      simplified(
        sideways
          ? [from, { x: place, y: start.y }, { x: place, y: end.y }, to]
          : [from, { x: start.x, y: place }, { x: end.x, y: place }, to],
      ),
    );
  }
  return result;
}

/**
 * The best of the lines: the shortest that runs through none of `blockers`; when every one does,
 * the shortest. Fewer bends break a tie, then the order given. Undefined for no lines.
 */
function bestLine(
  lines: readonly Point[][],
  blockers: readonly Box[],
): { line: Point[]; clear: boolean } | undefined {
  let best: { line: Point[]; clear: boolean; length: number } | undefined;
  for (const line of lines) {
    const clear = !crossesAny(line, blockers);
    const length = lengthOf(line);
    if (
      !best ||
      (clear && !best.clear) ||
      (clear === best.clear &&
        (length < best.length || (length === best.length && line.length < best.line.length)))
    ) {
      best = { line, clear, length };
    }
  }
  return best && { line: best.line, clear: best.clear };
}

/**
 * The headers of the containers one card is in and the other isn't (nor is it one of them): a line
 * between the two would run over a container's name there. Of a group box, only its value and
 * count, with room around them: a line may come in beside them.
 */
function headersCrossed(boxes: ReadonlyMap<string, EndBox>, source: string, target: string): Box[] {
  const chainOf = (id: string) => {
    const chain: string[] = [];
    for (let up = boxes.get(id)?.parent; up !== undefined && !chain.includes(up);) {
      chain.push(up);
      up = boxes.get(up)?.parent;
    }
    return chain;
  };
  const [fromSource, fromTarget] = [chainOf(source), chainOf(target)];
  const shared = new Set([source, target, ...fromSource.filter((id) => fromTarget.includes(id))]);
  const result: Box[] = [];
  for (const id of [...fromSource, ...fromTarget]) {
    const box = boxes.get(id);
    if (shared.has(id) || !box) continue;
    if (isGroupId(id)) {
      result.push(groupTextArea(box, box.headerWidth ?? box.width));
      continue;
    }
    const height = Math.min(box.height, containerBox.header);
    result.push({ x: box.x, y: box.y, width: box.width, height });
  }
  return result;
}

/** The containers a line between two cards may run through: those its cards are in. */
function freeOf(boxes: ReadonlyMap<string, EndBox>, source: string, target: string): Set<string> {
  const free = new Set<string>();
  for (const id of [source, target]) {
    for (let up = boxes.get(id)?.parent; up !== undefined && !free.has(up);) {
      free.add(up);
      up = boxes.get(up)?.parent;
    }
  }
  return free;
}

/** A box grown by `room` on every side. */
const grown = (box: Box, room: number): Box => ({
  x: box.x - room,
  y: box.y - room,
  width: box.width + 2 * room,
  height: box.height + 2 * room,
});

/** The smallest box round both boxes. */
function spanOf(a: Box, b: Box): Box {
  const [left, top] = [Math.min(a.x, b.x), Math.min(a.y, b.y)];
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The cards (not `free`) that reach into an area. */
function cardsIn(
  boxes: ReadonlyMap<string, EndBox>,
  free: ReadonlySet<string>,
  area: Box,
): { box: Box; id: string }[] {
  const result: { box: Box; id: string }[] = [];
  for (const [id, box] of boxes) {
    if (free.has(id)) continue;
    if (
      box.x > area.x + area.width ||
      box.x + box.width < area.x ||
      box.y > area.y + area.height ||
      box.y + box.height < area.y
    ) {
      continue;
    }
    result.push({ box, id });
  }
  return result;
}

/** The cards a line between two cards must not run through: near them, but not their containers. */
function blockersOf(
  boxes: ReadonlyMap<string, EndBox>,
  source: string,
  target: string,
  free: ReadonlySet<string>,
): { box: Box; id: string }[] {
  const area = grown(spanOf(boxes.get(source) as EndBox, boxes.get(target) as EndBox), nearby);
  return cardsIn(boxes, free, area);
}

/** Each bend of a detour costs as much as this much more length, so fewer bends are preferred. */
const bendCost = 40;
/** The most times a detour's area is widened to take in the cards it goes past. */
const maxWidenings = 4;

/** The heading a line leaves a card's side in. */
const headingOut: Record<Side, Heading> = { right: 0, bottom: 1, left: 2, top: 3 };

/** What a detour between a link's two cards has to keep clear of. */
interface DetourWay {
  boxes: ReadonlyMap<string, EndBox>;
  source: string;
  target: string;
  free: ReadonlySet<string>;
  /** The cards near both, as `blockersOf` gives them. */
  near: readonly { box: Box; id: string }[];
  headers: readonly Box[];
  /** What a detour keeps out of among `near`, made once for the searches of both passes. */
  avoid?: Box[];
  /** The detour the sides were chosen by, kept for the final line when its ends stay put. */
  chosen?: { line: Point[]; start: LineEnd; end: LineEnd };
}

/** A stub out from an end's side: where a detour may first turn. */
function stubOut(end: LineEnd): Point {
  switch (end.side) {
    case 'right':
      return { x: end.x + stub, y: end.y };
    case 'left':
      return { x: end.x - stub, y: end.y };
    case 'bottom':
      return { x: end.x, y: end.y + stub };
    case 'top':
      return { x: end.x, y: end.y - stub };
  }
}

/** Added to a detour from or to a side other than the facing one: the facing sides win a tie. */
const notFacing = 0.25;

/**
 * A right-angled line round the cards in the way, from one of `starts` to one of `ends`, with as
 * many bends as it takes, keeping `bendRoom` from every card it passes, `stub` from its own two
 * cards, and off the headers it must not cross. Its cost is its length plus `bendCost` a bend (and
 * `notFacing` for each end not on a facing side). When it goes wide, out past the cards near its
 * ends, the cards there are taken in too, and it is looked for again. `eased`, a card keeps less
 * than `bendRoom` where an end's stub is closer to it than that, so the line can still leave there.
 * Undefined when there is no such line, or for a circle's line, which keeps today's way.
 */
function detourLine(
  starts: readonly { end: LineEnd; extra?: number }[],
  ends: readonly { end: LineEnd; extra?: number }[],
  way: DetourWay,
  eased = false,
): Detour | undefined {
  const { boxes, source, target } = way;
  const sourceBox = boxes.get(source) as EndBox;
  const targetBox = boxes.get(target) as EndBox;
  if (sourceBox.circle === true || targetBox.circle === true) return undefined;
  const key = detourKey(starts, ends, way, eased);
  const hash = hashOf(key);
  const known = detoursMade.get(hash);
  if (known && sameKey(known.key, key)) {
    // Most recently used last, so the oldest go first.
    detoursMade.delete(hash);
    detoursMade.set(hash, known);
    return known.detour && copied(known.detour);
  }
  const { detour, widened } = searchDetour(starts, ends, way, eased);
  // A detour that went wide depends on cards the key doesn't hold, so isn't kept.
  if (!widened) {
    detoursMade.delete(hash);
    detoursMade.set(hash, { key, detour: detour && copied(detour) });
    if (detoursMade.size > maxDetoursMade) {
      detoursMade.delete(detoursMade.keys().next().value as number);
    }
  }
  return detour;
}

type Detour = { line: Point[]; start: LineEnd; end: LineEnd };

/**
 * Detours already found, by everything their search depends on: while a card is dragged, the
 * lines away from it keep theirs without searching again. Only the latest are kept: enough for
 * every detour of a full canvas, at a few kilobytes each.
 */
const detoursMade = new Map<number, { key: Float64Array; detour: Detour | undefined }>();
const maxDetoursMade = 1024;

const copied = (detour: Detour): Detour => ({
  line: detour.line.map((point) => ({ ...point })),
  start: { ...detour.start },
  end: { ...detour.end },
});

const sideNumbers: Record<Side, number> = { right: 0, bottom: 1, left: 2, top: 3 };

/**
 * All that a first search for a detour depends on, as numbers: the ends, the two cards and
 * whether they may be crossed, and the cards and headers near them.
 */
function detourKey(
  starts: readonly { end: LineEnd; extra?: number }[],
  ends: readonly { end: LineEnd; extra?: number }[],
  way: DetourWay,
  eased: boolean,
): Float64Array {
  const { boxes, source, target, free, near, headers } = way;
  const values: number[] = [eased ? 1 : 0, free.has(source) ? 1 : 0, free.has(target) ? 1 : 0];
  const addBox = (box: Box) => values.push(box.x, box.y, box.width, box.height);
  addBox(boxes.get(source) as EndBox);
  addBox(boxes.get(target) as EndBox);
  for (const list of [starts, ends]) {
    values.push(list.length);
    for (const { end, extra } of list) values.push(end.x, end.y, sideNumbers[end.side], extra ?? 0);
  }
  const others = near.filter((entry) => entry.id !== source && entry.id !== target);
  values.push(others.length);
  for (const entry of others) addBox(entry.box);
  values.push(headers.length);
  for (const header of headers) addBox(header);
  return Float64Array.from(values);
}

/** A hash of a key's numbers, bit for bit (FNV-1a over their bytes' words). */
function hashOf(key: Float64Array): number {
  const words = new Uint32Array(key.buffer, key.byteOffset, key.length * 2);
  let hash = 0x811c9dc5;
  for (const word of words) hash = Math.imul(hash ^ word, 0x01000193);
  return hash >>> 0;
}

function sameKey(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}

/** `detourLine`'s search, and whether it went wide. */
function searchDetour(
  starts: readonly { end: LineEnd; extra?: number }[],
  ends: readonly { end: LineEnd; extra?: number }[],
  way: DetourWay,
  eased: boolean,
): { detour: Detour | undefined; widened: boolean } {
  const { boxes, source, target, free, headers } = way;
  const sourceBox = boxes.get(source) as EndBox;
  const targetBox = boxes.get(target) as EndBox;
  const own = [
    ...(free.has(source) ? [] : [grown(sourceBox, stub)]),
    ...(free.has(target) ? [] : [grown(targetBox, stub)]),
  ];
  const stubs = [...starts, ...ends].map(({ end }) => stubOut(end));
  // How far a stub is from a card, across or along, whichever is more.
  const gap = (point: Point, box: Box) =>
    Math.max(
      box.x - point.x,
      point.x - (box.x + box.width),
      box.y - point.y,
      point.y - (box.y + box.height),
      0,
    );
  const roomFor = (box: Box) =>
    eased ? Math.min(bendRoom, ...stubs.map((point) => gap(point, box))) : bendRoom;
  const avoidOf = (near: readonly { box: Box; id: string }[]) => [
    ...near
      .filter((entry) => entry.id !== source && entry.id !== target)
      .map((entry) => grown(entry.box, roomFor(entry.box))),
    ...own,
    ...headers,
  ];
  let area = grown(spanOf(sourceBox, targetBox), nearby);
  let avoid = eased ? avoidOf(way.near) : (way.avoid ??= avoidOf(way.near));
  for (let widening = 0; widening <= maxWidenings; widening++) {
    const route = orthogonalRoute({
      starts: starts.map(({ end, extra }) => ({
        at: stubOut(end),
        heading: headingOut[end.side],
        extra: extra ?? 0,
      })),
      ends: ends.map(({ end, extra }) => ({
        at: stubOut(end),
        heading: reverse(headingOut[end.side]),
        extra: extra ?? 0,
      })),
      avoid,
      bendCost,
    });
    if (!route) return { detour: undefined, widened: widening > 0 };
    const xs = route.points.map((point) => point.x);
    const ys = route.points.map((point) => point.y);
    const reach: Box = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
    const kept = grown(reach, bendRoom);
    const within =
      kept.x >= area.x &&
      kept.y >= area.y &&
      kept.x + kept.width <= area.x + area.width &&
      kept.y + kept.height <= area.y + area.height;
    if (within) {
      const start = (starts[route.start] as { end: LineEnd }).end;
      const end = (ends[route.end] as { end: LineEnd }).end;
      const line = simplified([
        { x: start.x, y: start.y },
        ...route.points,
        { x: end.x, y: end.y },
      ]);
      return { detour: { line, start, end }, widened: widening > 0 };
    }
    area = spanOf(area, grown(reach, nearby));
    avoid = avoidOf(cardsIn(boxes, free, area));
  }
  return { detour: undefined, widened: true };
}

/**
 * The detour for a line's final ends: the one its sides were chosen by when the ends are still
 * where that put them (a single line on each side). Otherwise one looked for afresh, and when an
 * end has been spread along its side to within `bendRoom` of another card, so no detour leaves
 * there, one keeping less room from that card near the end.
 */
function finalDetour(start: LineEnd, end: LineEnd, way: DetourWay): Point[] | undefined {
  const same = (a: LineEnd, b: LineEnd) => a.x === b.x && a.y === b.y && a.side === b.side;
  const { chosen } = way;
  if (chosen && same(chosen.start, start) && same(chosen.end, end)) return chosen.line;
  return (
    detourLine([{ end: start }], [{ end }], way)?.line ??
    (chosen ? detourLine([{ end: start }], [{ end }], way, true)?.line : undefined)
  );
}

/**
 * Where each line without a route starts and ends, and the way it takes, from where its cards are
 * now. Every pair of sides is tried (a circle's lines leave sideways), with the bend at several
 * places, and the shortest line that runs through no other card is kept. When each one does, the
 * cheapest detour round the cards in the way is kept (`detourLine`), and only when there is none
 * the shortest line. Cards apart keep the sides where they face each other (`facingSides`) when
 * that line is clear; among the other pairs, the facing sides win a tie. Several ends
 * on one side are then spread evenly along it, ordered by where their other cards are, and kept
 * apart from the ends of routed lines there (`taken`, by card and side); the bend, or the
 * detour, is chosen again for the ends' final places. A line between cards that face each other
 * with room for it runs straight: its ends move along their sides, keeping their order and
 * spacing (`straightEnds`), where that runs through no other card. A line into or out of a
 * container keeps off its header, where the name is, coming in by a side below it, when it can.
 * On a circle, the ends sit on the circle, as its routed handles do, and a card facing it lines its
 * end up with the circle's. Only cards near a line are
 * checked, and a detour is kept while nothing it depends on moves, so this keeps up with a drag.
 */
export function floatingEnds(
  links: readonly { id: string; source: string; target: string }[],
  boxes: ReadonlyMap<string, EndBox>,
  taken: ReadonlyMap<string, readonly { side: Side; offset: number }[]> = new Map(),
): Map<string, FloatingLine> {
  const groups = new Map<string, FloatingEnd[]>();
  const add = (end: FloatingEnd) => {
    const key = `${end.card}\n${end.side}`;
    groups.set(key, [...(groups.get(key) ?? []), end]);
  };
  const blockers = new Map<string, Box[]>();
  const ways = new Map<string, DetourWay>();
  for (const link of links) {
    const source = boxes.get(link.source);
    const target = boxes.get(link.target);
    if (!source || !target) continue;
    const free = freeOf(boxes, link.source, link.target);
    const near = blockersOf(boxes, link.source, link.target, free);
    // The headers of the containers it goes into or out of, where their names are: it comes in
    // or leaves by a container's side below them.
    const headers = headersCrossed(boxes, link.source, link.target);
    // Its own two cards too: a line never runs back through them.
    const ownFree = [...near.map((entry) => entry.box), ...headers];
    blockers.set(link.id, ownFree);
    const way: DetourWay = {
      boxes,
      source: link.source,
      target: link.target,
      free,
      near,
      headers,
    };
    ways.set(link.id, way);
    const others = [
      ...near
        .filter((entry) => entry.id !== link.source && entry.id !== link.target)
        .map((entry) => entry.box),
      ...headers,
    ];
    const facing = facingSides(source, target);
    let chosen = facing;
    let best: { clear: boolean; length: number; bends: number } | undefined;
    // Cards apart: the facing sides win whenever their line is clear, even over a shorter line
    // with fewer bends, which would come into the other card by its side. Only otherwise are the
    // other pairs of sides tried.
    const facingClear =
      source.circle !== true &&
      target.circle !== true &&
      apart(source, target) &&
      bestLine(
        candidateLines(...judgedEnds(source, facing.start, target, facing.end), others),
        ownFree,
      )?.clear === true;
    if (facingClear) best = { clear: true, length: 0, bends: 0 };
    const startSides = facingClear ? [] : source.circle === true ? circleSides : allSides;
    for (const startSide of startSides) {
      for (const endSide of target.circle === true ? circleSides : allSides) {
        const found = bestLine(
          candidateLines(...judgedEnds(source, startSide, target, endSide), others),
          ownFree,
        );
        if (!found) continue;
        const score = {
          clear: found.clear,
          length: lengthOf(found.line),
          bends: found.line.length,
        };
        const isFacing = startSide === facing.start && endSide === facing.end;
        const better =
          !best ||
          (score.clear && !best.clear) ||
          (score.clear === best.clear &&
            (score.length < best.length - 0.5 ||
              (Math.abs(score.length - best.length) <= 0.5 &&
                (score.bends < best.bends || (score.bends === best.bends && isFacing)))));
        if (better) {
          best = score;
          chosen = { start: startSide, end: endSide };
        }
      }
    }
    // No pair of sides has a clear line with two bends or fewer: the sides of the cheapest clear
    // detour, if there is one, looked for from every side at once, the facing sides on a tie.
    if (best && !best.clear) {
      const sidesOf = (box: EndBox, wanted: Side) =>
        (box.circle === true ? circleSides : allSides).map((side) => ({
          end: middleOf(box, side),
          extra: side === wanted ? 0 : notFacing,
        }));
      const detour = detourLine(sidesOf(source, facing.start), sidesOf(target, facing.end), way);
      if (detour) {
        chosen = { start: detour.start.side, end: detour.end.side };
        way.chosen = detour;
      }
    }
    const along = (box: Box, side: Side) =>
      leavesSideways(side) ? box.y + box.height / 2 : box.x + box.width / 2;
    add({
      link: link.id,
      end: 'start',
      card: link.source,
      side: chosen.start,
      towards: along(target, chosen.start),
    });
    add({
      link: link.id,
      end: 'end',
      card: link.target,
      side: chosen.end,
      towards: along(source, chosen.end),
    });
  }
  const points = new Map<string, LineEnd>();
  for (const group of groups.values()) {
    group.sort((a, b) => a.towards - b.towards || (a.link < b.link ? -1 : a.link > b.link ? 1 : 0));
    const [first] = group;
    if (!first) continue;
    const box = boxes.get(first.card) as EndBox;
    const key = (end: FloatingEnd) => `${end.link}\n${end.end}`;
    if (box.circle === true) {
      const angles = circleAngles(first.side === 'left' ? 'left' : 'right', group.length);
      const radius = circleDiameter / 2;
      group.forEach((end, index) => {
        const angle = ((angles[index] ?? 0) * Math.PI) / 180;
        const dx = radius * Math.cos(angle);
        const centre = box.x + circleNodeWidth / 2;
        points.set(key(end), {
          x: end.side === 'right' ? centre + dx : centre - dx,
          y: box.y + radius + radius * Math.sin(angle),
          side: end.side,
        });
      });
      continue;
    }
    const length = leavesSideways(first.side) ? box.height : box.width;
    const used = (taken.get(first.card) ?? [])
      .filter((handle) => handle.side === first.side)
      .map((handle) => handle.offset);
    group.forEach((end, index) => {
      const offset = nearestFree((length * (index + 1)) / (group.length + 1), used, length);
      used.push(offset);
      points.set(key(end), pointOn(box, end.side, offset));
    });
  }
  // Lines between cards that face each other with room for it run straight. A circle's end stays
  // where the circle puts it, and the card's end lines up with it.
  const offsetOf = (point: LineEnd, box: Box) =>
    leavesSideways(point.side) ? point.y - box.y : point.x - box.x;
  const sideEnd = (card: string, box: EndBox, end: LineEnd) => ({
    card,
    side: end.side,
    offset: offsetOf(end, box),
    ...(box.circle === true ? { point: { x: end.x, y: end.y } } : {}),
  });
  const straightLinks: StraightCandidate[] = [];
  for (const link of links) {
    const from = points.get(`${link.id}\nstart`);
    const to = points.get(`${link.id}\nend`);
    const source = boxes.get(link.source);
    const target = boxes.get(link.target);
    if (!from || !to || !source || !target) continue;
    if (source.circle === true && target.circle === true) continue;
    straightLinks.push({
      id: link.id,
      start: sideEnd(link.source, source, from),
      end: sideEnd(link.target, target, to),
    });
  }
  // Routed lines' ends stay, and are kept clear of.
  const straight = straightEnds(straightLinks, boxes, taken, (line, from, to) => {
    const [source, target] = [boxes.get(line.start.card), boxes.get(line.end.card)];
    const others = (blockers.get(line.id) ?? []).filter((box) => box !== source && box !== target);
    return !crossesAny([from, to], others);
  });
  for (const line of straightLinks) {
    const offsets = straight.get(line.id);
    if (!offsets) continue;
    const source = boxes.get(line.start.card) as Box;
    const target = boxes.get(line.end.card) as Box;
    // Level with a circle's end to the last bit, so the line counts as straight.
    const lined = (end: LineEnd, other: SideEnd): LineEnd => {
      if (!other.point) return end;
      return leavesSideways(end.side) ? { ...end, y: other.point.y } : { ...end, x: other.point.x };
    };
    if (!line.start.point) {
      const start = pointOn(source, line.start.side, offsets.start);
      points.set(`${line.id}\nstart`, lined(start, line.end));
    }
    if (!line.end.point) {
      points.set(`${line.id}\nend`, lined(pointOn(target, line.end.side, offsets.end), line.start));
    }
  }
  const result = new Map<string, FloatingLine>();
  for (const link of links) {
    const start = points.get(`${link.id}\nstart`);
    const end = points.get(`${link.id}\nend`);
    if (!start || !end) continue;
    const source = boxes.get(link.source) as EndBox;
    const target = boxes.get(link.target) as EndBox;
    const all = blockers.get(link.id) ?? [];
    const others = all.filter((box) => box !== source && box !== target);
    const found = bestLine(candidateLines(start, end, others), all);
    const way = ways.get(link.id);
    const detour = found?.clear !== true && way ? finalDetour(start, end, way) : undefined;
    result.set(link.id, {
      start,
      end,
      points: detour ?? found?.line ?? directLine(start, end),
    });
  }
  return result;
}

/**
 * The shortest right-angled line between two ends: straight when they line up, one bend when one
 * end leaves sideways and the other up or down, otherwise two bends halfway between them.
 */
export function directLine(start: LineEnd, end: LineEnd): Point[] {
  const from = { x: start.x, y: start.y };
  const to = { x: end.x, y: end.y };
  const startSideways = leavesSideways(start.side);
  const endSideways = leavesSideways(end.side);
  if (startSideways !== endSideways) {
    return simplified([
      from,
      startSideways ? { x: end.x, y: start.y } : { x: start.x, y: end.y },
      to,
    ]);
  }
  if (startSideways) {
    const x = (start.x + end.x) / 2;
    return simplified([from, { x, y: start.y }, { x, y: end.y }, to]);
  }
  const y = (start.y + end.y) / 2;
  return simplified([from, { x: start.x, y }, { x: end.x, y }, to]);
}

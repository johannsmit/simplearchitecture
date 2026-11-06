import { getSmoothStepPath, Position } from '@xyflow/react';
import { circleAngles, circleDiameter, circleNodeWidth } from './circle';
import { spacing, type LinkRoute, type Side } from './elkLayout';
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

/** A card as a line's end sees it: its box on the canvas, and whether it is a Stakeholder circle. */
export interface EndBox extends Box {
  circle?: boolean;
  /** The container it is drawn inside: a line may cross its own cards' containers. */
  parent?: string;
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

const opposite: Record<Side, Side> = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };
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

/** True when an axis-aligned stretch runs through the inside of a box (touching its edge is fine). */
function cutsThrough(a: Point, b: Point, box: Box): boolean {
  const inset = 0.5;
  const [left, right] = [box.x + inset, box.x + box.width - inset];
  const [top, bottom] = [box.y + inset, box.y + box.height - inset];
  if (a.x === b.x) {
    return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
  }
  return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
}

/** True when a line runs through any of the boxes. */
export function crossesAny(line: readonly Point[], boxes: readonly Box[]): boolean {
  for (let index = 1; index < line.length; index++) {
    const a = line[index - 1] as Point;
    const b = line[index] as Point;
    if (boxes.some((box) => cutsThrough(a, b, box))) return true;
  }
  return false;
}

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

/** The cards a line between two cards must not run through: near them, but not their containers. */
function blockersOf(
  boxes: ReadonlyMap<string, EndBox>,
  source: string,
  target: string,
): { box: Box; id: string }[] {
  const free = new Set<string>();
  for (const id of [source, target]) {
    for (let up = boxes.get(id)?.parent; up !== undefined && !free.has(up);) {
      free.add(up);
      up = boxes.get(up)?.parent;
    }
  }
  const a = boxes.get(source) as EndBox;
  const b = boxes.get(target) as EndBox;
  const left = Math.min(a.x, b.x) - nearby;
  const right = Math.max(a.x + a.width, b.x + b.width) + nearby;
  const top = Math.min(a.y, b.y) - nearby;
  const bottom = Math.max(a.y + a.height, b.y + b.height) + nearby;
  const result: { box: Box; id: string }[] = [];
  for (const [id, box] of boxes) {
    if (free.has(id)) continue;
    if (box.x > right || box.x + box.width < left || box.y > bottom || box.y + box.height < top) {
      continue;
    }
    result.push({ box, id });
  }
  return result;
}

/**
 * Where each line without a route starts and ends, and the way it takes, from where its cards are
 * now. Every pair of sides is tried (a circle's lines leave sideways), with the bend at several
 * places, and the shortest line that runs through no other card is kept; only when each one does
 * is the shortest kept. Cards facing each other come first on a tie (`facingSides`). Several ends
 * on one side are then spread evenly along it, ordered by where their other cards are, and kept
 * apart from the ends of routed lines there (`taken`, by card and side); the bend is chosen again
 * for the ends' final places. A line alone on both of its sides, between cards level with each
 * other, runs straight. On a circle, the ends sit on the circle, as its routed handles do. Only
 * cards near a line are checked, so this keeps up with a drag.
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
  for (const link of links) {
    const source = boxes.get(link.source);
    const target = boxes.get(link.target);
    if (!source || !target) continue;
    const near = blockersOf(boxes, link.source, link.target);
    // Its own two cards too: a line never runs back through them.
    const ownFree = near.map((entry) => entry.box);
    blockers.set(link.id, ownFree);
    const others = near
      .filter((entry) => entry.id !== link.source && entry.id !== link.target)
      .map((entry) => entry.box);
    const facing = facingSides(source, target);
    let chosen = facing;
    let best: { clear: boolean; length: number; bends: number } | undefined;
    for (const startSide of source.circle === true ? circleSides : allSides) {
      for (const endSide of target.circle === true ? circleSides : allSides) {
        const found = bestLine(
          candidateLines(middleOf(source, startSide), middleOf(target, endSide), others),
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
  const alone = new Set<string>();
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
    // Alone on a side with no routed line there: free to move along it to run straight.
    if (group.length === 1 && used.length === 0) alone.add(key(first));
    group.forEach((end, index) => {
      const offset = nearestFree((length * (index + 1)) / (group.length + 1), used, length);
      used.push(offset);
      points.set(key(end), pointOn(box, end.side, offset));
    });
  }
  const result = new Map<string, FloatingLine>();
  for (const link of links) {
    const start = points.get(`${link.id}\nstart`);
    const end = points.get(`${link.id}\nend`);
    if (!start || !end) continue;
    const source = boxes.get(link.source) as EndBox;
    const target = boxes.get(link.target) as EndBox;
    if (
      alone.has(`${link.id}\nstart`) &&
      alone.has(`${link.id}\nend`) &&
      source.circle !== true &&
      target.circle !== true
    ) {
      straighten(start, end, source, target);
    }
    const all = blockers.get(link.id) ?? [];
    const others = all.filter((box) => box !== source && box !== target);
    const found = bestLine(candidateLines(start, end, others), all);
    result.set(link.id, { start, end, points: found?.line ?? directLine(start, end) });
  }
  return result;
}

/** Room kept between a straightened line and a card's corner. */
const cornerRoom = 8;

/** Two ends facing each other across cards that are level: moved to where both can meet straight. */
function straighten(start: LineEnd, end: LineEnd, source: Box, target: Box) {
  if (leavesSideways(start.side)) {
    const from = Math.max(source.y, target.y) + cornerRoom;
    const to = Math.min(source.y + source.height, target.y + target.height) - cornerRoom;
    if (from > to) return;
    const y = Math.min(Math.max((start.y + end.y) / 2, from), to);
    start.y = y;
    end.y = y;
  } else {
    const from = Math.max(source.x, target.x) + cornerRoom;
    const to = Math.min(source.x + source.width, target.x + target.width) - cornerRoom;
    if (from > to) return;
    const x = Math.min(Math.max((start.x + end.x) / 2, from), to);
    start.x = x;
    end.x = x;
  }
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

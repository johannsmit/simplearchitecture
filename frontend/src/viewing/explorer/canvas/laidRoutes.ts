import type { PlacedCard, PlacedHandle } from './elkLayout';
import {
  absoluteBoxes,
  frameOf,
  groupTextArea,
  isGroupId,
  linkOfPort,
  portId,
} from './layoutGeometry';
import { fitContainers, type Box, type Point } from './positions';

/**
 * ELK's layout made ready for the canvas: every container fitted to what it holds, as the canvas
 * fits it (`fitContainers`), with each line's route carried along, and lines into a container kept
 * clear of its name. Pure, so it is tested without a browser.
 *
 * - ELK leaves room in a container for the lines that leave it, so the fit moves its cards and
 *   changes its size. A route that ran there is carried over with what it ran along: its bends
 *   inside a container move with that container's cards, and a stretch that crosses a container's
 *   edge slides its bend outside, so it stays straight. A route that can't be carried is dropped,
 *   and the canvas draws the line on its own.
 * - ELK brings a line into a container straight down to the card, through the container's name.
 *   Such a line comes in beside the name instead (or past the container's side, when the name
 *   leaves no room), and turns to its card in the band between the header and the cards. Lines on
 *   one side are nested, so they don't cross each other. A line that would then run over another
 *   card keeps ELK's route.
 */

/** A line with its whole route on the canvas, from its source's port to its target's port. */
interface Line {
  source: string;
  target: string;
  /** The source handle, which holds the route. */
  handle: string;
  points: Point[];
}

/** Lines this far apart beside a name. */
const slotSpacing = 6;
/** How far a line beside a name keeps from the container's edge. */
const edgeRoom = 4;
/** How far a line past a container's side keeps from it. */
const sideRoom = 8;
/** The least a line runs out of a card before it turns, so its arrowhead is outside the card. */
const endRoom = 8;
/** How far from a container's edge a line steps aside. */
const stepRoom = 12;
/** Coordinates closer than this are the same. */
const same = 0.5;

const near = (a: number, b: number) => Math.abs(a - b) < same;

/** Where a handle is on a box, or undefined when the box's side is no longer long enough. */
function handlePoint(box: Box, handle: PlacedHandle): Point | undefined {
  const upright = handle.side === 'left' || handle.side === 'right';
  if (handle.offset > (upright ? box.height : box.width) + same) return undefined;
  if (handle.side === 'left') return { x: box.x, y: box.y + handle.offset };
  if (handle.side === 'right') return { x: box.x + box.width, y: box.y + handle.offset };
  if (handle.side === 'top') return { x: box.x + handle.offset, y: box.y };
  return { x: box.x + handle.offset, y: box.y + box.height };
}

const inside = (point: Point, box: Box) =>
  point.x > box.x + same &&
  point.x < box.x + box.width - same &&
  point.y > box.y + same &&
  point.y < box.y + box.height - same;

/** Whether a straight stretch runs through a box's inside, `inset` in from its edges. */
function runsThrough(a: Point, b: Point, box: Box, inset: number): boolean {
  const [left, right] = [box.x + inset, box.x + box.width - inset];
  const [top, bottom] = [box.y + inset, box.y + box.height - inset];
  if (near(a.y, b.y)) {
    return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  }
  return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
}

/** Without repeated points or points in the middle of a straight stretch. */
function tidied(points: readonly Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (last && near(last.x, point.x) && near(last.y, point.y)) continue;
    const before = result[result.length - 2];
    if (
      before &&
      last &&
      ((near(before.x, last.x) && near(last.x, point.x)) ||
        (near(before.y, last.y) && near(last.y, point.y)))
    ) {
      result[result.length - 1] = point;
    } else {
      result.push(point);
    }
  }
  return result;
}

const rightAngled = (points: readonly Point[]) =>
  points.every((point, index) => {
    const before = points[index - 1];
    return !before || near(before.x, point.x) || near(before.y, point.y);
  });

export interface LaidOptions {
  /** A container's smallest size: room for its name in its header. */
  minSizeOf: (id: string) => { width: number; height: number };
  /** How wide a container's name is drawn (type mark and name, uncut), when known. */
  nameWidthOf?: (id: string) => number | undefined;
}

/**
 * The cards as ELK placed them (parents first, positions relative to their container), with every
 * container fitted, and the routes carried along and kept clear of container names.
 */
export function laidForCanvas(
  placed: ReadonlyMap<string, PlacedCard>,
  options: LaidOptions,
): Map<string, PlacedCard> {
  const containers = new Set<string>();
  for (const card of placed.values()) if (card.parent !== undefined) containers.add(card.parent);
  const fitted = fitContainers(placed, containers, options);
  const before = absoluteBoxes(placed);
  const after = absoluteBoxes(fitted);

  const chainOf = (id: string): string[] => {
    const chain: string[] = [];
    for (let up = placed.get(id)?.parent; up !== undefined && !chain.includes(up);) {
      chain.push(up);
      up = placed.get(up)?.parent;
    }
    return chain;
  };
  const chains = new Map([...placed.keys()].map((id) => [id, chainOf(id)]));
  // How far the cards in each container moved on the canvas.
  const shiftIn = new Map<string, Point>();
  for (const card of fitted.values()) {
    if (card.parent === undefined || shiftIn.has(card.parent)) continue;
    const [was, now] = [before.get(card.id), after.get(card.id)];
    if (was && now) shiftIn.set(card.parent, { x: now.x - was.x, y: now.y - was.y });
  }
  // Deepest first, so a point takes the shift of the innermost container it was in.
  const byDepth = [...containers]
    .filter((id) => before.has(id))
    .sort((a, b) => (chains.get(b)?.length ?? 0) - (chains.get(a)?.length ?? 0));
  const regionOf = (point: Point) => byDepth.find((id) => inside(point, before.get(id) as Box));
  const depthOf = (region: string | undefined) =>
    region === undefined ? -1 : (chains.get(region)?.length ?? 0);

  const handles = new Map<string, { card: string; handle: PlacedHandle }>();
  // A container's side the fit made shorter than its handles need: they spread along what is left.
  const handlesNow = new Map<string, PlacedHandle>();
  for (const card of placed.values()) {
    for (const handle of card.handles) handles.set(handle.id, { card: card.id, handle });
    const [was, now] = [before.get(card.id), after.get(card.id)];
    if (!was || !now) continue;
    for (const upright of [true, false]) {
      const [long, short] = upright ? [was.height, now.height] : [was.width, now.width];
      const on = card.handles.filter(
        (handle) => (handle.side === 'left' || handle.side === 'right') === upright,
      );
      if (!on.some((handle) => handle.offset > short)) continue;
      for (const handle of on) {
        handlesNow.set(handle.id, { ...handle, offset: (handle.offset * short) / long });
      }
    }
  }
  const nowOf = (handle: PlacedHandle) => handlesNow.get(handle.id) ?? handle;

  /** Whether a line runs over a card or container it isn't attached to (or in). */
  const overOthers = (line: Line) => {
    const own = new Set([
      line.source,
      line.target,
      ...(chains.get(line.source) ?? []),
      ...(chains.get(line.target) ?? []),
    ]);
    for (const [id, box] of after) {
      if (own.has(id)) continue;
      const ups = chains.get(id) ?? [];
      if (ups.includes(line.source) || ups.includes(line.target)) continue;
      for (let index = 1; index < line.points.length; index++) {
        if (runsThrough(line.points[index - 1] as Point, line.points[index] as Point, box, 2)) {
          return true;
        }
      }
    }
    return false;
  };

  /**
   * The containers a point of a line is in: a bend's, or an end's, with the end's own card when
   * the line runs inside it (to a card it holds).
   */
  const containersAt = (line: Line, point: Point, end?: 'source' | 'target'): string[] => {
    if (end === undefined) {
      const region = regionOf(point);
      return region === undefined ? [] : [region, ...(chains.get(region) ?? [])];
    }
    const [card, other] =
      end === 'source' ? [line.source, line.target] : [line.target, line.source];
    const chain = chains.get(card) ?? [];
    return (chains.get(other) ?? []).includes(card) ? [card, ...chain] : chain;
  };

  /**
   * A step for a stretch whose two ends moved apart, where it runs outside the containers only one
   * end is in. Undefined when there is no room for it.
   */
  const stepBetween = (
    a: { at: Point; in: string[] },
    b: { at: Point; in: string[] },
    upright: boolean,
  ): Point[] | undefined => {
    const axis = upright ? 'y' : 'x';
    const [first, last] = a.at[axis] < b.at[axis] ? [a, b] : [b, a];
    let [from, to] = [first.at[axis], last.at[axis]];
    const leaves = first.in.filter((c) => !last.in.includes(c));
    const enters = last.in.filter((c) => !first.in.includes(c));
    for (const id of leaves) {
      const box = after.get(id) as Box;
      from = Math.max(from, upright ? box.y + box.height : box.x + box.width);
    }
    for (const id of enters) {
      const box = after.get(id) as Box;
      to = Math.min(to, upright ? box.y : box.x);
    }
    if (to - from < 2 * endRoom) return undefined;
    // Just outside the container's edge, where its cards were before the fit (or the spacing
    // around it), rather than further out among other cards.
    const close = Math.min(stepRoom, (to - from) / 2);
    const middle =
      leaves.length > 0 ? from + close : enters.length > 0 ? to - close : (from + to) / 2;
    return upright
      ? [
          { x: a.at.x, y: middle },
          { x: b.at.x, y: middle },
        ]
      : [
          { x: middle, y: a.at.y },
          { x: middle, y: b.at.y },
        ];
  };

  /**
   * A route carried through the fit, or undefined when it can't be. A stretch whose ends moved
   * apart slides one of them (`slide`: the end of the line, else the bend deeper in, stays), or
   * steps where it crosses a container's edge (`step`), sliding only where there is no room.
   */
  const carried = (
    line: Line,
    start: Point,
    end: Point,
    way: 'slide' | 'step',
  ): Line | undefined => {
    const old = tidied(line.points);
    const last = old.length - 1;
    const moved = old.map((point, index) => {
      if (index === 0) return { ...start };
      if (index === last) return { ...end };
      const shift = shiftIn.get(regionOf(point) ?? '') ?? { x: 0, y: 0 };
      return { x: point.x + shift.x, y: point.y + shift.y };
    });
    const depth = old.map((point, index) =>
      index === 0 || index === last ? Infinity : depthOf(regionOf(point)),
    );
    const endOf = (index: number) =>
      index === 0 ? ('source' as const) : index === last ? ('target' as const) : undefined;
    const steps = new Map<number, Point[]>();
    for (let index = 0; index < last; index++) {
      const [a, b] = [old[index] as Point, old[index + 1] as Point];
      const upright = near(a.x, b.x);
      if (!upright && !near(a.y, b.y)) return undefined;
      const axis = upright ? 'x' : 'y';
      const [ma, mb] = [moved[index] as Point, moved[index + 1] as Point];
      if (near(ma[axis], mb[axis])) continue;
      const bothEnds = index === 0 && index + 1 === last;
      if (bothEnds || way === 'step') {
        const step = stepBetween(
          { at: ma, in: containersAt(line, a, endOf(index)) },
          { at: mb, in: containersAt(line, b, endOf(index + 1)) },
          upright,
        );
        if (step) {
          steps.set(index, step);
          continue;
        }
        if (bothEnds) return undefined;
      }
      const keepA =
        index === 0 || (index + 1 !== last && (depth[index] ?? 0) >= (depth[index + 1] ?? 0));
      if (keepA) mb[axis] = ma[axis];
      else ma[axis] = mb[axis];
    }
    const points = moved.flatMap((point, index) => [point, ...(steps.get(index) ?? [])]);
    const result = { ...line, points: tidied(points) };
    return rightAngled(result.points) && !overOthers(result) ? result : undefined;
  };

  // Every routed line, carried through the fit.
  const lines = new Map<string, Line>();
  for (const card of placed.values()) {
    for (const handle of card.handles) {
      if (!handle.route) continue;
      const target = handles.get(portId(linkOfPort(handle.id), 'target'));
      const [from, to] = [before.get(card.id), target && before.get(target.card)];
      const [fromNow, toNow] = [after.get(card.id), target && after.get(target.card)];
      if (!target || !from || !to || !fromNow || !toNow) continue;
      const start = handlePoint(from, handle);
      const end = handlePoint(to, target.handle);
      const startNow = handlePoint(fromNow, nowOf(handle));
      const endNow = handlePoint(toNow, nowOf(target.handle));
      if (!start || !end || !startNow || !endNow) continue;
      const line: Line = {
        source: card.id,
        target: target.card,
        handle: handle.id,
        points: [
          start,
          ...handle.route.bends.map((bend) => ({ x: bend.x + from.x, y: bend.y + from.y })),
          end,
        ],
      };
      const kept =
        carried(line, startNow, endNow, 'slide') ?? carried(line, startNow, endNow, 'step');
      if (kept) lines.set(handle.id, kept);
    }
  }

  // Lines kept clear of each container's name, outermost container first. A line changed for one
  // container must cross fewer names than before, counting every container's.
  const nameWidthOf = (id: string) =>
    options.nameWidthOf?.(id) ?? options.minSizeOf(id).width - nameInset;
  const names = byDepth.map((id) => nameArea(after.get(id) as Box, nameWidthOf(id), id));
  const namesCrossed = (line: Line) =>
    names.filter((name) =>
      line.points.some((point, index) => {
        const before = line.points[index - 1];
        return before !== undefined && runsThrough(before, point, name, 0);
      }),
    ).length;
  const outermostFirst = [...byDepth].reverse();
  for (const id of outermostFirst) {
    const box = after.get(id) as Box;

    const keep = (line: Line, was: Line) =>
      rightAngled(line.points) && !overOthers(line) && namesCrossed(line) < namesCrossed(was);
    for (const [handle, line] of clearOfName(id, box, nameWidthOf(id), [...lines.values()], keep)) {
      lines.set(handle, line);
    }
  }

  const result = new Map<string, PlacedCard>();
  for (const [id, card] of fitted) {
    const from = after.get(id) as Box;
    result.set(id, {
      ...card,
      handles: card.handles.map((ownHandle) => {
        const handle = nowOf(ownHandle);
        if (!handle.route) return handle;
        const line = lines.get(handle.id);
        const target = handles.get(portId(linkOfPort(handle.id), 'target'));
        const to = target && after.get(target.card);
        if (!line || !to) {
          const unrouted = { ...handle };
          delete unrouted.route;
          return unrouted;
        }
        return {
          ...handle,
          route: {
            bends: line.points.slice(1, -1).map((p) => ({ x: p.x - from.x, y: p.y - from.y })),
            target: { x: to.x - from.x, y: to.y - from.y },
          },
        };
      }),
    });
  }
  return result;
}

/**
 * The room a container's header keeps around its name: a 1px border and 12px padding either side,
 * and 4px to spare (cardSize.ts).
 */
const nameInset = 30;

/**
 * Where a container's name is: centred in its header, `width` wide (type mark and name, from
 * cardSize.ts) or as wide as the header lets it be (a longer name is cut), with 4px either side.
 * A group box's value and count are at the left of its header instead, kept 8px clear.
 */
export function nameArea(box: Box, width: number, id?: string): Box {
  if (id !== undefined && isGroupId(id)) return groupTextArea(box, width);
  const shown = Math.max(0, Math.min(width, box.width - 26)) + 8;
  return {
    x: box.x + (box.width - shown) / 2,
    y: box.y,
    width: shown,
    height: frameOf(id).header,
  };
}

/** A line's way through a container's header, from where it comes in to where it is under it. */
interface Entry {
  line: Line;
  /** The line's points, from the end the line comes in by. */
  points: Point[];
  /** Whether `points` runs backwards along the line. */
  reversed: boolean;
  /** Where it comes in: over the top, or from a side at the header's height. */
  from: 'top' | 'side';
  /** The index of the point where it comes in, and of the first point under the header. */
  entry: number;
  under: number;
}

/** How a line runs through a container's header across its name, or undefined when it doesn't. */
function entryOf(line: Line, box: Box, name: Box, bandTop: number): Entry | undefined {
  const crosses = line.points.findIndex(
    (point, index) => index > 0 && runsThrough(line.points[index - 1] as Point, point, name, 0),
  );
  if (crosses < 0) return undefined;
  const inHeader = (p: Point) =>
    p.y > box.y + same && p.y < bandTop && p.x > box.x + same && p.x < box.x + box.width - same;
  for (const reversed of [false, true]) {
    const points = reversed ? [...line.points].reverse() : line.points;
    const at = reversed ? line.points.length - crosses : crosses;
    // Back to the last point outside the header, and on to the first point under it.
    let entry = at - 1;
    while (entry > 0 && inHeader(points[entry] as Point)) entry--;
    let under = at;
    while (under < points.length - 1 && inHeader(points[under] as Point)) under++;
    const [first, last] = [points[entry] as Point, points[under] as Point];
    const next = points[entry + 1] as Point;
    if (inHeader(first) || last.y < bandTop || !near(last.x, (points[under - 1] as Point).x)) {
      continue;
    }
    if (first.y <= box.y + same && near(first.x, next.x) && next.y > first.y) {
      return { line, points, reversed, from: 'top', entry, under };
    }
    if (inside(first, { ...box, y: box.y - 1 }) || !near(first.y, next.y)) continue;
    return { line, points, reversed, from: 'side', entry, under };
  }
  return undefined;
}

/**
 * The lines that ran through a container's name, each brought in beside it, or under it from the
 * side, and on to its card in the band under the header. On each side of the name, the lines are
 * nested so they don't cross: the one going furthest out takes the place furthest out, and the
 * lowest level in the band. `keep` says whether a changed line may be used. By source handle id.
 */
function clearOfName(
  id: string,
  box: Box,
  nameWidth: number,
  lines: readonly Line[],
  keep: (line: Line, was: Line) => boolean,
): Map<string, Line> {
  const name = nameArea(box, nameWidth, id);
  const frame = frameOf(id);
  const band = {
    top: box.y + frame.header + 1,
    bottom: box.y + frame.padding.top - endRoom,
  };
  const entries = lines.flatMap((line) => entryOf(line, box, name, band.top) ?? []);
  const result = new Map<string, Line>();
  const centre = name.x + name.width / 2;
  for (const left of [true, false]) {
    const outward = (x: number) => (left ? x : -x);
    const side = entries
      .filter((each) => (each.points[each.under] as Point).x < centre === left)
      .sort(
        (a, b) => outward((a.points[a.under] as Point).x) - outward((b.points[b.under] as Point).x),
      );
    if (side.length === 0) continue;
    // Places beside the name, nearest the name first, then past the container's side.
    const places: number[] = [];
    const [closest, far] = left
      ? [name.x - 2, box.x + edgeRoom]
      : [name.x + name.width + 2, box.x + box.width - edgeRoom];
    for (let x = closest; outward(x) >= outward(far); x += left ? -slotSpacing : slotSpacing) {
      places.push(x);
    }
    const wanted = side.filter((each) => each.from === 'top').length;
    for (let k = 0; places.length < wanted; k++) {
      places.push(
        left ? box.x - sideRoom - k * slotSpacing : box.x + box.width + sideRoom + k * slotSpacing,
      );
    }
    // The line going furthest out takes the place furthest out, the lowest level and the
    // highest step above the container.
    const used = places.slice(0, wanted).reverse();
    const span = band.bottom - band.top;
    const step = side.length > 1 ? Math.min(slotSpacing, span / (side.length - 1)) : 0;
    let slot = 0;
    side.forEach((each, k) => {
      const level = band.bottom - k * step;
      if (each.from === 'side') {
        const moved = underName(each, level);
        if (moved && keep(moved, each.line)) result.set(each.line.handle, moved);
        return;
      }
      const x = used[slot++] as number;
      const above = box.y - endRoom - (side.length - 1 - k) * 3;
      for (const way of ['slide', 'step'] as const) {
        const moved = besideName(each, x, level, above, way);
        if (moved && keep(moved, each.line)) {
          result.set(each.line.handle, moved);
          break;
        }
      }
    });
  }
  return result;
}

/** The line as it runs along the line, from a changed copy of `entry.points`. */
const asLine = (entry: Entry, points: Point[]): Line => {
  const whole = tidied(points);
  return { ...entry.line, points: entry.reversed ? whole.reverse() : whole };
};

/**
 * The line coming in over the top at `x`, beside the name, and turning to the card at `level`:
 * its bend above the container slides there (`slide`), or it steps aside just above the container
 * (`step`, at `above`). Undefined when it can't.
 */
function besideName(
  entry: Entry,
  x: number,
  level: number,
  above: number,
  way: 'slide' | 'step',
): Line | undefined {
  const { points, entry: at, under } = entry;
  const first = points[at] as Point;
  const last = points[under] as Point;
  const isEnd = at === 0;
  const head: Point[] = [];
  if (way === 'slide') {
    // A bend, with a stretch across before it: it moves along that stretch.
    if (isEnd || !near((points[at - 1] as Point).y, first.y)) return undefined;
    head.push({ x, y: first.y });
  } else {
    // A card's port above (or the container's own, at its top) leaves it by `endRoom` at least.
    if (isEnd && Math.abs(above - first.y) < endRoom) return undefined;
    if (!isEnd && above <= first.y) return undefined;
    head.push(first, { x: first.x, y: above }, { x, y: above });
  }
  const tail =
    last.y > level + same
      ? [{ x, y: level }, { x: last.x, y: level }, last]
      : under === points.length - 1
        ? undefined
        : [{ x, y: last.y }, last];
  if (!tail) return undefined;
  return asLine(entry, [...points.slice(0, at), ...head, ...tail, ...points.slice(under + 1)]);
}

/** The line coming in from a side under the header, at `level`, rather than across the name. */
function underName(entry: Entry, level: number): Line | undefined {
  const { points, entry: at, under } = entry;
  const first = points[at] as Point;
  const last = points[under] as Point;
  const before = points[at - 1];
  // A bend whose stretch before comes down to it: that stretch goes on down to `level`.
  if (at === 0 || !before || !near(before.x, first.x) || before.y > level) return undefined;
  if (last.y < level + endRoom && under === points.length - 1) return undefined;
  const tail = last.y > level + same ? [{ x: last.x, y: level }, last] : [last];
  return asLine(entry, [
    ...points.slice(0, at),
    { x: first.x, y: level },
    ...tail,
    ...points.slice(under + 1),
  ]);
}

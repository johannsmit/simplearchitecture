import type { PlacedCard, PlacedHandle, Side } from './elkLayout';
import { absoluteBoxes, crossesAny, linkOfPort, portId, spacing } from './layoutGeometry';
import type { Box, Point } from './positions';

/**
 * Lines made straight where two cards face each other with room for it. A layout spreads a card's
 * ends evenly along a side before it knows where the other cards are, so most lines from a wide
 * card jog sideways on their way to a card under it. This moves such a line's ends along their
 * sides until they line up. Used after the automatic layout and for lines without a route. Pure.
 */

/** Room kept between a straightened line's end and its card's corner. */
export const cornerRoom = 8;

export const opposite: Record<Side, Side> = {
  left: 'right',
  right: 'left',
  top: 'bottom',
  bottom: 'top',
};

const upright = (side: Side) => side === 'left' || side === 'right';

/** One end of a line: the card, its side and the distance along it (as `PlacedHandle.offset`). */
export interface SideEnd {
  card: string;
  side: Side;
  offset: number;
}

export interface StraightCandidate {
  id: string;
  start: SideEnd;
  end: SideEnd;
}

/** Where a box's side starts along the axis across the line, and how long it is. */
const along = (box: Box, side: Side) =>
  upright(side) ? { from: box.y, length: box.height } : { from: box.x, length: box.width };

/** The point of an end on the canvas. */
export function pointOfEnd(box: Box, side: Side, offset: number): Point {
  switch (side) {
    case 'left':
      return { x: box.x, y: box.y + offset };
    case 'right':
      return { x: box.x + box.width, y: box.y + offset };
    case 'top':
      return { x: box.x + offset, y: box.y };
    case 'bottom':
      return { x: box.x + offset, y: box.y + box.height };
  }
}

/** How far apart two cards are in the direction a line leaves `from` by `side`. */
function gapBetween(from: Box, to: Box, side: Side): number {
  switch (side) {
    case 'bottom':
      return to.y - (from.y + from.height);
    case 'top':
      return from.y - (to.y + to.height);
    case 'right':
      return to.x - (from.x + from.width);
    case 'left':
      return from.x - (to.x + to.width);
  }
}

/**
 * Where, across a line leaving `from` by `side` into `to` on the opposite side, both cards have room
 * for it with `cornerRoom` from their corners. Undefined when the cards don't face each other there.
 */
export function straightRoom(
  from: Box,
  side: Side,
  to: Box,
): { low: number; high: number } | undefined {
  if (gapBetween(from, to, side) <= 0) return undefined;
  const a = along(from, side);
  const b = along(to, side);
  const low = Math.max(a.from, b.from) + cornerRoom;
  const high = Math.min(a.from + a.length, b.from + b.length) - cornerRoom;
  return low <= high ? { low, high } : undefined;
}

interface Mark {
  /** The line's end it stands for, or undefined for an end that stays. */
  owner?: string;
  offset: number;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * New places for the ends of lines that can run straight, by line id, as offsets along their sides.
 * A line qualifies when it leaves one card and enters another on facing sides, and the cards
 * overlap across it. The end on the side with fewer ends moves first, to line up with the other
 * end; else the other end moves; else both move to a place within the overlap. Every end keeps
 * `spacing.ports` from the other ends on its side and its place in their order, so no lines cross
 * that didn't, and keeps `cornerRoom` from the corners. Lines are taken in id order; a line that
 * can't be made straight isn't in the answer.
 *
 * `fixed` holds other ends that stay where they are, by card. `allows` is asked about each straight
 * line in turn (say, whether it runs through a card), and the first it allows is taken.
 */
export function straightEnds(
  lines: readonly StraightCandidate[],
  boxes: ReadonlyMap<string, Box>,
  fixed: ReadonlyMap<string, readonly { side: Side; offset: number }[]>,
  allows: (line: StraightCandidate, from: Point, to: Point) => boolean,
): Map<string, { start: number; end: number }> {
  const marks = new Map<string, Mark[]>();
  const keyOf = (card: string, side: Side) => `${card}\n${side}`;
  const add = (card: string, side: Side, mark: Mark) => {
    const key = keyOf(card, side);
    marks.set(key, [...(marks.get(key) ?? []), mark]);
  };
  for (const [card, ends] of fixed) {
    for (const end of ends) add(card, end.side, { offset: end.offset });
  }
  const own = new Map<string, Mark>();
  for (const line of lines) {
    for (const [which, end] of [
      ['start', line.start],
      ['end', line.end],
    ] as const) {
      const mark = { owner: `${line.id}\n${which}`, offset: end.offset };
      own.set(mark.owner, mark);
      add(end.card, end.side, mark);
    }
  }
  for (const list of marks.values()) {
    list.sort((a, b) => a.offset - b.offset || byText(a.owner ?? '', b.owner ?? ''));
  }
  /** Where an end may go along its side, on the canvas's axis, keeping its order and spacing. */
  const roomOf = (end: SideEnd, mark: Mark, box: Box) => {
    const list = marks.get(keyOf(end.card, end.side)) ?? [];
    const index = list.indexOf(mark);
    const before = list[index - 1];
    const after = list[index + 1];
    const { from, length } = along(box, end.side);
    return {
      low: from + Math.max(cornerRoom, before ? before.offset + spacing.ports : -Infinity),
      high: from + Math.min(length - cornerRoom, after ? after.offset - spacing.ports : Infinity),
      count: list.length,
    };
  };

  const result = new Map<string, { start: number; end: number }>();
  const ordered = [...lines].sort((a, b) => byText(a.id, b.id));
  for (const line of ordered) {
    const { start, end } = line;
    const source = boxes.get(start.card);
    const target = boxes.get(end.card);
    if (!source || !target || start.side !== opposite[end.side]) continue;
    const room = straightRoom(source, start.side, target);
    if (!room) continue;
    const startMark = own.get(`${line.id}\nstart`) as Mark;
    const endMark = own.get(`${line.id}\nend`) as Mark;
    const startFrom = along(source, start.side).from;
    const endFrom = along(target, end.side).from;
    const startAt = startFrom + startMark.offset;
    const endAt = endFrom + endMark.offset;
    if (Math.abs(startAt - endAt) < 0.5) continue;
    const startRoom = roomOf(start, startMark, source);
    const endRoom = roomOf(end, endMark, target);
    const fits = (value: number, ...ranges: { low: number; high: number }[]) =>
      ranges.every((range) => value >= range.low && value <= range.high);
    // The places to try, in order: one end lined up with the other, then both within the overlap.
    const places: number[] = [];
    const ends = [
      { room: endRoom, other: startAt },
      { room: startRoom, other: endAt },
    ].sort((a, b) => a.room.count - b.room.count);
    for (const each of ends) if (fits(each.other, room, each.room)) places.push(each.other);
    const low = Math.max(room.low, startRoom.low, endRoom.low);
    const high = Math.min(room.high, startRoom.high, endRoom.high);
    if (low <= high) places.push(clamp((startAt + endAt) / 2, low, high));
    for (const place of places) {
      const from = pointOfEnd(source, start.side, place - startFrom);
      const to = pointOfEnd(target, end.side, place - endFrom);
      if (!allows(line, from, to)) continue;
      startMark.offset = place - startFrom;
      endMark.offset = place - endFrom;
      result.set(line.id, { start: startMark.offset, end: endMark.offset });
      break;
    }
  }
  return result;
}

/**
 * The automatic layout with its lines made straight where they can be (`straightEnds`): the ends
 * move along their sides and the route loses its bends. Only lines ELK routed between two cards in
 * the same container (or both at the top level) are taken: a line into a container comes in beside
 * its name, and a circle's ends sit on its circle (`skip`), so those keep their routes. The other
 * routed ends stay where they are and are kept clear of. A straight line runs through no card and
 * crosses no more of the other lines than its route did. Cards don't move.
 */
export function straightLaid(
  placed: ReadonlyMap<string, PlacedCard>,
  skip: (id: string) => boolean,
): Map<string, PlacedCard> {
  const boxes = absoluteBoxes(placed);
  const handles = new Map<string, { card: string; handle: PlacedHandle }>();
  for (const card of placed.values()) {
    for (const handle of card.handles) handles.set(handle.id, { card: card.id, handle });
  }
  const candidates: StraightCandidate[] = [];
  const fixed = new Map<string, { side: Side; offset: number }[]>();
  const keep = (card: string, handle: PlacedHandle) => {
    fixed.set(card, [...(fixed.get(card) ?? []), handle]);
  };
  for (const card of placed.values()) {
    for (const handle of card.handles) {
      if (!handle.route) continue;
      const link = linkOfPort(handle.id);
      const target = handles.get(portId(link, 'target'));
      if (!target) continue;
      const together = placed.get(target.card)?.parent === card.parent;
      if (!together || skip(card.id) || skip(target.card)) {
        keep(card.id, handle);
        keep(target.card, target.handle);
        continue;
      }
      candidates.push({
        id: link,
        start: { card: card.id, side: handle.side, offset: handle.offset },
        end: { card: target.card, side: target.handle.side, offset: target.handle.offset },
      });
    }
  }
  const ancestorsOf = (id: string) => {
    const chain = new Set<string>();
    for (let up = placed.get(id)?.parent; up !== undefined && !chain.has(up);) {
      chain.add(up);
      up = placed.get(up)?.parent;
    }
    return chain;
  };
  // Every routed line as drawn, kept up to date as lines are made straight.
  const drawn = new Map<string, Point[]>();
  for (const card of placed.values()) {
    const box = boxes.get(card.id) as Box;
    for (const handle of card.handles) {
      const target = handle.route && handles.get(portId(linkOfPort(handle.id), 'target'));
      const targetBox = target && boxes.get(target.card);
      if (!handle.route || !target || !targetBox) continue;
      drawn.set(linkOfPort(handle.id), [
        pointOfEnd(box, handle.side, handle.offset),
        ...handle.route.bends.map((bend) => ({ x: bend.x + box.x, y: bend.y + box.y })),
        pointOfEnd(targetBox, target.handle.side, target.handle.offset),
      ]);
    }
  }
  const crossingsOf = (id: string, line: readonly Point[]) => {
    let count = 0;
    for (const [other, points] of drawn) if (other !== id) count += crossingCount(line, points);
    return count;
  };
  const straight = straightEnds(candidates, boxes, fixed, (line, from, to) => {
    const own = new Set([
      line.start.card,
      line.end.card,
      ...ancestorsOf(line.start.card),
      ...ancestorsOf(line.end.card),
    ]);
    const others = [...boxes].filter(([id]) => !own.has(id)).map(([, box]) => box);
    if (crossesAny([from, to], others)) return false;
    if (crossingsOf(line.id, [from, to]) > crossingsOf(line.id, drawn.get(line.id) ?? [])) {
      return false;
    }
    drawn.set(line.id, [from, to]);
    return true;
  });
  if (straight.size === 0) return new Map(placed);
  const result = new Map<string, PlacedCard>();
  for (const [id, card] of placed) {
    result.set(id, {
      ...card,
      handles: card.handles.map((handle) => {
        const offsets = straight.get(linkOfPort(handle.id));
        if (!offsets) return handle;
        if (handle.kind === 'target') return { ...handle, offset: offsets.end };
        if (!handle.route) return handle;
        return { ...handle, offset: offsets.start, route: { ...handle.route, bends: [] } };
      }),
    });
  }
  return result;
}

/** How many times two right-angled lines cross each other, one stretch across the other. */
export function crossingCount(one: readonly Point[], two: readonly Point[]): number {
  let count = 0;
  for (let i = 1; i < one.length; i++) {
    for (let j = 1; j < two.length; j++) {
      const [a, b] = [one[i - 1] as Point, one[i] as Point];
      const [c, d] = [two[j - 1] as Point, two[j] as Point];
      const [upright, across] =
        a.x === b.x
          ? [
              [a, b],
              [c, d],
            ]
          : [
              [c, d],
              [a, b],
            ];
      const [u0, u1] = upright as [Point, Point];
      const [h0, h1] = across as [Point, Point];
      if (u0.x !== u1.x || h0.y !== h1.y || u0.y === u1.y || h0.x === h1.x) continue;
      const inside = (value: number, p: number, q: number) =>
        value > Math.min(p, q) && value < Math.max(p, q);
      if (inside(u0.x, h0.x, h1.x) && inside(h0.y, u0.y, u1.y)) count++;
    }
  }
  return count;
}

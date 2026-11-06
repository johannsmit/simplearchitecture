import {
  absoluteBoxes,
  containerBox,
  portId,
  spacing,
  type PlacedCard,
  type PlacedHandle,
  type Side,
} from './elkLayout';
import type { Box, Point } from './positions';

/**
 * Changes to the canvas without a new layout: cards that come and go, and new lines. Every card
 * already drawn keeps its place; a new card goes to a free spot, and a container grows to hold a
 * new card. Only Tidy up (and a new canvas) lays everything out again with ELK. Pure, so it is
 * tested without a browser.
 */

interface Size {
  width: number;
  height: number;
}

/** Where a new card should go: at a point on the canvas, or next to a card already there. */
export type PlaceHint = { at: Point } | { near: string };

export interface KeepInput {
  /** The cards as drawn now (moved ones where the user put them), parents first. */
  previous: ReadonlyMap<string, PlacedCard>;
  /** The cards drawn as containers now. */
  previousContainers: ReadonlySet<string>;
  /** Every card to draw, in the canvas's order, with the container it belongs inside, if any. */
  cards: readonly { id: string; parent?: string | undefined }[];
  /** The relationships on the canvas: a new card goes next to a card it is related to. */
  related: readonly { source: string; target: string }[];
  /** A card's smallest size, as a card or as a container. */
  sizeOf: (id: string, container: boolean) => Size;
  hints: ReadonlyMap<string, PlaceHint>;
  /** Where a card with no hint and no related card goes: the middle of the view. */
  centre: Point;
}

export interface Kept {
  /** Parents first; positions relative to the container, as from the layout. */
  placed: Map<string, PlacedCard>;
  containers: Set<string>;
}

/** Between a new card and the cards around it, as in the layout. */
const gap = spacing.cards;
/** A grown container keeps at least this far from the cards beside it. */
const clearance = 12;

function overlaps(a: Box, b: Box, room: number): boolean {
  return (
    a.x < b.x + b.width + room &&
    b.x < a.x + a.width + room &&
    a.y < b.y + b.height + room &&
    b.y < a.y + a.height + room
  );
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Top left corners for a box of `size` right next to each of `boxes` (and at `preferred` itself),
 * nearest to `preferred` first.
 */
function candidates(boxes: readonly Box[], size: Size, preferred: Point): Point[] {
  const result = [preferred];
  for (const box of boxes) {
    const right = box.x + box.width + gap;
    const left = box.x - size.width - gap;
    const below = box.y + box.height + gap;
    const above = box.y - size.height - gap;
    result.push(
      { x: right, y: box.y },
      { x: left, y: box.y },
      { x: box.x, y: below },
      { x: box.x, y: above },
      { x: right, y: preferred.y },
      { x: left, y: preferred.y },
      { x: preferred.x, y: below },
      { x: preferred.x, y: above },
    );
  }
  return result
    .map((point, index) => ({ point, index, away: distance(point, preferred) }))
    .sort((a, b) => a.away - b.away || a.index - b.index)
    .map(({ point }) => point);
}

/**
 * The free spot nearest to `preferred` for a box of `size`: it covers none of `boxes` and keeps
 * the layout's spacing from them. There is always one: right of the rightmost box.
 */
export function freeSpot(boxes: readonly Box[], size: Size, preferred: Point): Point {
  for (const point of candidates(boxes, size, preferred)) {
    if (!boxes.some((box) => overlaps({ ...point, ...size }, box, gap))) return point;
  }
  return preferred;
}

const boxOf = (card: PlacedCard): Box => ({
  x: card.x,
  y: card.y,
  width: card.width,
  height: card.height,
});

function absoluteOf(work: ReadonlyMap<string, PlacedCard>, id: string): Box | undefined {
  const card = work.get(id);
  if (!card) return undefined;
  let { x, y } = card;
  for (let up = card.parent; up !== undefined; up = work.get(up)?.parent) {
    const parent = work.get(up);
    if (!parent) break;
    x += parent.x;
    y += parent.y;
  }
  return { x, y, width: card.width, height: card.height };
}

const membersOf = (work: ReadonlyMap<string, PlacedCard>, parent: string | undefined) =>
  [...work.values()].filter((card) => card.parent === parent);

/**
 * Grows a container to hold its cards (and to `min`), then the containers it is in. False when a
 * grown container would come too close to a card beside it: nothing else moves to make room.
 */
function grow(work: Map<string, PlacedCard>, id: string, min: Size): boolean {
  const { padding } = containerBox;
  let first = true;
  for (let at: string | undefined = id; at !== undefined; at = work.get(at)?.parent) {
    const box = work.get(at);
    if (!box) return true;
    const inside = membersOf(work, at);
    const width = Math.max(
      box.width,
      first ? min.width : 0,
      ...inside.map((card) => card.x + card.width + padding.right),
    );
    const height = Math.max(
      box.height,
      first ? min.height : 0,
      ...inside.map((card) => card.y + card.height + padding.bottom),
    );
    first = false;
    if (width === box.width && height === box.height) return true;
    const grown = { ...box, width, height };
    work.set(at, grown);
    const beside = membersOf(work, box.parent).filter((card) => card.id !== at);
    if (beside.some((card) => overlaps(grown, boxOf(card), clearance))) return false;
  }
  return true;
}

/**
 * Puts a card (with what it holds) inside a container: at a free spot there, nearest to
 * `preferred` (relative to the container), growing the container when there is no room. False
 * when the container can't grow without covering another card.
 */
function placeInside(
  work: Map<string, PlacedCard>,
  parentId: string,
  card: PlacedCard,
  preferred: Point | undefined,
  min: Size,
): boolean {
  const parent = work.get(parentId);
  if (!parent) return false;
  const { padding } = containerBox;
  const start = { x: padding.left, y: padding.top };
  const inside = membersOf(work, parentId).map(boxOf);
  const want = preferred
    ? { x: Math.max(preferred.x, start.x), y: Math.max(preferred.y, start.y) }
    : start;
  const room = {
    width: Math.max(parent.width, min.width),
    height: Math.max(parent.height, min.height),
  };
  const options = [start, ...candidates(inside, card, want)]
    .filter(
      (point) =>
        point.x >= start.x &&
        point.y >= start.y &&
        !inside.some((box) => overlaps({ ...boxOf(card), ...point }, box, gap)),
    )
    .map((point) => {
      // How much the container would grow: none is best, then the least, then the nearest.
      const width = Math.max(room.width, point.x + card.width + padding.right);
      const height = Math.max(room.height, point.y + card.height + padding.bottom);
      return {
        point,
        growth: width * height - room.width * room.height,
        away: distance(point, want),
      };
    })
    .sort((a, b) => a.growth - b.growth || a.away - b.away);
  for (const { point } of options) {
    const trial = new Map(work);
    trial.set(card.id, { ...card, ...point, parent: parentId });
    if (grow(trial, parentId, min)) {
      for (const [id, placed] of trial) work.set(id, placed);
      return true;
    }
  }
  return false;
}

/**
 * The canvas after cards came or went, with no new layout. Cards already drawn stay exactly where
 * they are (a card whose container left, or whose Contains went, stays in place outside it, until
 * Tidy up). A new card goes to its hint's point, or next to its hinted or related card, or to the
 * middle of the view, at the nearest spot that covers no card; what it holds is packed inside it.
 * A new card that belongs in a container on the canvas goes into a free spot there, and the
 * container grows to fit; when growing would cover another card, the new card goes outside,
 * next to it. Handles come from `relinkHandles`.
 */
export function keepCards(input: KeepInput): Kept {
  const { previous, sizeOf } = input;
  const wanted = new Map<string, string>();
  for (const card of input.cards) if (card.parent !== undefined) wanted.set(card.id, card.parent);
  const present = new Set(input.cards.map((card) => card.id));
  const before = absoluteBoxes(previous);
  const work = new Map<string, PlacedCard>();

  // Cards already drawn: where they are, a little larger if their name grew.
  for (const card of previous.values()) {
    if (!present.has(card.id)) continue;
    const stays =
      card.parent !== undefined && wanted.get(card.id) === card.parent && work.has(card.parent);
    const at = stays ? card : (before.get(card.id) ?? card);
    const least = sizeOf(card.id, input.previousContainers.has(card.id));
    work.set(card.id, {
      id: card.id,
      x: at.x,
      y: at.y,
      ...(stays ? { parent: card.parent } : {}),
      width: Math.max(card.width, least.width),
      height: Math.max(card.height, least.height),
      handles: card.handles,
    });
  }
  const containers = new Set([...input.previousContainers].filter((id) => work.has(id)));

  // New cards: each goes in with the new cards it holds.
  const fresh = input.cards.filter((card) => !work.has(card.id)).map((card) => card.id);
  const freshSet = new Set(fresh);
  const heldBy = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of fresh) {
    const parent = wanted.get(id);
    if (parent !== undefined && freshSet.has(parent) && !loops(wanted, id, freshSet)) {
      heldBy.set(parent, [...(heldBy.get(parent) ?? []), id]);
    } else {
      roots.push(id);
    }
  }
  const packed = new Map<string, Box>();
  const pack = (id: string): Size => {
    const held = heldBy.get(id) ?? [];
    if (held.length === 0) return sizeOf(id, false);
    containers.add(id);
    const sizes = held.map((member) => ({ id: member, ...pack(member) }));
    const area = sizes.reduce((sum, size) => sum + size.width * size.height, 0);
    const rowWidth = Math.max(...sizes.map((size) => size.width), Math.sqrt(area * 1.6));
    const { padding } = containerBox;
    let [x, y, rowHeight, width] = [0, 0, 0, 0];
    for (const size of sizes) {
      if (x > 0 && x + size.width > rowWidth) {
        x = 0;
        y += rowHeight + gap;
        rowHeight = 0;
      }
      packed.set(size.id, { x: padding.left + x, y: padding.top + y, ...size });
      width = Math.max(width, x + size.width);
      rowHeight = Math.max(rowHeight, size.height);
      x += size.width + gap;
    }
    const least = sizeOf(id, true);
    return {
      width: Math.max(least.width, padding.left + width + padding.right),
      height: Math.max(least.height, padding.top + y + rowHeight + padding.bottom),
    };
  };
  const addHeld = (id: string) => {
    for (const member of heldBy.get(id) ?? []) {
      const box = packed.get(member);
      if (!box) continue;
      work.set(member, { id: member, ...box, parent: id, handles: [] });
      addHeld(member);
    }
  };

  for (const root of roots) {
    const size = pack(root);
    const card: PlacedCard = { id: root, x: 0, y: 0, ...size, handles: [] };
    const preferred = preferredPoint(input, work, root, heldBy, size);
    const parent = wanted.get(root);
    let inside = false;
    if (parent !== undefined && work.has(parent)) {
      const holder = absoluteOf(work, parent);
      const relative =
        preferred && holder ? { x: preferred.x - holder.x, y: preferred.y - holder.y } : undefined;
      const least = containers.has(parent) ? { width: 0, height: 0 } : sizeOf(parent, true);
      inside = placeInside(work, parent, card, relative, least);
      if (inside) containers.add(parent);
    }
    if (!inside) {
      const nearParent = parent === undefined ? undefined : absoluteOf(work, parent);
      const want =
        preferred ??
        (nearParent
          ? { x: nearParent.x + nearParent.width + gap, y: nearParent.y }
          : { x: input.centre.x - size.width / 2, y: input.centre.y - size.height / 2 });
      const tops = membersOf(work, undefined).map(boxOf);
      work.set(root, { ...card, ...freeSpot(tops, size, want) });
    }
    addHeld(root);
  }
  return { placed: parentsFirst(work, input.cards), containers };
}

/** True when following the containers from `id` among the new cards comes back to it. */
function loops(wanted: ReadonlyMap<string, string>, id: string, among: ReadonlySet<string>) {
  const seen = new Set([id]);
  for (let up = wanted.get(id); up !== undefined && among.has(up); up = wanted.get(up)) {
    if (seen.has(up)) return true;
    seen.add(up);
  }
  return false;
}

/** Where a new card (with what it holds) would like its top left corner, on the canvas. */
function preferredPoint(
  input: KeepInput,
  work: ReadonlyMap<string, PlacedCard>,
  root: string,
  heldBy: ReadonlyMap<string, readonly string[]>,
  size: Size,
): Point | undefined {
  const group: string[] = [];
  const collect = (id: string) => {
    group.push(id);
    for (const member of heldBy.get(id) ?? []) collect(member);
  };
  collect(root);
  const nextTo = (id: string): Point | undefined => {
    const box = absoluteOf(work, id);
    return box ? { x: box.x + box.width + gap, y: box.y } : undefined;
  };
  for (const id of group) {
    const hint = input.hints.get(id);
    if (!hint) continue;
    if ('at' in hint) {
      if (Number.isFinite(hint.at.x) && Number.isFinite(hint.at.y)) return hint.at;
      continue;
    }
    const point = nextTo(hint.near);
    if (point) return point;
  }
  const members = new Set(group);
  for (const link of input.related) {
    const other = members.has(link.source)
      ? link.target
      : members.has(link.target)
        ? link.source
        : undefined;
    if (other === undefined || members.has(other) || !work.has(other)) continue;
    // Next to a related card, unless that's the container it goes in.
    if (input.cards.find((card) => card.id === root)?.parent === other) continue;
    const point = nextTo(other);
    if (point) return point;
  }
  return input.cards.find((card) => card.id === root)?.parent === undefined
    ? { x: input.centre.x - size.width / 2, y: input.centre.y - size.height / 2 }
    : undefined;
}

/** Parents first, each level in the canvas's order (React Flow needs a parent before its cards). */
function parentsFirst(
  work: ReadonlyMap<string, PlacedCard>,
  order: readonly { id: string }[],
): Map<string, PlacedCard> {
  const rank = new Map(order.map((card, index) => [card.id, index]));
  const byParent = new Map<string | undefined, PlacedCard[]>();
  for (const card of work.values()) {
    const list = byParent.get(card.parent) ?? [];
    list.push(card);
    byParent.set(card.parent, list);
  }
  const result = new Map<string, PlacedCard>();
  const visit = (parent: string | undefined) => {
    const level = (byParent.get(parent) ?? []).sort(
      (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0),
    );
    for (const card of level) {
      result.set(card.id, card);
      visit(card.id);
    }
  };
  visit(undefined);
  return result;
}

export interface KeptLink {
  /** The layout link id (`l` and the relationship's place), which changes as relationships come and go. */
  id: string;
  /** The relationship it stands for: stays the same. */
  relationshipId: string;
  source: string;
  target: string;
}

/**
 * Each line's handles after a change: a line already drawn keeps its handles (and ELK's route, for
 * as long as its cards don't move), under its new id. A new line gets a handle on the side of each
 * card that faces the other card, at a free place along it; it is drawn the way a line is after a
 * card was dragged. Handles of lines that went are dropped.
 */
export function relinkHandles(
  placed: ReadonlyMap<string, PlacedCard>,
  /** Layout link id → relationship id, as when the handles were made. */
  previousLinks: ReadonlyMap<string, string>,
  links: readonly KeptLink[],
): Map<string, PlacedCard> {
  const byRelationship = new Map(links.map((link) => [link.relationshipId, link]));
  const result = new Map<string, PlacedCard>();
  for (const [id, card] of placed) {
    const handles = card.handles.flatMap((handle): PlacedHandle[] => {
      const end = handle.id.endsWith(':s') ? 'source' : 'target';
      const relationship = previousLinks.get(handle.id.slice(0, -2));
      const link = relationship === undefined ? undefined : byRelationship.get(relationship);
      if (!link || link[end] !== id || handle.kind !== end) return [];
      return [{ ...handle, id: portId(link.id, end) }];
    });
    result.set(id, { ...card, handles });
  }
  const boxes = absoluteBoxes(result);
  for (const link of links) {
    for (const end of ['source', 'target'] as const) {
      const id = link[end];
      const card = result.get(id);
      const box = boxes.get(id);
      const other = boxes.get(end === 'source' ? link.target : link.source);
      const handleId = portId(link.id, end);
      if (!card || !box || !other || card.handles.some((h) => h.id === handleId)) continue;
      const side = facingSide(box, other);
      const length = side === 'left' || side === 'right' ? card.height : card.width;
      result.set(id, {
        ...card,
        handles: [
          ...card.handles,
          { id: handleId, kind: end, side, offset: freeOffset(card.handles, side, length) },
        ],
      });
    }
  }
  return result;
}

/** The side of `from` that faces `to`. */
export function facingSide(from: Box, to: Box): Side {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) / (from.width + to.width) >= Math.abs(dy) / (from.height + to.height)) {
    return dx >= 0 ? 'right' : 'left';
  }
  return dy >= 0 ? 'bottom' : 'top';
}

/** A place along a side, as near its middle as keeps `spacing.ports` from the handles there. */
export function freeOffset(handles: readonly PlacedHandle[], side: Side, length: number): number {
  const taken = handles.filter((handle) => handle.side === side).map((handle) => handle.offset);
  const middle = length / 2;
  const free = (offset: number) =>
    offset >= 0 &&
    offset <= length &&
    taken.every((other) => Math.abs(other - offset) >= spacing.ports);
  for (let step = 0; step <= middle; step += spacing.ports) {
    if (free(middle + step)) return middle + step;
    if (free(middle - step)) return middle - step;
  }
  return middle;
}

/** True when two canvases draw the same cards at the same places, with the same handles. */
export function samePlacement(
  a: ReadonlyMap<string, PlacedCard>,
  b: ReadonlyMap<string, PlacedCard>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, card] of a) {
    const other = b.get(id);
    if (
      !other ||
      other.x !== card.x ||
      other.y !== card.y ||
      other.width !== card.width ||
      other.height !== card.height ||
      other.parent !== card.parent ||
      other.handles.length !== card.handles.length ||
      other.handles.some((handle, index) => handle.id !== card.handles[index]?.id)
    ) {
      return false;
    }
  }
  return true;
}

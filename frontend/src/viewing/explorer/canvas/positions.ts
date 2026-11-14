import type { NodeChange } from '@xyflow/react';
import { containerBox, spacing, type PlacedCard } from './elkLayout';
import type { Direction } from './view';

/**
 * Cards the user moved on the canvas (by mouse or keyboard). Positions live in memory, never in
 * the model, the URL or the browser's storage, and are dropped on a focus or depth change and by
 * "Tidy up". Only an open view saves where its cards are (`viewLayout.ts`). Pure, so it is tested
 * without a browser.
 */

export interface Point {
  x: number;
  y: number;
}

/** Where moved cards are, by element id (flow coordinates of the card's top left corner). */
export type MovedPositions = ReadonlyMap<string, Point>;

export const noMovedPositions: MovedPositions = new Map();

/** Room kept around a moved card: closer than this, a laid-out card counts as covered. */
const clearance = 12;

/** Keyboard move mode steps in pixels: arrow keys, and Shift + arrow keys. */
export const moveSteps = { small: 8, large: 40 } as const;

/** The drag threshold in pixels: less movement than this is a click, not a drag. */
export const dragThreshold = 4;

/** How far inside the visible canvas a card in keyboard move mode is kept, in pixels. */
export const keepInViewMargin = 24;

/**
 * The moved positions with one card moved to `point`, or put back in the layout when `point` is
 * undefined (a cancelled keyboard move of a card that hadn't moved before).
 */
export function withMovedCard(
  moved: MovedPositions,
  id: string,
  point: Point | undefined,
): MovedPositions {
  const next = new Map(moved);
  if (point) next.set(id, { x: point.x, y: point.y });
  else next.delete(id);
  return next;
}

/** True when a card on the canvas (one of `shown`) has been moved. */
export function hasMovedCards(moved: MovedPositions, shown: { has(id: string): boolean }): boolean {
  for (const id of moved.keys()) if (shown.has(id)) return true;
  return false;
}

/** A point moved one keyboard step in a direction. */
export function movedBy(point: Point, direction: Direction, step: number): Point {
  switch (direction) {
    case 'left':
      return { x: point.x - step, y: point.y };
    case 'right':
      return { x: point.x + step, y: point.y };
    case 'up':
      return { x: point.x, y: point.y - step };
    case 'down':
      return { x: point.x, y: point.y + step };
  }
}

/** The step of an arrow key in keyboard move mode: Shift makes it bigger. */
export function moveStep(keys: { shiftKey: boolean }): number {
  return keys.shiftKey ? moveSteps.large : moveSteps.small;
}

/** The key that starts and ends keyboard move mode, without Ctrl, Alt or Cmd. */
export function isMoveKey(keys: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean {
  return (keys.key === 'm' || keys.key === 'M') && !keys.altKey && !keys.ctrlKey && !keys.metaKey;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * The viewport panned just enough that a card stays `margin` pixels inside the visible canvas
 * (`size`, in screen pixels), or undefined when it already does. A card larger than the canvas
 * keeps its top left corner in view.
 */
export function panToKeepInView(
  box: Box,
  viewport: Viewport,
  size: { width: number; height: number },
  margin = keepInViewMargin,
): Viewport | undefined {
  if (size.width <= 0 || size.height <= 0) return undefined;
  const shift = (start: number, length: number, room: number): number => {
    if (start < margin) return margin - start;
    if (start + length > room - margin)
      return Math.max(room - margin - (start + length), margin - start);
    return 0;
  };
  const dx = shift(box.x * viewport.zoom + viewport.x, box.width * viewport.zoom, size.width);
  const dy = shift(box.y * viewport.zoom + viewport.y, box.height * viewport.zoom, size.height);
  if (dx === 0 && dy === 0) return undefined;
  return { x: viewport.x + dx, y: viewport.y + dy, zoom: viewport.zoom };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width + clearance &&
    b.x < a.x + a.width + clearance &&
    a.y < b.y + b.height + clearance &&
    b.y < a.y + a.height + clearance
  );
}

/**
 * A position for a card inside its container: left and up, it stops at the content area (16px
 * from the side, 56px from the top, so it never covers the header), as the container's corner
 * stays where it is; right and down, the container grows to hold it (`fitContainers`).
 */
export function clampToContainer(point: Point): Point {
  const { padding } = containerBox;
  return { x: Math.max(padding.left, point.x), y: Math.max(padding.top, point.y) };
}

interface Size {
  width: number;
  height: number;
}

/** The card being dragged (or moved with the keyboard), and every card's size when that started. */
export interface Holding {
  id: string;
  sizes: ReadonlyMap<string, Size>;
}

export interface FitOptions {
  /** A container's smallest size (room for its name); default: the smallest container. */
  minSizeOf?: (id: string) => Size;
  /** Until the drop, the containers the held card is in only grow: nothing else moves in them. */
  holding?: Holding | undefined;
}

const smallestContainer: Size = { width: containerBox.minWidth, height: containerBox.minHeight };

/** Less than this is no shift: so a fitted container stays put, whatever the rounding. */
const tolerance = 1e-6;

/**
 * Cards with the containers in `which` fitted to what they hold, the innermost first: each
 * container's cards move up and left together until the topmost and leftmost reach its padding,
 * and the container is just big enough for them (and its name). The container's own corner stays
 * where it is, and nothing outside it moves. A container the held card is in keeps its cards
 * where they are and only grows, from its size when the hold started.
 */
export function fitContainers(
  cards: ReadonlyMap<string, PlacedCard>,
  which: Iterable<string>,
  options: FitOptions = {},
): Map<string, PlacedCard> {
  const result = new Map(cards);
  const { padding } = containerBox;
  const chainOf = (id: string): string[] => {
    const chain: string[] = [];
    for (let up = cards.get(id)?.parent; up !== undefined && !chain.includes(up);) {
      chain.push(up);
      up = cards.get(up)?.parent;
    }
    return chain;
  };
  const held = new Set(options.holding ? chainOf(options.holding.id) : []);
  const depth = new Map([...new Set(which)].map((id) => [id, chainOf(id).length]));
  const innermostFirst = [...depth.keys()]
    .filter((id) => cards.has(id))
    .sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0));
  for (const id of innermostFirst) {
    const box = result.get(id) as PlacedCard;
    const members = [...result.values()].filter((card) => card.parent === id);
    const holds = held.has(id);
    const shift = (lowest: number, edge: number) =>
      holds || Math.abs(edge - lowest) < tolerance ? 0 : edge - lowest;
    // A container left with no cards is just big enough for its name.
    const dx = members.length === 0 ? 0 : shift(Math.min(...members.map((c) => c.x)), padding.left);
    const dy = members.length === 0 ? 0 : shift(Math.min(...members.map((c) => c.y)), padding.top);
    let [right, bottom] = [0, 0];
    for (const card of members) {
      const x = card.x + dx;
      const y = card.y + dy;
      if (dx !== 0 || dy !== 0) result.set(card.id, { ...card, x, y });
      right = Math.max(right, x + card.width);
      bottom = Math.max(bottom, y + card.height);
    }
    const least = holds
      ? (options.holding?.sizes.get(id) ?? box)
      : (options.minSizeOf?.(id) ?? smallestContainer);
    const width = members.length === 0 ? least.width : Math.max(least.width, right + padding.right);
    const height =
      members.length === 0 ? least.height : Math.max(least.height, bottom + padding.bottom);
    if (width !== box.width || height !== box.height) result.set(id, { ...box, width, height });
  }
  return result;
}

/**
 * Where each card is drawn. Moved cards are where the user put them (a card inside a container,
 * relative to it, never left of or above its content area); the containers they are in fit what
 * they hold (`fitContainers`), and while a card is held, those only grow. The other top-level
 * cards are where the layout put them, except that a card a moved card would cover is pushed
 * straight down, just below it; cards further down that way move along with it, so nothing ends
 * up covered. A container that grows pushes nothing. Returns `placed` itself when no shown card
 * has moved.
 */
export function arrangeCards(
  placed: ReadonlyMap<string, PlacedCard>,
  moved: MovedPositions,
  options: FitOptions = {},
): ReadonlyMap<string, PlacedCard> {
  if (!hasMovedCards(moved, placed)) return placed;
  const result = new Map<string, PlacedCard>();
  const taken: Box[] = [];
  // The containers a moved card is in, at any depth: they fit again.
  const touched = new Set<string>();
  for (const card of placed.values()) {
    const point = moved.get(card.id);
    if (!point) continue;
    const parent = card.parent === undefined ? undefined : placed.get(card.parent);
    const at = { ...card, ...(parent ? clampToContainer(point) : point) };
    result.set(card.id, at);
    if (!parent) taken.push(at);
    for (let up = parent; up && !touched.has(up.id);) {
      touched.add(up.id);
      up = up.parent === undefined ? undefined : placed.get(up.parent);
    }
  }
  for (const card of placed.values()) {
    if (card.parent !== undefined && !result.has(card.id)) result.set(card.id, card);
  }
  const rest = [...placed.values()]
    .filter((card) => !moved.has(card.id) && card.parent === undefined)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const card of rest) {
    const box = { x: card.x, y: card.y, width: card.width, height: card.height };
    // Each step moves the card below one box, and never up again, so this ends.
    for (let blocker = taken.find((t) => overlaps(box, t)); blocker;) {
      box.y = blocker.y + blocker.height + spacing.cards;
      blocker = taken.find((t) => overlaps(box, t));
    }
    taken.push(box);
    result.set(card.id, box.y === card.y ? card : { ...card, y: box.y });
  }
  // Keep the layout's order, so React Flow's node order doesn't change.
  const ordered = new Map([...placed.keys()].map((id) => [id, result.get(id) as PlacedCard]));
  return touched.size === 0 ? ordered : fitContainers(ordered, touched, options);
}

/**
 * After a drop inside a container: the cards beside the outermost container it is in that the
 * container, grown, now covers (and didn't at its size when the hold started), pushed straight
 * down just below it, with the cards further down that way along with them, as a dropped card
 * pushes the cards it lands on. Their new top left corners, by id; none for a top-level card.
 * Nothing moves up.
 */
export function pushedByContainer(
  shown: ReadonlyMap<string, PlacedCard>,
  id: string,
  sizesBefore: ReadonlyMap<string, Size>,
): Map<string, Point> {
  const pushed = new Map<string, Point>();
  let top = shown.get(id);
  if (top?.parent === undefined) return pushed;
  for (const seen = new Set<string>(); top.parent !== undefined && !seen.has(top.id);) {
    seen.add(top.id);
    const up = shown.get(top.parent);
    if (!up) return pushed;
    top = up;
  }
  const grown: Box = { x: top.x, y: top.y, width: top.width, height: top.height };
  const was: Box = { ...grown, ...sizesBefore.get(top.id) };
  const pushers: Box[] = [grown];
  const stay: Box[] = [];
  const others = [...shown.values()]
    .filter((card) => card.parent === undefined && card.id !== top.id)
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const card of others) {
    const box = { x: card.x, y: card.y, width: card.width, height: card.height };
    const hit = pushers.some(
      (pusher) => overlaps(box, pusher) && (pusher !== grown || !overlaps(box, was)),
    );
    if (!hit) {
      stay.push(box);
      continue;
    }
    // Each step moves the card below one box, and never up again, so this ends.
    for (let blocker = pushers.find((t) => overlaps(box, t)); blocker;) {
      box.y = blocker.y + blocker.height + spacing.cards;
      blocker = [...pushers, ...stay].find((t) => overlaps(box, t));
    }
    pushers.push(box);
    pushed.set(card.id, { x: box.x, y: box.y });
  }
  return pushed;
}

/**
 * The cards React Flow reports as dragged, as [element id, position]. Other changes (sizes,
 * selection) are ignored: the canvas owns its nodes.
 */
export function draggedPositions(
  changes: readonly NodeChange[],
  elementIdOf: (flowId: string) => string | undefined,
): [string, Point][] {
  const result: [string, Point][] = [];
  for (const change of changes) {
    if (change.type !== 'position' || !change.position) continue;
    const id = elementIdOf(change.id);
    if (id !== undefined) result.push([id, change.position]);
  }
  return result;
}

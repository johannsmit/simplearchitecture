import type { NodeChange } from '@xyflow/react';
import type { PlacedCard } from './elkLayout';
import { frameOf, isGroupId, spacing } from './layoutGeometry';
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

/**
 * Room kept between the panels at the top left (Show Viewpoints, Group by) and the cards a fit or
 * keyboard focus puts beside them.
 */
const panelClearance = 12;

/** The padding of a fit, in pixels per side, as React Flow's `fitView` takes it. */
export interface FitPadding {
  top: `${number}px`;
  right: `${number}px`;
  bottom: `${number}px`;
  left: `${number}px`;
}

const px = (pixels: number) => `${String(pixels)}px` as `${number}px`;

/**
 * The padding that fits the drawing (`bounds`, flow coordinates) on a canvas of `size` with every
 * card clear of the panels (`panel`, their column's box, screen pixels from the canvas's top left).
 * Of a fit below the panel and one beside it, the one with the larger zoom: a wide drawing loses
 * nothing to a tall panel, and a tall one nothing to a wide panel. The other sides keep 6.5% (what a padding of 0.15
 * gives). Without a panel to keep clear of, 6.5% all round.
 */
export function clearFitPadding(
  bounds: Box,
  size: { width: number; height: number },
  panel: Box | undefined,
  zoom: { min: number; max: number },
): FitPadding {
  const side = Math.floor(size.width * 0.065);
  const end = Math.floor(size.height * 0.065);
  const base = { top: end, right: side, bottom: end, left: side };
  const inPixels = (padding: typeof base): FitPadding => ({
    top: px(padding.top),
    right: px(padding.right),
    bottom: px(padding.bottom),
    left: px(padding.left),
  });
  if (!panel || panel.width <= 0 || panel.height <= 0) return inPixels(base);
  const below = { ...base, top: Math.max(end, panel.y + panel.height + panelClearance) };
  const beside = { ...base, left: Math.max(side, panel.x + panel.width + panelClearance) };
  const zoomWith = (padding: typeof base): number => {
    const across = (size.width - padding.left - padding.right) / Math.max(1, bounds.width);
    const down = (size.height - padding.top - padding.bottom) / Math.max(1, bounds.height);
    return Math.min(zoom.max, Math.max(zoom.min, Math.min(across, down)));
  };
  return inPixels(zoomWith(beside) > zoomWith(below) ? beside : below);
}

/**
 * The viewport panned so a card (`box`, flow coordinates) is no longer under the panels
 * (`panel`, screen pixels from the canvas's top left), down or right, whichever is the shorter
 * way; undefined when nothing of it is under the panel.
 */
export function panClearOf(
  box: Box,
  viewport: Viewport,
  panel: Box,
  margin = panelClearance,
): Viewport | undefined {
  if (panel.width <= 0 || panel.height <= 0) return undefined;
  const left = box.x * viewport.zoom + viewport.x;
  const top = box.y * viewport.zoom + viewport.y;
  const under =
    left < panel.x + panel.width &&
    left + box.width * viewport.zoom > panel.x &&
    top < panel.y + panel.height &&
    top + box.height * viewport.zoom > panel.y;
  if (!under) return undefined;
  const down = panel.y + panel.height + margin - top;
  const right = panel.x + panel.width + margin - left;
  return down <= right
    ? { ...viewport, y: viewport.y + down }
    : { ...viewport, x: viewport.x + right };
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
 * A position for a card inside its container (or group box, `parent`): left and up, it stops at
 * the content area (a container's 16px from the side and 56px from the top, a group's 16px and
 * 48px, so it never covers the header), as the box's corner stays where it is; right and down, the
 * box grows to hold it (`fitContainers`).
 */
export function clampToContainer(point: Point, parent?: string): Point {
  const { padding } = frameOf(parent);
  return { x: Math.max(padding.left, point.x), y: Math.max(padding.top, point.y) };
}

/** Whether a card's level is one where cards push each other: the top level, or a group box. */
const pushes = (card: { parent?: string | undefined }): boolean =>
  card.parent === undefined || isGroupId(card.parent);

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
    const { padding, minWidth, minHeight } = frameOf(id);
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
      : (options.minSizeOf?.(id) ?? { width: minWidth, height: minHeight });
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
 * up covered. A group box is the top level for its cards: they push each other the same way, and
 * a moved group box pushes the boxes beside it. A container that grows pushes nothing. Returns
 * `placed` itself when no shown card has moved.
 */
export function arrangeCards(
  placed: ReadonlyMap<string, PlacedCard>,
  moved: MovedPositions,
  options: FitOptions = {},
): ReadonlyMap<string, PlacedCard> {
  if (!hasMovedCards(moved, placed)) return placed;
  const result = new Map<string, PlacedCard>();
  // Per level that pushes (the top level, each group box): the boxes placed there so far.
  const taken = new Map<string | undefined, Box[]>();
  const takenAt = (level: string | undefined): Box[] => {
    const list = taken.get(level) ?? [];
    taken.set(level, list);
    return list;
  };
  // The containers a moved card is in, at any depth: they fit again.
  const touched = new Set<string>();
  for (const card of placed.values()) {
    const point = moved.get(card.id);
    if (!point) continue;
    const parent = card.parent === undefined ? undefined : placed.get(card.parent);
    const at = { ...card, ...(parent ? clampToContainer(point, parent.id) : point) };
    result.set(card.id, at);
    if (pushes(card)) takenAt(card.parent).push(at);
    for (let up = parent; up && !touched.has(up.id);) {
      touched.add(up.id);
      up = up.parent === undefined ? undefined : placed.get(up.parent);
    }
  }
  for (const card of placed.values()) {
    if (!pushes(card) && !result.has(card.id)) result.set(card.id, card);
  }
  const rest = [...placed.values()]
    .filter((card) => !moved.has(card.id) && pushes(card))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (const card of rest) {
    const level = takenAt(card.parent);
    const box = { x: card.x, y: card.y, width: card.width, height: card.height };
    // Each step moves the card below one box, and never up again, so this ends.
    for (let blocker = level.find((t) => overlaps(box, t)); blocker;) {
      box.y = blocker.y + blocker.height + spacing.cards;
      blocker = level.find((t) => overlaps(box, t));
    }
    level.push(box);
    result.set(card.id, box.y === card.y ? card : { ...card, y: box.y });
  }
  // Keep the layout's order, so React Flow's node order doesn't change.
  const ordered = new Map([...placed.keys()].map((id) => [id, result.get(id) as PlacedCard]));
  return touched.size === 0 ? ordered : fitContainers(ordered, touched, options);
}

/**
 * The boxes `grown` now covers (and didn't at its size `was`), among `others` at its level,
 * pushed straight down just below it, with the boxes further down that way along with them, as a
 * dropped card pushes the cards it lands on. Their new top left corners, by id. Nothing moves up.
 */
export function pushedBelow(
  grown: Box,
  was: Box,
  others: readonly (Box & { id: string })[],
): Map<string, Point> {
  const pushed = new Map<string, Point>();
  const pushers: Box[] = [grown];
  const stay: Box[] = [];
  const sorted = [...others].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const card of sorted) {
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
 * After a drop inside a container: the cards beside the outermost container it is in that the
 * container, grown, now covers (and didn't at its size when the hold started), pushed straight
 * down (`pushedBelow`). In a group box, that is done among the group's cards, and the group box,
 * grown (with the cards it pushed), does the same among the boxes beside it. Their new top left
 * corners (relative to their group box, for its cards), by id; none for a top-level card.
 */
export function pushedByContainer(
  shown: ReadonlyMap<string, PlacedCard>,
  id: string,
  sizesBefore: ReadonlyMap<string, Size>,
): Map<string, Point> {
  const pushed = new Map<string, Point>();
  const chain: PlacedCard[] = [];
  for (let at = shown.get(id); at && !chain.includes(at);) {
    chain.push(at);
    at = at.parent === undefined ? undefined : shown.get(at.parent);
  }
  const boxOf = (card: PlacedCard): Box => ({
    x: card.x,
    y: card.y,
    width: card.width,
    height: card.height,
  });
  const levelOf = (level: string | undefined, without: string) =>
    [...shown.values()]
      .filter((card) => card.parent === level && card.id !== without)
      .map((card) => ({ id: card.id, ...boxOf(card) }));
  // The outermost container under a group box (or at the top level): it pushes at its level.
  const top = chain[chain.length - 1];
  const group = top !== undefined && isGroupId(top.id) && chain.length > 1 ? top : undefined;
  const outer = group ? chain[chain.length - 2] : top;
  if (!outer || outer.id === id) {
    if (!group) return pushed;
  } else {
    const grown = boxOf(outer);
    const was: Box = { ...grown, ...sizesBefore.get(outer.id) };
    for (const [key, point] of pushedBelow(grown, was, levelOf(outer.parent, outer.id))) {
      pushed.set(key, point);
    }
  }
  if (!group) return pushed;
  // The group box with the cards it pushed, as it will fit them.
  const { padding } = frameOf(group.id);
  let { width, height } = group;
  for (const card of levelOf(group.id, '')) {
    const at = pushed.get(card.id) ?? card;
    width = Math.max(width, at.x + card.width + padding.right);
    height = Math.max(height, at.y + card.height + padding.bottom);
  }
  const grown: Box = { x: group.x, y: group.y, width, height };
  const was: Box = { ...boxOf(group), ...sizesBefore.get(group.id) };
  for (const [key, point] of pushedBelow(grown, was, levelOf(undefined, group.id))) {
    pushed.set(key, point);
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

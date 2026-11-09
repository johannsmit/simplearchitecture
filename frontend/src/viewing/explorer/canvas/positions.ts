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
 * A position for a card inside its container: within the content area (16px from the sides and
 * the bottom, 56px from the top, so it never covers the header). The container doesn't change
 * size.
 */
export function clampToContainer(
  point: Point,
  size: { width: number; height: number },
  container: { width: number; height: number },
): Point {
  const { padding } = containerBox;
  const clamp = (value: number, min: number, max: number) =>
    Math.max(min, Math.min(Math.max(min, max), value));
  return {
    x: clamp(point.x, padding.left, container.width - padding.right - size.width),
    y: clamp(point.y, padding.top, container.height - padding.bottom - size.height),
  };
}

/**
 * Where each card is drawn. Moved cards are where the user put them (a card inside a container,
 * relative to it, kept within its content area). The other top-level cards are where the layout
 * put them, except that a card a moved card would cover is pushed straight down, just below it;
 * cards further down that way move along with it, so nothing ends up covered. Returns
 * `placed` itself when no shown card has moved.
 */
export function arrangeCards(
  placed: ReadonlyMap<string, PlacedCard>,
  moved: MovedPositions,
): ReadonlyMap<string, PlacedCard> {
  if (!hasMovedCards(moved, placed)) return placed;
  const result = new Map<string, PlacedCard>();
  const taken: Box[] = [];
  for (const card of placed.values()) {
    const point = moved.get(card.id);
    if (!point) continue;
    const parent = card.parent === undefined ? undefined : placed.get(card.parent);
    const at = { ...card, ...(parent ? clampToContainer(point, card, parent) : point) };
    result.set(card.id, at);
    if (!parent) taken.push(at);
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
  return new Map([...placed.keys()].map((id) => [id, result.get(id) as PlacedCard]));
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

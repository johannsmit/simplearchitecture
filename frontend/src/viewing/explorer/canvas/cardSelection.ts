import type { PlacedCard } from './elkLayout';
import { isGroupId } from './layoutGeometry';
import { clampToContainer, type Point } from './positions';

/**
 * Several cards selected at once (`Shift`, `Ctrl` or `⌘` + click), to drag them together. The
 * page keeps one selected element (the details panel's); the canvas keeps the cards picked with
 * it, in the order they were added. Pure, so it is tested without a browser.
 */

/** The cards picked on one canvas (`key`), in the order they were added: the last is the details card. */
export interface Picks {
  key: string;
  ids: readonly string[];
}

/**
 * The cards selected now, in the order they were added (the details card last): the picks while
 * they are for this canvas and still end with the details card (anything else that selects an
 * element ends them), without cards no longer on the canvas; else the details card alone.
 */
export function selectedCards(
  picks: Picks | null,
  key: string,
  selectedId: string | undefined,
  onCanvas: { has(id: string): boolean },
): string[] {
  if (selectedId === undefined) return [];
  if (picks?.key === key && picks.ids[picks.ids.length - 1] === selectedId) {
    return picks.ids.filter((id) => onCanvas.has(id));
  }
  return onCanvas.has(selectedId) ? [selectedId] : [];
}

/** A modifier click on a card: added last (the details card), or taken out when selected. */
export function toggledCard(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

/** Whether a click adds to or takes from the selection: `Shift`, `Ctrl` or `⌘`. */
export function isPickClick(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
  return event.shiftKey || event.ctrlKey || event.metaKey;
}

/** A drag of several selected cards: where each one that moves started (relative to its parent). */
export interface GroupDrag {
  /** The card under the pointer. */
  grabbed: string;
  /** Where it started. */
  from: Point;
  /** The cards that move, with where each started. */
  starts: ReadonlyMap<string, Point>;
}

/**
 * The drag that starts on `grabbed`, when it is one of two or more selected cards: every selected
 * card moves, except one inside another selected card (it moves with that one). Undefined when the
 * card isn't selected with others: then it moves alone.
 */
export function groupDragOf(
  shown: ReadonlyMap<string, PlacedCard>,
  selected: readonly string[],
  grabbed: string,
): GroupDrag | undefined {
  const at = shown.get(grabbed);
  if (!at || selected.length < 2 || !selected.includes(grabbed)) return undefined;
  const chosen = new Set(selected);
  const insideChosen = (id: string) => {
    const seen = new Set([id]);
    for (let up = shown.get(id)?.parent; up !== undefined && !seen.has(up);) {
      if (chosen.has(up)) return true;
      seen.add(up);
      up = shown.get(up)?.parent;
    }
    return false;
  };
  const starts = new Map<string, Point>();
  for (const id of selected) {
    const card = shown.get(id);
    if (card && !isGroupId(id) && !insideChosen(id)) starts.set(id, { x: card.x, y: card.y });
  }
  return { grabbed, from: { x: at.x, y: at.y }, starts };
}

/**
 * Where the cards of a group drag go when the grabbed card is at `to`: each by the same offset,
 * and a card in a container (or group box) never left of or above its content area.
 */
export function groupDragMoves(
  drag: GroupDrag,
  to: Point,
  shown: ReadonlyMap<string, PlacedCard>,
): [string, Point][] {
  const dx = to.x - drag.from.x;
  const dy = to.y - drag.from.y;
  return [...drag.starts].map(([id, start]) => {
    const point = { x: start.x + dx, y: start.y + dy };
    const parent = shown.get(id)?.parent;
    return [id, parent === undefined ? point : clampToContainer(point, parent)];
  });
}

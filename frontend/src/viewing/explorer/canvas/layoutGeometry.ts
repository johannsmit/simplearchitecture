import type { PlacedCard } from './elkLayout';
import type { Box, Point } from './positions';

/**
 * The canvas's sizes and spacing, and what the layout, the containers' fit and the lines' routes
 * all use. A module of its own, so those import it and not each other.
 */

export const spacing = {
  /** Between cards in the same row. */
  cards: 28,
  /** Between rows: room for the lines. */
  columns: 96,
  /** Between ports on one side of a card. */
  ports: 12,
} as const;

/**
 * A container: the 40px header, the padding around its cards, and
 * the smallest size. The numbers match .card.is-container in styles/explorer.css.
 */
export const containerBox = {
  header: 40,
  padding: { top: 56, left: 16, bottom: 16, right: 16 },
  minWidth: 200,
  minHeight: 116,
  /** Between rows inside a container. */
  columns: 64,
} as const;

/** The smallest container, before its name makes it wider. */
export const smallestContainer = { width: containerBox.minWidth, height: containerBox.minHeight };

/**
 * A group box (Group by): the 32px header with the value and count at its left, the padding around
 * its cards, the smallest size, and how wide the header text may make it. The numbers match
 * .group-box in styles/explorer.css.
 */
export const groupBox = {
  header: 32,
  padding: { top: 48, left: 16, bottom: 16, right: 16 },
  minWidth: 200,
  minHeight: 116,
  /** Between rows inside a group: as at the top level, since a group is the top level for its cards. */
  columns: spacing.columns,
  /** The header's text starts this far in from the box's left edge. */
  textInset: 12,
  /** The widest a header's text makes its box (text and 24px); a longer value ends in "…". */
  maxHeaderWidth: 400,
} as const;

/**
 * Group boxes' ids on the canvas: not element ids (which never hold NUL), so the two never mix. A
 * value's group is the prefix and the value; Not set is the prefix alone.
 */
const groupPrefix = '\u0000group';

/** The id of the group box of a value; undefined for Not set. */
export function groupId(value: string | undefined): string {
  return value === undefined ? groupPrefix : `${groupPrefix}:${value}`;
}

/** Whether an id on the canvas is a group box's. */
export function isGroupId(id: string): boolean {
  return id.startsWith(groupPrefix);
}

/** The value a group box stands for; undefined for Not set. */
export function groupValueOf(id: string): string | undefined {
  return id === groupPrefix ? undefined : id.slice(groupPrefix.length + 1);
}

/**
 * Where a group box's value and count are, with 8px around them that lines keep clear of: at the
 * left of its 32px header, `width` wide (or as wide as the header lets them be).
 */
export function groupTextArea(box: Box, width: number): Box {
  const clear = 8;
  const { textInset, header, maxHeaderWidth } = groupBox;
  const room = Math.min(box.width, maxHeaderWidth) - 2 * textInset;
  const shown = Math.max(0, Math.min(width, room));
  return { x: box.x + textInset - clear, y: box.y, width: shown + 2 * clear, height: header };
}

/** The header and padding of a box that holds cards: a group box's, or a container's. */
export function frameOf(id: string | undefined): {
  header: number;
  padding: { top: number; left: number; bottom: number; right: number };
  minWidth: number;
  minHeight: number;
  columns: number;
} {
  return id !== undefined && isGroupId(id) ? groupBox : containerBox;
}

/** Port (and React Flow handle) id of one end of a link. */
export function portId(linkId: string, end: 'source' | 'target'): string {
  return `${linkId}:${end === 'source' ? 's' : 't'}`;
}

/** The link a port (and React Flow handle) id belongs to (`portId`'s link id). */
export function linkOfPort(port: string): string {
  return port.slice(0, port.lastIndexOf(':'));
}

/** Positions on the canvas (not relative to a container), parents first in `placed`. */
export function absoluteBoxes(
  placed: ReadonlyMap<string, Omit<PlacedCard, 'handles'>>,
): Map<string, { x: number; y: number; width: number; height: number }> {
  const result = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const card of placed.values()) {
    const parent = card.parent === undefined ? undefined : result.get(card.parent);
    result.set(card.id, {
      x: card.x + (parent?.x ?? 0),
      y: card.y + (parent?.y ?? 0),
      width: card.width,
      height: card.height,
    });
  }
  return result;
}

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

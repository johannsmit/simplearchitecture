import {
  maxViewCardCoordinate,
  maxViewCardWidth,
  minViewCardWidth,
  type ViewCardLayout,
} from '@simplearchitecture/shared';
import { absoluteBoxes, containerBox, type PlacedCard } from './elkLayout';
import type { Point } from './positions';

/**
 * A view's stored layout on the canvas: where its cards were left. Positions are stored on the
 * canvas, also for a card drawn inside a container, so a layout still reads when nesting is
 * switched. Pure, so it is tested without a browser.
 */

interface Size {
  width: number;
  height: number;
}

export interface StoredPlacementInput {
  /** Every card to draw, in the canvas's order, with the container it belongs inside, if any. */
  cards: readonly { id: string; parent?: string | undefined }[];
  /** Stored positions (top left corners on the canvas), by element id. */
  stored: ReadonlyMap<string, Point>;
  /** A card's smallest size, as a card or as a container. */
  sizeOf: (id: string, container: boolean) => Size;
}

/**
 * The cards with a stored position, where they were left, parents first: a card inside its
 * container when the container has a stored position too (relative to it, kept within its
 * content area), and each container just big enough for what it holds. Cards without a stored
 * position aren't in it: `keepCards` places them at a free spot, as new cards.
 */
export function storedPlacement(input: StoredPlacementInput): {
  placed: Map<string, PlacedCard>;
  containers: Set<string>;
} {
  const { stored, sizeOf } = input;
  const order = new Map(input.cards.map((card, index) => [card.id, index]));
  const wanted = new Map<string, string>();
  for (const card of input.cards) {
    if (card.parent !== undefined && stored.has(card.id) && stored.has(card.parent)) {
      wanted.set(card.id, card.parent);
    }
  }
  // How deep each card is nested; a loop (never in a valid model) leaves the card on the canvas.
  const depth = new Map<string, number>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const seen = new Set([id]);
    let level = 0;
    for (let up = wanted.get(id); up !== undefined; up = wanted.get(up)) {
      if (seen.has(up)) {
        wanted.delete(id);
        level = 0;
        break;
      }
      seen.add(up);
      level += 1;
    }
    depth.set(id, level);
    return level;
  };
  const ids = input.cards.map((card) => card.id).filter((id) => stored.has(id));
  for (const id of ids) depthOf(id);
  const containers = new Set(wanted.values());

  const { padding } = containerBox;
  const relative = new Map<string, Point>();
  for (const id of ids) {
    const at = stored.get(id) as Point;
    const parent = wanted.get(id);
    const from = parent === undefined ? undefined : stored.get(parent);
    relative.set(
      id,
      from
        ? { x: Math.max(padding.left, at.x - from.x), y: Math.max(padding.top, at.y - from.y) }
        : at,
    );
  }
  // Sizes from the deepest card up, so a container holds what is inside it.
  const sizes = new Map<string, Size>();
  const byDepth = [...ids].sort((a, b) => (depth.get(b) ?? 0) - (depth.get(a) ?? 0));
  for (const id of byDepth) {
    if (!containers.has(id)) {
      sizes.set(id, sizeOf(id, false));
      continue;
    }
    let { width, height } = sizeOf(id, true);
    for (const member of ids) {
      if (wanted.get(member) !== id) continue;
      const at = relative.get(member) as Point;
      const size = sizes.get(member) as Size;
      width = Math.max(width, at.x + size.width + padding.right);
      height = Math.max(height, at.y + size.height + padding.bottom);
    }
    sizes.set(id, { width, height });
  }

  const parentsFirst = [...ids].sort(
    (a, b) =>
      (depth.get(a) ?? 0) - (depth.get(b) ?? 0) || (order.get(a) ?? 0) - (order.get(b) ?? 0),
  );
  const placed = new Map<string, PlacedCard>();
  for (const id of parentsFirst) {
    const parent = wanted.get(id);
    placed.set(id, {
      id,
      ...(relative.get(id) as Point),
      ...(parent === undefined ? {} : { parent }),
      ...(sizes.get(id) as Size),
      handles: [],
    });
  }
  return { placed, containers };
}

/** Stored positions by element id, from a view's layout. */
export function storedPositions(layout: readonly ViewCardLayout[]): Map<string, Point> {
  return new Map(layout.map((card) => [card.elementId, { x: card.x, y: card.y }]));
}

/** Stored widths (set by hand) by element id, from a view's layout. */
export function storedWidths(layout: readonly ViewCardLayout[]): Map<string, number> {
  const widths = new Map<string, number>();
  for (const card of layout) if (card.width !== undefined) widths.set(card.elementId, card.width);
  return widths;
}

const coordinate = (value: number): number =>
  Math.min(maxViewCardCoordinate, Math.max(-maxViewCardCoordinate, Math.round(value * 10) / 10));

/**
 * What a view stores of the canvas as drawn: every card's top left corner on the canvas (to a
 * tenth of a pixel), and the width of each card whose width was set by hand (`setByHand`), as
 * drawn, in the canvas's order.
 */
export function layoutOfCanvas(
  shown: ReadonlyMap<string, PlacedCard>,
  setByHand: (id: string) => boolean,
): ViewCardLayout[] {
  const boxes = absoluteBoxes(shown);
  return [...shown.keys()].flatMap((id): ViewCardLayout[] => {
    const box = boxes.get(id);
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return [];
    const width = setByHand(id)
      ? Math.min(maxViewCardWidth, Math.max(minViewCardWidth, Math.round(box.width)))
      : undefined;
    return [
      {
        elementId: id,
        x: coordinate(box.x),
        y: coordinate(box.y),
        ...(width === undefined ? {} : { width }),
      },
    ];
  });
}

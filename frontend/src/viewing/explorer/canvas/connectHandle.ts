import type { Box, Point } from './positions';

/**
 * Where a card's connect handle is (Modelling: drag from it to draw a relationship), so a line's
 * label lying over it can let it through. The numbers match .connect-handle in
 * styles/explorer.css. Pure, so it is tested without a browser.
 */

/** How far from its centre the handle can be grabbed: its 14px dot and the 7px ring around it. */
export const connectHandleReach = 14;

/** The centre of a card's connect handle on the canvas. */
export function connectHandleCentre(box: Box, shape: 'card' | 'circle' | 'container'): Point {
  if (shape === 'circle') return { x: box.x + box.width / 2 + 24, y: box.y + 24 };
  return { x: box.x + box.width, y: box.y + (shape === 'container' ? 20 : box.height / 2) };
}

/** The card whose connect handle is under a point: the nearest one, if several. */
export function connectHandleAt(
  point: Point,
  cards: Iterable<{ id: string; box: Box; shape: 'card' | 'circle' | 'container' }>,
): string | undefined {
  let best: { id: string; distance: number } | undefined;
  for (const { id, box, shape } of cards) {
    const centre = connectHandleCentre(box, shape);
    const distance = Math.hypot(point.x - centre.x, point.y - centre.y);
    if (distance <= connectHandleReach && (!best || distance < best.distance)) {
      best = { id, distance };
    }
  }
  return best?.id;
}

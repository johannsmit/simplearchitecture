import { textWidth } from './cardSize';
import type { Box, Point } from './positions';

/**
 * Where a line's text and state mark go: along the line, at the first spot
 * where they (grown by a 4px margin) cover no card. Each card counts 10px taller at the top, for
 * the state badge and the pill on its top border. Pure, so it is tested
 * without a browser.
 */

/** Labels are cut with an ellipsis at this width: the 96px gap between rows minus 8px. */
export const labelMaxWidth = 88;
/** A resting label may be this wide where that covers no card. */
export const restingLabelMaxWidth = 140;
export const labelHeight = 18;
/** Each further line of a label (Data's "Response: …") adds this much: its 14px line height. */
export const labelLineHeight = 14;
const labelMargin = 4;
/** How far the state badge and the relationship pill reach above a card. */
export const cardTopReach = 10;
/** Along the edge, as a share of its length: the middle first, then either side. */
export const labelSpots = [0.5, 0.3, 0.7] as const;
/** A label that is always visible tries harder before it falls back onto a card. */
const restingSpots = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8] as const;
// The pill: 7px padding and a 1px border on each side; 11px text, weight 500 (explorer.css).
const labelInset = 2 * 7 + 2 * 1;

/** The drawn width of a label pill, up to the cut: its widest line. A state mark adds 16px. */
export function labelWidth(text: string, withMark = false, max = labelMaxWidth): number {
  const mark = withMark ? 16 : 0;
  const widest = Math.max(...labelLines(text).map((line) => textWidth(line, 11, 500)));
  return Math.min(max, Math.ceil(widest) + labelInset + mark);
}

/** A label's lines: one, or Data's "Request: …" and "Response: …" each on its own. */
export function labelLines(text: string): string[] {
  return text.split('\n');
}

/** The drawn height of a label pill with its lines. */
export function labelHeightOf(text: string): number {
  return labelHeight + (labelLines(text).length - 1) * labelLineHeight;
}

/** The state mark on an edge line: a 14px circle. */
export const stateMarkSize = 14;

/** Where an edge's state mark goes: placed like a label, or undefined when every spot covers a card. */
export function placeStateMark(
  line: readonly Point[],
  cards: readonly Box[],
): { x: number; y: number } | undefined {
  return placeLabel(line, stateMarkSize, cards, stateMarkSize);
}

/** The point at a share t (0 to 1) of the line's length, or undefined on a line with no points. */
export function pointOnLine(line: readonly Point[], t: number): Point | undefined {
  const stretches = line.slice(1).map((point, index) => {
    const from = line[index] as Point;
    return { from, to: point, length: Math.hypot(point.x - from.x, point.y - from.y) };
  });
  let left = stretches.reduce((sum, stretch) => sum + stretch.length, 0) * t;
  for (const { from, to, length } of stretches) {
    if (left <= length && length > 0) {
      const share = left / length;
      return { x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share };
    }
    left -= length;
  }
  return line[line.length - 1];
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The centre of the label on the edge's line, or undefined when it can't be placed without
 * covering a card (`cards`: every card on the canvas at its current position).
 */
export function placeLabel(
  line: readonly Point[],
  width: number,
  cards: readonly Box[],
  height: number = labelHeight,
  spots: readonly number[] = labelSpots,
): { x: number; y: number } | undefined {
  for (const t of spots) {
    const at = pointOnLine(line, t);
    if (!at) return undefined;
    const box = {
      x: at.x - width / 2 - labelMargin,
      y: at.y - height / 2 - labelMargin,
      width: width + 2 * labelMargin,
      height: height + 2 * labelMargin,
    };
    const covers = (card: Box) =>
      intersects(box, { ...card, y: card.y - cardTopReach, height: card.height + cardTopReach });
    if (!cards.some(covers)) return at;
  }
  return undefined;
}

/**
 * Where a label that is always visible goes, and how wide it may be: at its full width
 * if a spot covers no card, then at the narrower cut width, and when every spot covers a card, on
 * the line's middle anyway. Undefined only for a line with no points.
 */
export function placeRestingLabel(
  line: readonly Point[],
  text: string,
  withMark: boolean,
  cards: readonly Box[],
): { x: number; y: number; width: number } | undefined {
  const middle = pointOnLine(line, labelSpots[0]);
  if (!middle) return undefined;
  const narrow = labelWidth(text, withMark);
  const height = labelHeightOf(text);
  for (const width of [labelWidth(text, withMark, restingLabelMaxWidth), narrow]) {
    const at = placeLabel(line, width, cards, height, restingSpots);
    if (at) return { ...at, width };
  }
  return { ...middle, width: narrow };
}

import { circleDiameter, circleLabelGap, circleNodeWidth } from './circle';
import { containerBox } from './elkLayout';

/**
 * Card sizes for the layout.
 *
 * - A rectangle card starts 168px wide and widens in 8px steps until the name fits on two lines,
 *   up to 280px; past that it grows a line taller per extra line.
 * - A circle (Stakeholder) node is 120px wide: the 48px circle with the name underneath, at most
 *   3 lines (then an ellipsis).
 *
 * The state badge and the relationship pill sit on the top border, so they take no room. Text is
 * measured in the real font (call `whenFontsReady` first); outside a browser (tests) it is
 * estimated from the length. The numbers match .card in styles/explorer.css.
 */

export type CardShape = 'card' | 'circle';

export const minCardWidth = 168;
export const maxCardWidth = 280;
const widthStep = 8;
export const minCardHeight = 44;
/** A circle's label wraps to at most this many lines, then ends in an ellipsis. */
export const circleLabelLines = 3;

// Measuring and rendering differ by a pixel or two.
const slack = 4;
// Padding 12px and a 1px border on each side (the focused card: 11.5px and 1.5px).
const inset = 2 * 12 + 2 * 1;
const circleHeight = circleDiameter + circleLabelGap;

const nameFont = { size: 12.5, weight: 500, lineHeight: 16 };
const focusedNameFont = { size: 13.5, weight: 600, lineHeight: 18 };
const containerNameFont = { size: 12.5, weight: 600, lineHeight: 16 };

type Font = typeof nameFont;

let context: OffscreenCanvasRenderingContext2D | null | undefined;
let family = 'system-ui, sans-serif';
const widths = new Map<string, number>();

function measure(text: string, font: Font): number {
  const { size, weight } = font;
  if (context === undefined) {
    context =
      typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d');
    if (context) {
      family =
        getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || family;
    }
  }
  const key = `${weight}|${size}|${text}`;
  let width = widths.get(key);
  if (width === undefined) {
    if (context) {
      context.font = `${weight} ${size}px ${family}`;
      width = context.measureText(text).width;
    } else {
      width = text.length * size * 0.56;
    }
    widths.set(key, width);
  }
  return width;
}

/** The width of one line of text in the app's font (estimated from the length outside a browser). */
export function textWidth(text: string, size: number, weight: number): number {
  return measure(text, { size, weight, lineHeight: size });
}

/** Lines a name wraps to at a width, breaking between words like the browser does. */
function lines(text: string, width: number, font: Font): number {
  const space = measure(' ', font);
  let count = 1;
  let line = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const wordWidth = measure(word, font);
    if (line > 0 && line + space + wordWidth <= width) {
      line += space + wordWidth;
      continue;
    }
    // A word wider than the card breaks anywhere (overflow-wrap: anywhere).
    if (line > 0) count++;
    count += Math.max(0, Math.ceil(wordWidth / width) - 1);
    line = wordWidth % width || width;
  }
  return count;
}

export interface CardSizeInput {
  name: string;
  /** The focused element's card shows its name larger. */
  focused: boolean;
  shape: CardShape;
}

function circleNameLines(name: string, focused: boolean): number {
  return lines(name || '(unnamed)', circleNodeWidth - slack, focused ? focusedNameFont : nameFont);
}

export function cardSize({ name, focused, shape }: CardSizeInput): {
  width: number;
  height: number;
} {
  const font = focused ? focusedNameFont : nameFont;
  if (shape === 'circle') {
    const nameLines = Math.min(circleLabelLines, circleNameLines(name, focused));
    return { width: circleNodeWidth, height: circleHeight + nameLines * font.lineHeight };
  }
  const text = name || '(unnamed)';
  const room = (width: number) => width - inset - slack;
  let width = minCardWidth;
  while (width < maxCardWidth && lines(text, room(width), font) > 2) width += widthStep;
  width = Math.min(width, maxCardWidth);
  const height = inset + lines(text, room(width), font) * font.lineHeight;
  return { width, height: Math.max(minCardHeight, Math.ceil(height)) };
}

/** A circle's name needs more lines than its label shows, so the label ends in an ellipsis. */
export function isCircleNameCut(name: string, focused: boolean): boolean {
  return circleNameLines(name, focused) > circleLabelLines;
}

let fontsReady: Promise<void> | undefined;

/** Resolves when the card fonts have loaded (at once where there is no font loading API). */
export function whenFontsReady(): Promise<void> {
  fontsReady ??= (async () => {
    if (typeof document === 'undefined' || !('fonts' in document)) return;
    try {
      const family = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
      if (family !== '') {
        await Promise.all([
          document.fonts.load(`${nameFont.weight} ${nameFont.size}px ${family}`),
          document.fonts.load(`${focusedNameFont.weight} ${focusedNameFont.size}px ${family}`),
          document.fonts.load(`${containerNameFont.weight} ${containerNameFont.size}px ${family}`),
        ]);
      }
      await document.fonts.ready;
    } catch {
      // Measure with whatever font is there.
    }
    widths.clear();
    context = undefined;
  })();
  return fontsReady;
}

/**
 * A container's smallest size: 200 × 116, and wide enough for its name
 * on one line in the header (after the type mark: 10px, or the 18px user icon), up to 280px.
 * Past that, the name is cut with an ellipsis.
 */
export function containerMinSize({
  name,
  focused,
  userIcon,
}: {
  name: string;
  focused: boolean;
  userIcon: boolean;
}): { width: number; height: number } {
  const width = containerNameRoom({ name, focused, userIcon });
  return {
    width: Math.max(containerBox.minWidth, Math.min(maxCardWidth, Math.ceil(width))),
    height: containerBox.minHeight,
  };
}

function containerNameRoom({
  name,
  focused,
  userIcon,
}: {
  name: string;
  focused: boolean;
  userIcon: boolean;
}): number {
  const font = focused ? focusedNameFont : containerNameFont;
  return 2 * 1 + 2 * 12 + (userIcon ? 18 : 10) + 6 + measure(name || '(unnamed)', font) + slack;
}

/** A container's name is wider than its header allows: it ends in an ellipsis. */
export function isContainerNameCut(input: {
  name: string;
  focused: boolean;
  userIcon: boolean;
}): boolean {
  return containerNameRoom(input) > maxCardWidth;
}

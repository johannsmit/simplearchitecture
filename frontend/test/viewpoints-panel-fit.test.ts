import { getViewportForBounds } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { clearFitPadding, panClearOf, type Box } from '../src/viewing/explorer/canvas/positions';

// Show Viewpoints is always open at the canvas's top left: fitting the canvas and keyboard focus
// keep cards out from under it. jsdom has no layout, so the boxes here are fixed.

const laptop = { width: 764, height: 560 };
// About the panel's size with five choices, 12px in from the corner.
const panel: Box = { x: 12, y: 12, width: 170, height: 152 };
const zoom = { min: 0.2, max: 1.25 };
const px = (pixels: number) => `${String(pixels)}px` as `${number}px`;

/** Where the drawing lands on the canvas, in screen pixels, after a fit with the padding. */
function fitted(bounds: Box, size: { width: number; height: number }) {
  const padding = clearFitPadding(bounds, size, panel, zoom);
  const viewport = getViewportForBounds(
    bounds,
    size.width,
    size.height,
    zoom.min,
    zoom.max,
    padding,
  );
  return {
    padding,
    zoom: viewport.zoom,
    left: bounds.x * viewport.zoom + viewport.x,
    top: bounds.y * viewport.zoom + viewport.y,
  };
}

const clearOfPanel = (at: { left: number; top: number }) =>
  at.left >= panel.x + panel.width + 12 - 1 || at.top >= panel.y + panel.height + 12 - 1;

describe('fitting the canvas beside Show Viewpoints', () => {
  it('keeps a wide drawing clear below the panel, losing nothing to its width', () => {
    const wide = { x: 0, y: 0, width: 2000, height: 300 };
    const at = fitted(wide, laptop);
    expect(at.padding.top).toBe(`${String(panel.y + panel.height + 12)}px`);
    expect(clearOfPanel(at)).toBe(true);
    // The other fit (beside the panel) would zoom out further.
    const beside = getViewportForBounds(wide, laptop.width, laptop.height, zoom.min, zoom.max, {
      ...at.padding,
      top: px(36),
      left: px(panel.x + panel.width + 12),
    });
    expect(at.zoom).toBeGreaterThan(beside.zoom);
  });

  it('keeps a tall drawing clear beside the panel, losing nothing to its height', () => {
    const tall = { x: 0, y: 0, width: 300, height: 2000 };
    const at = fitted(tall, laptop);
    expect(at.padding.left).toBe(`${String(panel.x + panel.width + 12)}px`);
    expect(clearOfPanel(at)).toBe(true);
  });

  it('keeps a small drawing, at the largest zoom, clear of the panel too', () => {
    const small = { x: 40, y: 40, width: 200, height: 60 };
    for (const size of [laptop, { width: 1600, height: 1000 }]) {
      const at = fitted(small, size);
      expect(at.zoom).toBe(zoom.max);
      expect(clearOfPanel(at)).toBe(true);
    }
  });

  it('pads every side as before when the panel has no size', () => {
    const padding = clearFitPadding(
      { x: 0, y: 0, width: 800, height: 400 },
      laptop,
      { x: 0, y: 0, width: 0, height: 0 },
      zoom,
    );
    expect(padding).toEqual({ top: '36px', right: '49px', bottom: '36px', left: '49px' });
  });
});

describe('a card panned out from under Show Viewpoints', () => {
  const viewport = { x: 0, y: 0, zoom: 1 };

  it('leaves a card that is clear of the panel where it is', () => {
    expect(panClearOf({ x: 300, y: 40, width: 168, height: 44 }, viewport, panel)).toBeUndefined();
    expect(panClearOf({ x: 20, y: 300, width: 168, height: 44 }, viewport, panel)).toBeUndefined();
  });

  it('pans a card under the panel down or right, whichever is the shorter way', () => {
    // Near the panel's bottom: down is shorter.
    expect(panClearOf({ x: 20, y: 140, width: 168, height: 44 }, viewport, panel)).toEqual({
      x: 0,
      y: panel.y + panel.height + 12 - 140,
      zoom: 1,
    });
    // Near its right edge: right is shorter.
    expect(panClearOf({ x: 170, y: 20, width: 168, height: 44 }, viewport, panel)).toEqual({
      x: panel.x + panel.width + 12 - 170,
      y: 0,
      zoom: 1,
    });
  });

  it('works in screen pixels, at any zoom and pan', () => {
    const zoomed = { x: -100, y: -50, zoom: 0.5 };
    // On screen at (50, 50): under the panel.
    const moved = panClearOf({ x: 300, y: 200, width: 168, height: 44 }, zoomed, panel);
    expect(moved).toBeDefined();
    const top = 200 * 0.5 + (moved?.y ?? 0);
    const left = 300 * 0.5 + (moved?.x ?? 0);
    expect(clearOfPanel({ left, top })).toBe(true);
    expect(moved?.zoom).toBe(0.5);
  });
});

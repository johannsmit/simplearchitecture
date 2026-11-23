import type { FitViewOptions } from '@xyflow/react';
import type { RefObject } from 'react';
import { fitZoom, reducedMotion, type CanvasFlow, type CanvasNode } from './canvasModel';
import { clearFitPadding, type Box } from './positions';

/** The panels' size at the last fit, while the view is still as that fit left it. */
export type FittedPanel = { width: number; height: number } | null;

/** The panels' box, in screen pixels from the canvas's top left. */
export function panelBox(host: HTMLElement | null, panels: HTMLElement | null): Box | undefined {
  const hostBox = host?.getBoundingClientRect();
  const box = panels?.getBoundingClientRect();
  if (!hostBox || !box) return undefined;
  return {
    x: box.left - hostBox.left,
    y: box.top - hostBox.top,
    width: box.width,
    height: box.height,
  };
}

/** Fits the whole drawing, with every card clear of the panels. */
export function fitCanvas(
  flow: CanvasFlow,
  store: { getState(): { width: number; height: number } },
  viewpointsBox: () => Box | undefined,
  fittedPanel: RefObject<FittedPanel>,
  duration: number,
): void {
  const { width, height } = store.getState();
  const bounds = flow.getNodesBounds(flow.getNodes());
  const panel = viewpointsBox();
  fittedPanel.current = panel ? { width: panel.width, height: panel.height } : null;
  const options: FitViewOptions<CanvasNode> = {
    padding: clearFitPadding(bounds, { width, height }, panel, fitZoom),
    minZoom: fitZoom.min,
    maxZoom: fitZoom.max,
    duration,
  };
  void flow.fitView(options);
}

/**
 * The panels can change size after a fit (choices arrive late, or the cap message comes): fit
 * again so no card ends up under them, unless the person has moved the view since. Returns the
 * cleanup, if any.
 */
export function refitOnPanelResize(
  panel: HTMLElement | null,
  fittedPanel: RefObject<FittedPanel>,
  viewpointsBox: () => Box | undefined,
  fit: (duration: number) => void,
): (() => void) | undefined {
  if (!panel || typeof ResizeObserver === 'undefined') return undefined;
  const observer = new ResizeObserver(() => {
    const fitted = fittedPanel.current;
    const box = viewpointsBox();
    if (!fitted || !box) return;
    if (Math.abs(box.width - fitted.width) < 1 && Math.abs(box.height - fitted.height) < 1) {
      return;
    }
    fit(reducedMotion() ? 0 : 200);
  });
  observer.observe(panel);
  return () => {
    observer.disconnect();
  };
}

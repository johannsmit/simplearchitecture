import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { CanvasFlow, Laid, RelatedState } from './canvasModel';
import type { LineDrag } from './canvasLines';
import { simplified, type EndBox } from './edgeLine';
import { bendAt, bendSnap, fitEnds, moveBend, squared, type HeldRoute } from './lineRoutes';
import { dragThreshold, type Point } from './positions';
import type { LinePress } from './RelationshipEdge';

/** A line with a bend dragged to a point; undefined where no such line fits. */
export type FitBend = (
  linkId: string,
  line: readonly Point[],
  index: number,
  to: Point,
) => Point[] | undefined;

/** A line dropped where the person dragged it. */
export type RouteMoved = (linkId: string, line: Point[]) => void;

/** A line with a bend dragged to a point; undefined where no such line fits. */
export function fittedBend(
  laid: Laid | null,
  endBoxes: ReadonlyMap<string, EndBox>,
  flow: CanvasFlow,
  linkId: string,
  line: readonly Point[],
  index: number,
  to: Point,
): Point[] | undefined {
  const link = laid?.drawn.find((each) => each.id === linkId);
  const sourceBox = link && endBoxes.get(link.source);
  const targetBox = link && endBoxes.get(link.target);
  if (!sourceBox || !targetBox) return undefined;
  // Snapping is the same distance on the screen at every zoom.
  const snap = bendSnap / (flow.getZoom() || 1);
  return moveBend(line, index, to, sourceBox, targetBox, snap);
}

/**
 * The lines moved by hand once a line is dropped where the person dragged it: held for every
 * relationship on it. Undefined where no line fits.
 */
export function heldAfterMove(
  laid: Laid | null,
  endBoxes: ReadonlyMap<string, EndBox>,
  held: ReadonlyMap<string, HeldRoute>,
  linkId: string,
  line: Point[],
): Map<string, HeldRoute> | undefined {
  const link = laid?.drawn.find((each) => each.id === linkId);
  const sourceBox = link && endBoxes.get(link.source);
  const targetBox = link && endBoxes.get(link.target);
  if (!laid || !link || !sourceBox || !targetBox) return undefined;
  const points = fitEnds(squared(line), sourceBox, targetBox);
  if (!points) return undefined;
  const next = new Map(held);
  for (const id of link.relationshipIds) {
    next.set(id, { source: link.source, target: link.target, points, sourceBox, targetBox });
  }
  return next;
}

/** What a press on a bend handle reads and updates. */
export interface BendPressInput {
  flow: CanvasFlow;
  bendDrag: RefObject<{ stop: () => void } | null>;
  /** The lines whose bend handles show now. */
  bendLines: RefObject<readonly string[]>;
  /** Every line as drawn now. */
  drawnLines: RefObject<Map<string, readonly Point[]>>;
  latestFitted: RefObject<FitBend>;
  latestRouteMoved: RefObject<RouteMoved>;
  latestNote: RefObject<(text: string) => void>;
  routeMovedAt: RefObject<number>;
  setLineDrag: Dispatch<SetStateAction<LineDrag | null>>;
}

/**
 * A press on a bend handle: the bend nearest the pointer, among the lines whose handles show, is
 * the one grabbed, where two lines' handles lie on top of each other. True when a bend was
 * grabbed: from 4px on it is dragged, and the drop saves the line. Esc, a cancelled pointer or
 * the window losing focus puts the line back, and nothing is saved.
 */
export function pressBend(press: LinePress, input: BendPressInput): boolean {
  const {
    flow,
    bendDrag,
    bendLines,
    drawnLines,
    latestFitted,
    latestRouteMoved,
    latestNote,
    routeMovedAt,
    setLineDrag,
  } = input;
  bendDrag.current?.stop();
  const from = flow.screenToFlowPosition({ x: press.clientX, y: press.clientY });
  const shownLines = new Map<string, readonly Point[]>();
  for (const id of bendLines.current) {
    const drawn = drawnLines.current.get(id);
    if (drawn) shownLines.set(id, drawn);
  }
  const grabbed = bendAt(shownLines, from);
  const line = grabbed && simplified(shownLines.get(grabbed.id) ?? []);
  const bend = grabbed && line?.[grabbed.index];
  if (!grabbed || !line || !bend) return false;
  const { id: linkId, index } = grabbed;
  // The line as it would be if dropped here: undefined where no line fits.
  const to = (event: PointerEvent) => {
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    return latestFitted.current(linkId, line, index, {
      x: bend.x + at.x - from.x,
      y: bend.y + at.y - from.y,
    });
  };
  let moved = false;
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== press.pointerId) return;
    const distance = Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY);
    if (!moved && distance <= dragThreshold) return;
    // The live region empties as the drag starts, so the drop's "Line moved." is a change and
    // is announced, also for a second move in a row.
    if (!moved) latestNote.current('');
    moved = true;
    setLineDrag({ linkId, points: to(event) ?? [...line] });
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== press.pointerId) return;
    stop();
    if (!moved) return;
    // A drag: the line is held where it was dropped, and saved; the click ending it opens
    // nothing, also where no line fits and nothing changes.
    routeMovedAt.current = performance.now();
    const dropped = to(event);
    if (dropped) latestRouteMoved.current(linkId, dropped);
  };
  /**
   * The release after a cancel opens nothing either. A release outside the window is never
   * seen: the next press ends the wait.
   */
  const swallowRelease = (event: PointerEvent) => {
    if (event.type === 'pointerup' && event.pointerId === press.pointerId) {
      routeMovedAt.current = performance.now();
    } else if (event.type !== 'pointerdown') {
      return;
    }
    window.removeEventListener('pointerup', swallowRelease, true);
    window.removeEventListener('pointerdown', swallowRelease, true);
  };
  const cancel = () => {
    stop();
    routeMovedAt.current = performance.now();
    window.addEventListener('pointerup', swallowRelease, true);
    window.addEventListener('pointerdown', swallowRelease, true);
    latestNote.current('Line move cancelled.');
  };
  const onKey = (event: globalThis.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    // Only the drag: the open relationship stays open, and the cards keep focus.
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  const onCancel = (event: PointerEvent) => {
    if (event.pointerId === press.pointerId) cancel();
  };
  const stop = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', cancel);
    if (bendDrag.current === drag) bendDrag.current = null;
    setLineDrag(null);
  };
  const drag = { stop };
  bendDrag.current = drag;
  setLineDrag({ linkId });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', cancel);
  return true;
}

/**
 * A press on a line: from 4px on, the drag pans the canvas (React Flow keeps its lines from
 * panning), and the click ending it opens nothing. Less is a click, which opens the line.
 */
export function pressLine(
  press: LinePress,
  flow: CanvasFlow,
  routeMovedAt: RefObject<number>,
  setRelated: Dispatch<SetStateAction<RelatedState | null>>,
): boolean {
  const start = flow.getViewport();
  let moved = false;
  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== press.pointerId) return;
    const dx = event.clientX - press.clientX;
    const dy = event.clientY - press.clientY;
    if (!moved && Math.hypot(dx, dy) <= dragThreshold) return;
    if (!moved) setRelated(null);
    moved = true;
    void flow.setViewport({ x: start.x + dx, y: start.y + dy, zoom: start.zoom });
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerId !== press.pointerId) return;
    stop();
    if (moved) routeMovedAt.current = performance.now();
  };
  const stop = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', stop);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', stop);
  return true;
}

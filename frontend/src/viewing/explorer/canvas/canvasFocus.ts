import type { ModelGraph } from '@simplearchitecture/shared';
import type { RefObject } from 'react';
import { counted } from '../../../words';
import { cardIdOf } from './canvasDom';
import { reducedMotion, type Laid, type Note } from './canvasModel';
import { relatedButtonId } from './ElementCard';
import { isGroupId } from './layoutGeometry';

/** Keyboard focus to restore after the next layout: a card's main or pill. */
export type PendingFocus = { id: string; part: 'main' | 'related' } | null;

/** What the canvas does once a layout or a change is drawn. */
export interface AfterLayoutInput {
  laid: Laid;
  updateNodeInternals: (ids: string[]) => void;
  flowId: (id: string) => string;
  domIds: ReadonlyMap<string, string>;
  missing: ReadonlyMap<string, number>;
  fit: (duration: number) => void;
  /** The layout the view was last fitted to. */
  fitted: RefObject<Laid | null>;
  pendingFocus: RefObject<PendingFocus>;
  section: RefObject<HTMLElement | null>;
  /** Keyboard focus was in the canvas. */
  hadFocus: RefObject<boolean>;
}

/**
 * After a change: re-read the handles (they may have moved), and fit the view to a new layout
 * (only: when cards come and go, the view stays where it is). Keyboard focus stays in the canvas.
 * Returns the cleanup.
 */
export function afterLayout(input: AfterLayoutInput): () => void {
  const { laid, updateNodeInternals, flowId, domIds, missing, fit, fitted, pendingFocus, section } =
    input;
  updateNodeInternals([...laid.placed.keys()].map(flowId));
  let frame = 0;
  if (laid.fresh && fitted.current !== laid) {
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        fitted.current = laid;
        fit(reducedMotion() ? 0 : 200);
      });
    });
  }
  // Keep keyboard focus in the canvas: on the requested card, or on the focused element's card
  // when the card that had it is gone. A card with nothing missing any more has no pill,
  // so focus goes to its main button instead. Decided from the data: React Flow draws the new
  // cards a moment after this runs, so the DOM may still show the old ones.
  const request = pendingFocus.current;
  pendingFocus.current = null;
  const focusPart = (id: string, part: 'main' | 'related') => {
    const domId = domIds.get(id) ?? '';
    const target =
      part === 'related' && (missing.get(id) ?? 0) > 0 ? relatedButtonId(domId) : domId;
    document.getElementById(target)?.focus();
  };
  const active = document.activeElement;
  const lost = section.current?.contains(active) !== true;
  const activeCard = cardIdOf(active);
  if (request && laid.placed.has(request.id)) {
    focusPart(request.id, request.part);
  } else if (input.hadFocus.current && lost) {
    const home = laid.placed.has(laid.hood.focusId)
      ? laid.hood.focusId
      : [...laid.placed.keys()].find((id) => !isGroupId(id));
    if (home !== undefined) focusPart(home, 'main');
  } else if (
    activeCard !== undefined &&
    laid.placed.has(activeCard) &&
    active?.classList.contains('cpill') === true &&
    (missing.get(activeCard) ?? 0) === 0
  ) {
    // Its pill is about to go (e.g. after a depth change): keep focus on the card.
    focusPart(activeCard, 'main');
  }
  return () => {
    cancelAnimationFrame(frame);
  };
}

/**
 * What the live region says: the last note while it holds (until the next layout, or with `canvas`
 * until the canvas is a new one), else what the canvas shows.
 */
export function announcementOf(
  note: Note | null,
  laid: Laid | null,
  graph: ModelGraph,
  view: { inView: boolean; viewName: string | undefined },
  groupCount: number,
): string {
  return note && (note.laid === laid || (note.canvas !== undefined && note.canvas === laid?.canvas))
    ? note.text
    : laid
      ? `${view.inView ? `View ${view.viewName || '(unnamed)'}` : `Focused ${graph.elements.get(laid.hood.focusId)?.name || '(unnamed)'}`}. ${counted(laid.placed.size - groupCount, 'element')} shown.`
      : '';
}

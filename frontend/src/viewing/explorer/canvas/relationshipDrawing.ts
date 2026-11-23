import type { Dispatch, RefObject, SetStateAction } from 'react';
import { cardAtPoint } from './canvasDom';
import type { Laid, Note } from './canvasModel';

/** Drawing a relationship: from this element. Esc cancels (then the drop is ignored). */
export type Drawing = { source: string; cancelled: boolean } | null;

/** What following a relationship being drawn reads and updates. */
export interface FollowDrawingInput {
  /** The element the relationship is drawn from. */
  drawingFrom: string;
  section: RefObject<HTMLElement | null>;
  drawing: RefObject<Drawing>;
  store: { getState(): { cancelConnection: () => void } };
  laid: Laid | null;
  setDropAt: Dispatch<SetStateAction<{ id: string; ok: boolean } | null>>;
  setChip: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  setDrawingFrom: Dispatch<SetStateAction<string | null>>;
  setNote: Dispatch<SetStateAction<Note | null>>;
}

/**
 * While drawing: the card under the pointer (and the chip over the source), and Esc. Returns the
 * cleanup.
 */
export function followDrawing(input: FollowDrawingInput): () => void {
  const {
    drawingFrom,
    section,
    drawing,
    store,
    laid,
    setDropAt,
    setChip,
    setDrawingFrom,
    setNote,
  } = input;
  const onMove = (event: PointerEvent) => {
    const id = cardAtPoint(event.clientX, event.clientY, section.current);
    setDropAt(id === undefined ? null : { id, ok: id !== drawingFrom });
    const box = section.current?.getBoundingClientRect();
    setChip(
      id === drawingFrom && box
        ? { x: event.clientX - box.left + 8, y: event.clientY - box.top + 12 }
        : null,
    );
  };
  const onKey = (event: globalThis.KeyboardEvent) => {
    if (event.key !== 'Escape' || !drawing.current) return;
    drawing.current.cancelled = true;
    store.getState().cancelConnection();
    setDrawingFrom(null);
    setDropAt(null);
    setChip(null);
    setNote({ laid, text: 'No relationship added.' });
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('keydown', onKey, true);
  return () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('keydown', onKey, true);
  };
}

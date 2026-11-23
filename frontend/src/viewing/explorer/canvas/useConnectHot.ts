import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { CanvasFlow, Laid } from './canvasModel';
import { connectHandleAt } from './connectHandle';
import type { EndBox } from './edgeLine';
import { isGroupId } from './layoutGeometry';

/**
 * In Modelling, a line's label can lie over a card's connect handle. With the pointer on the label
 * there, that card (with what is inside it) comes above the labels and shows its handle, so it can
 * be grabbed; it stays so while the pointer stays at the handle.
 */
export function useConnectHot(input: {
  editable: boolean;
  laid: Laid | null;
  draggingId: string | null;
  flow: CanvasFlow;
  endBoxes: ReadonlyMap<string, EndBox>;
}): { connectHot: string | null; onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void } {
  const { editable, laid, draggingId, flow, endBoxes } = input;
  const [connectHot, setConnectHot] = useState<string | null>(null);
  const connectHotRef = useRef<string | null>(null);
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!editable || !laid || draggingId !== null) return;
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const cards = [...endBoxes]
      .filter(([id]) => !isGroupId(id))
      .map(([id, box]) => ({
        id,
        box,
        shape: laid.containers.has(id)
          ? ('container' as const)
          : box.circle === true
            ? ('circle' as const)
            : ('card' as const),
      }));
    const current = connectHotRef.current;
    let next: string | null = null;
    if (current !== null) {
      next =
        connectHandleAt(
          at,
          cards.filter((card) => card.id === current),
        ) ?? null;
    }
    if (next === null && event.target instanceof Element && event.target.closest('.edge-label')) {
      next = connectHandleAt(at, cards) ?? null;
    }
    if (next !== current) {
      connectHotRef.current = next;
      setConnectHot(next);
    }
  };
  return { connectHot, onPointerMove };
}

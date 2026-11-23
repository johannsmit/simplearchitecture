import type { Dispatch, RefObject, SetStateAction } from 'react';
import { setWidth, type LatestCallbacks, type Laid, type RelatedState } from './canvasModel';
import type { PlacedCard } from './elkLayout';
import { pushedByContainer, type Holding, type MovedPositions, type Point } from './positions';

/** Every card's size as drawn now: where a hold starts from (`others`: cards dragged with it). */
export function holdingOf(
  shown: ReadonlyMap<string, PlacedCard>,
  id: string,
  others: readonly string[] = [],
): Holding {
  return {
    id,
    sizes: new Map(
      [...shown].map(([key, card]) => [key, { width: card.width, height: card.height }]),
    ),
    ...(others.length > 0 ? { others } : {}),
  };
}

/** What the canvas reads and updates once a hold is dropped. */
export interface SettleInput {
  laid: Laid | null;
  shown: ReadonlyMap<string, PlacedCard>;
  moved: MovedPositions;
  holding: Holding | undefined;
  onMove: (id: string, position: Point | undefined) => void;
  wantArranged: () => void;
  /** A hold just dropped. */
  dropped: RefObject<Holding | null>;
  /** Cards were just given new places after a drop. */
  settling: RefObject<boolean>;
}

/**
 * After a drop, the places the fit gave the cards inside a container become theirs, so the next
 * hold starts from the picture as drawn; and a container that grew over cards beside it pushes
 * them down, for good. Then the drop is reported.
 */
export function settleAfterDrop(input: SettleInput): void {
  const { laid, shown, moved, holding, onMove, wantArranged, dropped, settling } = input;
  if (!laid || holding) return;
  let changed = false;
  for (const card of shown.values()) {
    if (card.parent === undefined) continue;
    const was = moved.get(card.id) ?? laid.placed.get(card.id);
    if (!was || (Math.abs(was.x - card.x) < 0.001 && Math.abs(was.y - card.y) < 0.001)) continue;
    onMove(card.id, { x: card.x, y: card.y });
    changed = true;
  }
  const drop = dropped.current;
  if (drop) {
    dropped.current = null;
    // Cards dropped together don't push each other: only the cards beside them move.
    const held = new Set([drop.id, ...(drop.others ?? [])]);
    const pushed = new Map<string, Point>();
    for (const card of held) {
      for (const [id, point] of pushedByContainer(shown, card, drop.sizes)) {
        const before = pushed.get(id);
        if (!held.has(id) && (!before || point.y > before.y)) pushed.set(id, point);
      }
    }
    for (const [id, point] of pushed) {
      onMove(id, point);
      changed = true;
    }
    wantArranged();
  }
  settling.current = changed;
}

/** What the width grip reads and updates. */
export interface GripInput {
  shown: RefObject<ReadonlyMap<string, PlacedCard>>;
  /** The card's width when the press started. */
  resizing: RefObject<{ id: string; width: number } | null>;
  setResizingCard: Dispatch<SetStateAction<boolean>>;
  setRelated: Dispatch<SetStateAction<RelatedState | null>>;
  latest: RefObject<LatestCallbacks>;
  wantArranged: () => void;
}

/** The width grip: the card's width when the press started, plus how far the pointer went. */
export function resizeWithGrip(
  id: string,
  phase: 'start' | 'move' | 'end',
  dx: number,
  input: GripInput,
): void {
  const { shown, resizing, setResizingCard, setRelated, latest, wantArranged } = input;
  if (phase === 'start') {
    const card = shown.current.get(id);
    resizing.current = card ? { id, width: card.width } : null;
    setResizingCard(true);
    setRelated(null);
    return;
  }
  if (phase === 'end') setResizingCard(false);
  const from = resizing.current;
  if (from?.id !== id) return;
  const zoom = latest.current.flow.getZoom() || 1;
  const width = setWidth(from.width + dx / zoom);
  latest.current.onResize(id, width);
  if (phase === 'end') {
    resizing.current = null;
    if (width !== from.width) wantArranged();
  }
}

import type { Dispatch, FocusEvent, KeyboardEvent, RefObject, SetStateAction } from 'react';
import { cardIdOf } from './canvasDom';
import type { FittedPanel } from './canvasFit';
import {
  arrowDirections,
  reducedMotion,
  setWidth,
  type CanvasFlow,
  type Hover,
  type Laid,
  type Moving,
  type Note,
  type RelatedState,
} from './canvasModel';
import type { ExplorerCanvasProps } from './explorerCanvasProps';
import type { PlacedCard } from './elkLayout';
import { isGroupId } from './layoutGeometry';
import {
  clampToContainer,
  isMoveKey,
  movedBy,
  moveStep,
  panToKeepInView,
  type Box,
  type Holding,
  type MovedPositions,
  type Viewport,
} from './positions';
import { nearestInDirection, type Direction } from './view';

/** What the canvas's keys and focus handling read and update. */
export interface CanvasKeyboardInput {
  props: ExplorerCanvasProps;
  flow: CanvasFlow;
  laid: Laid | null;
  focusId: string;
  editable: boolean;
  inView: boolean;
  /** Keyboard move mode, while it lasts. */
  moving: Moving | null;
  hold: Holding | null;
  moved: MovedPositions;
  shown: ReadonlyMap<string, PlacedCard>;
  absolute: ReadonlyMap<string, Box>;
  domIds: ReadonlyMap<string, string>;
  /** Busy: a card or its width dragged, a bend dragged, or a relationship drawn. */
  dragging: boolean;
  resizingCard: boolean;
  lineDragging: boolean;
  drawingFrom: string | null;
  relationsTidyable: boolean;
  fit: (duration: number) => void;
  holdFrom: (id: string) => Holding;
  isResizable: (id: string) => boolean;
  nameOf: (id: string) => string;
  setActiveId: (id: string) => void;
  clearOfViewpoints: (id: string) => Viewport | undefined;
  clearOfViewpointsAt: (box: Box, viewport: Viewport) => Viewport | undefined;
  setRelated: Dispatch<SetStateAction<RelatedState | null>>;
  setHold: Dispatch<SetStateAction<Holding | null>>;
  setMoving: Dispatch<SetStateAction<Moving | null>>;
  setNote: Dispatch<SetStateAction<Note | null>>;
  setHover: Dispatch<SetStateAction<Hover>>;
  sectionRef: RefObject<HTMLElement | null>;
  /** A hold just dropped: once the canvas shows the drop, a grown container pushes cards aside. */
  droppedRef: RefObject<Holding | null>;
  /** Keyboard focus was in the canvas. */
  hadFocusRef: RefObject<boolean>;
  /** The last thing the person did was press the pointer. */
  pointerLastRef: RefObject<boolean>;
  fittedPanelRef: RefObject<FittedPanel>;
}

/**
 * The canvas's keys (moving between cards, keyboard move mode, zoom, depth, Tidy relations) and
 * its focus handling.
 */
export function useCanvasKeyboard(input: CanvasKeyboardInput) {
  const {
    props,
    flow,
    laid,
    focusId,
    editable,
    inView,
    moving,
    hold,
    moved,
    shown,
    absolute,
    domIds,
    dragging,
    resizingCard,
    lineDragging,
    drawingFrom,
    relationsTidyable,
    fit,
    holdFrom,
    isResizable,
    nameOf,
    setActiveId,
    clearOfViewpoints,
    clearOfViewpointsAt,
    setRelated,
    setHold,
    setMoving,
    setNote,
    setHover,
    sectionRef,
    droppedRef,
    hadFocusRef,
    pointerLastRef,
    fittedPanelRef,
  } = input;

  const focusCard = (id: string) => {
    setActiveId(id);
    document.getElementById(domIds.get(id) ?? '')?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLElement && target.closest('.related-pop, .rel-pop, .new-pop')) {
      return;
    }
    const cardId = cardIdOf(target);
    const direction = arrowDirections[event.key];
    if (moving) {
      onMoveModeKey(event, direction);
      return;
    }
    if (cardId !== undefined && isMoveKey(event)) {
      startMove(cardId);
      event.preventDefault();
      return;
    }
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (editable && cardId !== undefined && plain && (event.key === 'r' || event.key === 'R')) {
      props.onAddRelationshipFrom?.(cardId);
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape' && props.selectedRelationshipId !== undefined) {
      props.onDeselect?.();
      event.preventDefault();
      return;
    }
    if (direction) {
      if (event.shiftKey) {
        const step = 80;
        const { x, y, zoom } = flow.getViewport();
        const dx = direction === 'left' ? step : direction === 'right' ? -step : 0;
        const dy = direction === 'up' ? step : direction === 'down' ? -step : 0;
        void flow.setViewport({ x: x + dx, y: y + dy, zoom });
        event.preventDefault();
        return;
      }
      if (!cardId || !laid) return;
      const centre = ([id, card]: [
        string,
        { x: number; y: number; width: number; height: number },
      ]) => ({
        id,
        x: card.x + card.width / 2,
        y: card.y + card.height / 2,
      });
      const from = absolute.get(cardId);
      if (!from) return;
      const cardsOnly = [...absolute].filter(([id]) => !isGroupId(id));
      const next = nearestInDirection(centre([cardId, from]), cardsOnly.map(centre), direction);
      if (next) {
        focusCard(next);
        props.onSelectElement?.(next);
      }
      event.preventDefault();
      return;
    }
    // Enter focuses the card's element (a click on the card only selects it). Not a click: the
    // default is prevented.
    if (cardId !== undefined && event.key === 'Enter' && plain && !event.shiftKey) {
      event.preventDefault();
      if (cardId !== focusId) props.onFocusElement(cardId);
      return;
    }
    if (event.key === 'Escape') {
      sectionRef.current?.focus();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (target instanceof HTMLButtonElement && !cardId) return;
    if (event.key === '1' || event.key === '2' || event.key === '3') {
      // A view has no depth.
      if (inView) return;
      props.onDepth(Number(event.key));
    } else if (event.key === '+' || event.key === '=') {
      void flow.zoomIn({ duration: reducedMotion() ? 0 : 200 });
    } else if (event.key === '-') {
      void flow.zoomOut({ duration: reducedMotion() ? 0 : 200 });
    } else if (event.key === '0') {
      fit(reducedMotion() ? 0 : 200);
    } else if (event.key === 't' || event.key === 'T') {
      // Not while a card, its width or a bend is dragged, or a relationship is drawn.
      const busy = dragging || resizingCard || lineDragging || drawingFrom !== null;
      if (!relationsTidyable || busy) return;
      props.onTidyRelations?.();
    } else {
      return;
    }
    event.preventDefault();
  };

  /** Keyboard move mode (the keyboard way to drag, WCAG 2.5.7): M on a card starts it. */
  const startMove = (id: string) => {
    setRelated(null);
    setHold(holdFrom(id));
    setMoving({
      focusId,
      id,
      before: moved.get(id),
      widthBefore: props.widths.get(id),
      widthAt: shown.get(id)?.width,
    });
    setNote({
      laid,
      text: `Moving ${nameOf(id)}. Use the arrow keys, then Enter to drop or Escape to cancel.`,
    });
  };

  const endMove = (how: 'drop' | 'cancel') => {
    if (!moving) return;
    if (
      how === 'drop' &&
      (moved.get(moving.id) !== moving.before || props.widths.get(moving.id) !== moving.widthBefore)
    ) {
      droppedRef.current = hold ?? { id: moving.id, sizes: new Map() };
    }
    if (how === 'cancel') {
      props.onMove(moving.id, moving.before);
      if (props.widths.get(moving.id) !== moving.widthBefore) {
        props.onResize(moving.id, moving.widthBefore ?? moving.widthAt);
      }
    }
    setMoving(null);
    setHold(null);
    setNote({ laid, text: how === 'drop' ? `${nameOf(moving.id)} moved.` : 'Move cancelled.' });
  };

  /** In move mode: arrows move the card, Enter or M drop it, Esc cancels. Other canvas keys wait. */
  const onMoveModeKey = (event: KeyboardEvent<HTMLElement>, direction: Direction | undefined) => {
    if (!moving) return;
    const card = shown.get(moving.id);
    // Alt + left or right: narrower or wider (the keyboard way to use the width grip).
    if (
      (direction === 'left' || direction === 'right') &&
      card &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      isResizable(card.id)
    ) {
      const step = moveStep(event) * (direction === 'left' ? -1 : 1);
      props.onResize(card.id, setWidth(card.width + step));
      setNote({ laid, text: direction === 'left' ? 'Narrower.' : 'Wider.' });
      event.preventDefault();
      return;
    }
    if (direction && card && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const parent = card.parent === undefined ? undefined : shown.get(card.parent);
      const step = movedBy(card, direction, moveStep(event));
      const next = parent ? clampToContainer(step, parent.id) : step;
      props.onMove(card.id, next);
      // Keep the card in view: pan just enough.
      const box = sectionRef.current?.getBoundingClientRect();
      const offset = parent ? absolute.get(parent.id) : undefined;
      const at = { ...card, x: next.x + (offset?.x ?? 0), y: next.y + (offset?.y ?? 0) };
      const kept = box ? panToKeepInView(at, flow.getViewport(), box) : undefined;
      // Never under the panels either: the canvas pans instead.
      const viewport = clearOfViewpointsAt(at, kept ?? flow.getViewport()) ?? kept;
      if (viewport) void flow.setViewport(viewport);
    } else if (event.key === 'Enter' || isMoveKey(event)) {
      // Enter must not also click the card (which would focus the element).
      endMove('drop');
    } else if (event.key === 'Escape') {
      endMove('cancel');
    } else {
      return;
    }
    event.preventDefault();
  };

  const onFocusCapture = (event: FocusEvent<HTMLElement>) => {
    hadFocusRef.current = true;
    const id = cardIdOf(event.target);
    if (id) {
      setActiveId(id);
      setHover({ kind: 'card', id });
      // A card that gets keyboard focus is never hidden under the panels. A click on a card
      // half under it doesn't pan: the card is under the pointer, and may be about to be dragged.
      if (!pointerLastRef.current) {
        const viewport = clearOfViewpoints(id);
        if (viewport) {
          fittedPanelRef.current = null;
          void flow.setViewport(viewport, { duration: reducedMotion() ? 0 : 200 });
        }
      }
    }
  };

  const onBlurCapture = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    // Tab (even to the card's own pill), a click elsewhere, or anything else that takes
    // focus off the control that started move mode drops the card there.
    if (moving) endMove('drop');
    if (next instanceof Node && !sectionRef.current?.contains(next)) hadFocusRef.current = false;
    if (cardIdOf(event.target) && !(event.relatedTarget && cardIdOf(event.relatedTarget))) {
      setHover(null);
    }
  };

  return { onKeyDown, onFocusCapture, onBlurCapture };
}

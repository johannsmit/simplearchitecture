import type { ModelGraph } from '@simplearchitecture/shared';
import type {
  DragEvent,
  Dispatch,
  MouseEvent as ReactMouseEvent,
  RefObject,
  SetStateAction,
} from 'react';
import { cardAtPoint, pointOf } from './canvasDom';
import type { FittedPanel } from './canvasFit';
import {
  reducedMotion,
  relPopHeight,
  relPopWidth,
  type CanvasFlow,
  type CanvasPop,
  type Laid,
  type Note,
  type RelatedState,
} from './canvasModel';
import type { ExplorerCanvasProps } from './explorerCanvasProps';
import type { PlaceHint } from './placeCards';
import type { Box, Point, Viewport } from './positions';
import type { Drawing } from './relationshipDrawing';
import { elementDragType } from './view';

/** What the canvas's popovers and relationship drawing read and update. */
export interface CanvasPopoversInput {
  props: ExplorerCanvasProps;
  graph: ModelGraph;
  flow: CanvasFlow;
  store: { getState(): { width: number; height: number } };
  laid: Laid | null;
  editable: boolean;
  pop: CanvasPop | null;
  domIds: ReadonlyMap<string, string>;
  /** React Flow's node id → element id. */
  elementIds: ReadonlyMap<string, string>;
  absolute: ReadonlyMap<string, Box>;
  nameOf: (id: string) => string;
  setActiveId: (id: string) => void;
  clearOfViewpoints: (id: string, viewport?: Viewport) => Viewport | undefined;
  setRelated: Dispatch<SetStateAction<RelatedState | null>>;
  setEdgeMenu: Dispatch<SetStateAction<{ ids: string[]; top: number; left: number } | null>>;
  setPop: Dispatch<SetStateAction<CanvasPop | null>>;
  setDrawingFrom: Dispatch<SetStateAction<string | null>>;
  setDropAt: Dispatch<SetStateAction<{ id: string; ok: boolean } | null>>;
  setChip: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  setNote: Dispatch<SetStateAction<Note | null>>;
  /** A row from the element list is dragged over the canvas. */
  setDropTarget: Dispatch<SetStateAction<boolean>>;
  sectionRef: RefObject<HTMLElement | null>;
  drawingRef: RefObject<Drawing>;
  fittedPanelRef: RefObject<FittedPanel>;
  /** Where new cards should go, until they are placed. */
  hintsRef: RefObject<Map<string, PlaceHint>>;
}

/**
 * The canvas's popovers (New relationship, New element, a line's chooser), drawing a relationship
 * onto a card or empty canvas, bringing an element onto the canvas (a double click, or a row
 * dropped from the element list), and showing a card ("Show on canvas").
 */
export function useCanvasPopovers(input: CanvasPopoversInput) {
  const {
    props,
    graph,
    flow,
    store,
    laid,
    editable,
    pop,
    domIds,
    elementIds,
    absolute,
    nameOf,
    setActiveId,
    clearOfViewpoints,
    setRelated,
    setEdgeMenu,
    setPop,
    setDrawingFrom,
    setDropAt,
    setChip,
    setNote,
    setDropTarget,
    sectionRef,
    drawingRef,
    fittedPanelRef,
    hintsRef,
  } = input;

  /** A new card for this element goes at this point (where it was dropped or asked for). */
  const hintAt = (id: string, at: Point) => {
    hintsRef.current.set(id, { at: { x: at.x - 60, y: at.y - 22 } });
  };

  /** A popover's place in the canvas: 12px right of the point, kept 8px inside. */
  const placeAt = (x: number, y: number, width = relPopWidth, height = relPopHeight) => {
    const box = sectionRef.current?.getBoundingClientRect();
    if (!box) return { top: 8, left: 8 };
    let left = x - box.left + 12;
    if (left + width > box.width - 8) left = x - box.left - 12 - width;
    const top = Math.min(y - box.top, box.height - 8 - height);
    return { top: Math.max(8, top), left: Math.max(8, left) };
  };

  /**
   * A click on a line or its label: opens its relationship, or the chooser for a line that holds
   * several.
   */
  const openLink = (linkId: string, clientX: number, clientY: number) => {
    if (!laid || !props.onOpenRelationship) return;
    const link = laid.links.find((l) => l.id === linkId);
    if (!link) return;
    setRelated(null);
    if (link.relationshipIds.length === 1) {
      props.onOpenRelationship(link.relationshipIds[0] as string);
      return;
    }
    setEdgeMenu({ ids: link.relationshipIds, ...placeAt(clientX, clientY, 320, 200) });
  };

  const focusCardOf = (id: string) => {
    requestAnimationFrame(() => {
      document.getElementById(domIds.get(id) ?? '')?.focus();
    });
  };

  const onConnectStart = (_event: MouseEvent | TouchEvent, params: { nodeId: string | null }) => {
    const source = elementIds.get(params.nodeId ?? '');
    if (!editable || source === undefined) return;
    // The lines come back, so the new one shows once added.
    if (!props.lines) props.onLines(true);
    drawingRef.current = { source, cancelled: false };
    setDrawingFrom(source);
    setRelated(null);
    setPop(null);
    setEdgeMenu(null);
    setNote({
      laid,
      text: `Drawing a relationship from ${nameOf(source)}. Drop it on another element, or press Esc.`,
    });
  };

  const onConnectEnd = (event: MouseEvent | TouchEvent) => {
    const current = drawingRef.current;
    drawingRef.current = null;
    setDrawingFrom(null);
    setDropAt(null);
    setChip(null);
    if (!current || current.cancelled) return;
    const point = pointOf(event);
    const target = cardAtPoint(point.x, point.y, sectionRef.current);
    if (target === current.source) {
      setNote({ laid, text: 'No relationship added.' });
      return;
    }
    if (target !== undefined) {
      setPop({
        kind: 'relationship',
        source: current.source,
        target,
        ...placeAt(point.x, point.y),
      });
      return;
    }
    const box = sectionRef.current?.getBoundingClientRect();
    const inside =
      box &&
      point.x >= box.left &&
      point.x <= box.right &&
      point.y >= box.top &&
      point.y <= box.bottom;
    if (!inside) {
      setNote({ laid, text: 'No relationship added.' });
      return;
    }
    // Dropped on empty canvas: offer a new element there, then the relationship.
    setPop({
      kind: 'element',
      at: flow.screenToFlowPosition(point),
      from: current.source,
      ...placeAt(point.x, point.y, 320, 320),
    });
  };

  const newElementAt = (x: number, y: number) => {
    setRelated(null);
    setEdgeMenu(null);
    setPop({
      kind: 'element',
      at: flow.screenToFlowPosition({ x, y }),
      ...placeAt(x, y, 320, 320),
    });
  };

  /** `N`: New element at the centre of the view. Esc goes back to where focus was then. */
  const newElementAtCentre = () => {
    const box = sectionRef.current?.getBoundingClientRect();
    if (!box || !editable) return;
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const opener = document.activeElement;
    setRelated(null);
    setPop({
      kind: 'element',
      at: flow.screenToFlowPosition({ x, y }),
      top: Math.max(8, box.height / 2 - 160),
      left: Math.max(8, box.width / 2 - 160),
      ...(opener instanceof HTMLElement && opener !== document.body ? { opener } : {}),
    });
  };

  /** Selects a card and pans to it, keeping the zoom ("Show on canvas"). */
  const revealCard = (id: string, focus: boolean) => {
    const at = absolute.get(id);
    if (!at) return;
    setActiveId(id);
    // Centred, at the same zoom, and clear of the panels on a small canvas.
    const { width, height } = store.getState();
    const zoom = flow.getZoom();
    const centred = {
      x: width / 2 - (at.x + at.width / 2) * zoom,
      y: height / 2 - (at.y + at.height / 2) * zoom,
      zoom,
    };
    fittedPanelRef.current = null;
    void flow.setViewport(clearOfViewpoints(id, centred) ?? centred, {
      duration: reducedMotion() ? 0 : 200,
    });
    if (focus) focusCardOf(id);
  };

  const closePop = (focusSource: boolean) => {
    const current = pop;
    setPop(null);
    if (!focusSource || !current) return;
    if (current.kind === 'relationship') focusCardOf(current.source);
    else if (current.from !== undefined) focusCardOf(current.from);
    else if (current.opener?.isConnected === true) current.opener.focus();
    else sectionRef.current?.focus();
  };

  /** Events on the canvas itself: a double click adds an element, and element list rows drop. */
  const sectionEvents = {
    onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target as HTMLElement;
      if (!editable || !target.closest('.react-flow__pane') || target.closest('.card')) return;
      newElementAt(event.clientX, event.clientY);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      if (!props.onBringElement || !event.dataTransfer.types.includes(elementDragType)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setDropTarget(true);
    },
    onDragLeave: (event: DragEvent<HTMLElement>) => {
      if (!(
        event.relatedTarget instanceof Node && sectionRef.current?.contains(event.relatedTarget)
      ))
        setDropTarget(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      setDropTarget(false);
      const id = event.dataTransfer.getData(elementDragType);
      if (!props.onBringElement || !graph.elements.has(id)) return;
      event.preventDefault();
      // On a card or on empty canvas alike: the element lands at the nearest free spot.
      const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (!laid?.placed.has(id)) hintAt(id, at);
      props.onBringElement(id);
    },
  };

  return {
    sectionEvents,
    hintAt,
    openLink,
    focusCardOf,
    onConnectStart,
    onConnectEnd,
    newElementAt,
    newElementAtCentre,
    revealCard,
    closePop,
  };
}

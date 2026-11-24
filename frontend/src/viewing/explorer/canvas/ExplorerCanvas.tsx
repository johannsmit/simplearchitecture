import { defaultNeighbourhoodCap, type ModelRelationship } from '@simplearchitecture/shared';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  useReactFlow,
  useStoreApi,
  useUpdateNodeInternals,
} from '@xyflow/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../../../icons';
import { cardShape } from '../../../metamodel-ui';
import { counted } from '../../../words';
import { keepPopoversInside } from './canvasDom';
import { fitCanvas, panelBox, refitOnPanelResize, type FittedPanel } from './canvasFit';
import { afterLayout, announcementOf, type PendingFocus } from './canvasFocus';
import { useFontsReady, usePointerLast } from './canvasHooks';
import { layOutCanvas, type StoredLayout } from './canvasLayout';
import {
  arrangedLayoutOf,
  relationshipEdgesOf,
  withoutLineRoutes,
  type LineDrag,
} from './canvasLines';
import {
  clickAfterDrag,
  noEdges,
  noRoutes,
  popupWidth,
  reducedMotion,
  type CanvasNode,
  type CanvasPop,
  type Hover,
  type LatestCallbacks,
  type Laid,
  type Moving,
  type Note,
  type RelatedState,
} from './canvasModel';
import { CanvasPopovers, CanvasRelatedPopup } from './CanvasPopovers';
import { CanvasTop } from './CanvasTop';
import { holdingOf, resizeWithGrip, settleAfterDrop } from './cardDrag';
import { EdgeMenu } from './EdgeMenu';
import type { ExplorerCanvasProps } from './explorerCanvasProps';
import { flowSettings } from './flowSettings';
import {
  fittedBend,
  heldAfterMove,
  pressBend,
  pressLine,
  type FitBend,
  type RouteMoved,
} from './lineDrag';
import type { PlaceHint } from './placeCards';
import { panClearOf, type Box, type Holding, type Point, type Viewport } from './positions';
import { EdgeMarkers, type LinePress, type RelationshipFlowEdge } from './RelationshipEdge';
import { followDrawing, type Drawing } from './relationshipDrawing';
import { useCanvasGeometry } from './useCanvasGeometry';
import { useCanvasKeyboard } from './useCanvasKeyboard';
import { useCanvasNodes } from './useCanvasNodes';
import { useCanvasPopovers } from './useCanvasPopovers';
import { useCardSelection } from './useCardSelection';
import { useConnectHot } from './useConnectHot';
import { useFlowEvents } from './useFlowEvents';
import { useHeldRoutes, useLineRoutes } from './useLineRoutes';
import { mergeRelationships } from './view';
import { ZoomControls } from './ZoomControls';

// Tests and callers import the line picking from here.
export { nearestLineAt } from './canvasDom';

/**
 * The focused element and its neighbours, laid out by ELK, drawn with React Flow. Read-only: cards
 * can't be connected, and moving them (mouse drag, or M then arrows) changes only the picture,
 * except in a view that can change, which saves it (`onArranged`). One Tab stop (the focused element's card); arrow keys move between cards.
 */
export function ExplorerCanvas(props: ExplorerCanvasProps) {
  const { graph, hood, focusId, depth } = props;
  const inView = props.viewName !== undefined;
  const showRelatedPill = props.related !== false;
  // The card with the first Tab stop: the focused element's, or in a view the first card.
  const homeId = hood.hops.has(focusId) ? focusId : (hood.hops.keys().next().value ?? focusId);
  const flow = useReactFlow<CanvasNode, RelationshipFlowEdge>();
  const updateNodeInternals = useUpdateNodeInternals();
  const section = useRef<HTMLElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const [laid, setLaid] = useState<Laid | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  // The card that takes keyboard focus (roving tabindex): the focused element's card until the
  // arrow keys move it.
  const [active, setActive] = useState({ focusId, id: focusId });
  const activeId = active.focusId === focusId && hood.hops.has(active.id) ? active.id : homeId;
  const setActiveId = (id: string) => {
    setActive({ focusId, id });
  };
  const focusName = graph.elements.get(focusId)?.name ?? '';
  const [related, setRelated] = useState<RelatedState | null>(null);
  /** Keyboard focus to restore after the next layout: a card's main or pill. */
  const pendingFocus = useRef<PendingFocus>(null);
  /** Keyboard focus was in the canvas, so it should stay there when cards come and go. */
  const hadFocus = useRef(false);
  // The layout effect reads the moved cards when ELK answers, without re-running on every move.
  const movedRef = useRef(props.moved);
  useEffect(() => {
    movedRef.current = props.moved;
  });
  /** What the live region says after a keyboard move, a tidy or a moved line. */
  const [note, setNote] = useState<Note | null>(null);
  /** The card being dragged with the mouse: edge labels are hidden until the drop. */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragging = draggingId !== null;
  /**
   * The card held (dragged, or in keyboard move mode) and every card's size when that started:
   * until the drop, the containers it is in only grow.
   */
  const [hold, setHold] = useState<Holding | null>(null);
  /** The hold, for the layout effect: a card resized in move mode keeps the hold's picture. */
  const holdingRef = useRef<Holding | undefined>(undefined);
  /** A hold just dropped: once the canvas shows the drop, a grown container pushes cards aside. */
  const dropped = useRef<Holding | null>(null);
  /** Cards were just given new places after a drop: the layout is reported once they show. */
  const settling = useRef(false);
  // The person changed the arrangement (a move, a resize, or `arrangeRequest`): reported once
  // the canvas shows it. The tick only makes the report's effect run.
  const arrangeWanted = useRef(false);
  const arrangeSeen = useRef(props.arrangeRequest);
  const [arrangeTick, setArrangeTick] = useState(0);
  const wantArranged = useCallback(() => {
    arrangeWanted.current = true;
    setArrangeTick((n) => n + 1);
  }, []);
  const [movingState, setMoving] = useState<Moving | null>(null);
  const editable = props.editable === true && props.modelId !== undefined;
  const store = useStoreApi();
  /**
   * The panels at the top left (Show Viewpoints, then Group by), always open: fits and keyboard
   * focus keep cards clear of their column.
   */
  const viewpoints = useRef<HTMLDivElement>(null);
  const pointerLast = usePointerLast();
  /** The panels' box, in screen pixels from the canvas's top left. */
  const viewpointsBox = useCallback(
    (): Box | undefined => panelBox(section.current, viewpoints.current),
    [],
  );
  /**
   * The panels' size at the last fit, while the view is still as that fit left it; null once
   * the person has panned, zoomed or moved anything since (or nothing was fitted yet).
   */
  const fittedPanel = useRef<FittedPanel>(null);
  /** Fits the whole drawing, with every card clear of the panels. */
  const fit = useCallback(
    (duration: number) => {
      fitCanvas(flow, store, viewpointsBox, fittedPanel, duration);
    },
    [flow, store, viewpointsBox],
  );
  // The panels can change size after a fit: fit again, unless the person has moved the view since.
  useEffect(
    () => refitOnPanelResize(viewpoints.current, fittedPanel, viewpointsBox, fit),
    [fit, viewpointsBox],
  );
  /** The person did something on the canvas (not in the panels): the last fit no longer holds. */
  const onCanvasInput = (event: { target: EventTarget }) => {
    if (!(event.target instanceof Node && viewpoints.current?.contains(event.target))) {
      fittedPanel.current = null;
    }
  };
  /** Drawing a relationship: from this element. Esc cancels (then the drop is ignored). */
  const drawing = useRef<Drawing>(null);
  const [drawingFrom, setDrawingFrom] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; ok: boolean } | null>(null);
  const [chip, setChip] = useState<{ x: number; y: number } | null>(null);
  const [pop, setPop] = useState<CanvasPop | null>(null);
  /** A row from the element list is dragged over the canvas. */
  const [dropTarget, setDropTarget] = useState(false);
  const [edgeMenu, setEdgeMenu] = useState<{ ids: string[]; top: number; left: number } | null>(
    null,
  );
  // A line's chooser has nothing to point at once the lines go (Show relationships, in the legend).
  if (edgeMenu !== null && !props.lines) setEdgeMenu(null);
  const relationshipById = useMemo(
    () => new Map<string, ModelRelationship>(graph.relationships.map((r) => [r.id, r])),
    [graph],
  );

  const showRelated = useCallback((cardId: string, opener: HTMLButtonElement) => {
    const box = section.current?.getBoundingClientRect();
    const at = opener.getBoundingClientRect();
    if (!box) return;
    setRelated((current) =>
      current?.cardId === cardId
        ? null
        : {
            cardId,
            opener,
            top: Math.max(8, at.bottom - box.top + 6),
            left: Math.max(8, Math.min(at.left - box.left, box.width - popupWidth - 8)),
          },
    );
  }, []);

  const fontsReady = useFontsReady();

  // React Flow's wrapper says role="application", which would switch screen readers out of
  // browse mode for the whole canvas. Cards are plain buttons, so drop it.
  useEffect(() => {
    wrapper.current?.removeAttribute('role');
  });

  const links = useMemo(() => mergeRelationships(hood.relationships), [hood]);

  const { nest } = props;

  // The latest canvas and page callbacks, read by the layout effect without re-running it.
  const laidRef = useRef(laid);
  const latest = useRef<LatestCallbacks>({
    onMove: props.onMove,
    onResize: props.onResize,
    flow,
  });
  useEffect(() => {
    laidRef.current = laid;
    latest.current = { onMove: props.onMove, onResize: props.onResize, flow };
  });
  /** Where new cards should go (a drop point, or next to a card), until they are placed. */
  const hints = useRef(new Map<string, PlaceHint>());
  // Read only when the canvas is a new one, so a layout saved meanwhile moves nothing.
  const storedRef = useRef<StoredLayout>({
    cards: props.storedLayout,
    routes: props.storedRoutes,
    groupBy: props.storedGroupBy,
  });
  useEffect(() => {
    storedRef.current = {
      cards: props.storedLayout,
      routes: props.storedRoutes,
      groupBy: props.storedGroupBy,
    };
  });
  /** How many new canvases there have been: each one's routes given by hand start afresh. */
  const canvasCount = useRef(0);

  const { layoutKey, widths, groupBy } = props;
  // A new canvas is measured (after the fonts load) and laid out in ELK's worker. Any other change
  // (cards or lines added or taken off, an element edited) keeps every card where it is.
  useEffect(
    () =>
      layOutCanvas({
        fontsReady,
        hood,
        links,
        graph,
        nest,
        layoutKey,
        widths,
        groupBy,
        laidRef,
        holdingRef,
        hints,
        section,
        latest,
        movedRef,
        storedRef,
        canvasCount,
        arrangeWanted,
        setLaid,
        setLayoutError,
        setNote,
      }),
    [fontsReady, hood, links, graph, nest, layoutKey, widths, groupBy],
  );

  // Where the cards are drawn: the layout, with the moved cards where the user put them, and the
  // containers they are in fitted to what they hold (while a card is held, only growing).
  const { moved } = props;
  const holding =
    hold && (hold.id === draggingId || hold.id === movingState?.id) ? hold : undefined;
  useEffect(() => {
    holdingRef.current = holding;
  });
  const { domIds, elementIds, flowId, groupHeads, shown, absolute, endBoxes } = useCanvasGeometry({
    laid,
    moved,
    holding,
    graph,
    hoodFocusId: hood.focusId,
  });
  // After a drop, the places the fit gave the cards inside a container become theirs, and a
  // container that grew over cards beside it pushes them down. Then the drop is reported.
  const { onMove } = props;
  useEffect(() => {
    settleAfterDrop({ laid, shown, moved, holding, onMove, wantArranged, dropped, settling });
  }, [laid, shown, moved, holding, onMove, wantArranged]);
  /** Every card's size as drawn now: where a hold starts from. */
  const holdFrom = (id: string, others?: readonly string[]): Holding =>
    holdingOf(shown, id, others);
  const shownRef = useRef(shown);
  useEffect(() => {
    shownRef.current = shown;
  });
  /** A rectangle card (not a circle or a container): its width can be set by hand. */
  const isResizable = (id: string) => {
    const element = graph.elements.get(id);
    return element !== undefined && cardShape(element.type) === 'card' && !laid?.containers.has(id);
  };
  /** The width grip: the card's width when the press started, plus how far the pointer went. */
  const resizing = useRef<{ id: string; width: number } | null>(null);
  /** A card's width is being set with its grip: lines show no bend handles meanwhile. */
  const [resizingCard, setResizingCard] = useState(false);
  const resizeFromGrip = useCallback(
    (id: string, phase: 'start' | 'move' | 'end', dx: number) => {
      resizeWithGrip(id, phase, dx, {
        shown: shownRef,
        resizing,
        setResizingCard,
        setRelated,
        latest,
        wantArranged,
      });
    },
    [wantArranged],
  );
  /** The viewport panned so a box (flow coordinates) is clear of the panels, if it isn't. */
  const clearOfViewpointsAt = (box: Box, viewport: Viewport): Viewport | undefined => {
    const panel = viewpointsBox();
    return panel ? panClearOf(box, viewport, panel) : undefined;
  };
  /** The same for a card on the canvas, by element id. */
  const clearOfViewpoints = (
    id: string,
    viewport: Viewport = flow.getViewport(),
  ): Viewport | undefined => {
    const at = absolute.get(id);
    return at ? clearOfViewpointsAt(at, viewport) : undefined;
  };

  const { connectHot, onPointerMove } = useConnectHot({
    editable,
    laid,
    draggingId,
    flow,
    endBoxes,
  });

  // Lines moved by hand (in a view): the routes this canvas started with, or as last dragged.
  const { held, setHeldState } = useHeldRoutes(laid, hood);

  // Move mode ends by itself when the focus changes or the card leaves the canvas.
  const moving = movingState?.focusId === focusId && shown.has(movingState.id) ? movingState : null;
  const movingId = moving?.id;

  // The details card, and the cards picked with it (Shift, Ctrl or Cmd + click): a new canvas
  // (another element or view, depth, Nest, Group by) leaves only the details card.
  const { selected, selectedIds, pick, endPicks } = useCardSelection({
    props,
    canvasKey: `${focusId}|${props.layoutKey}`,
    laid,
    setNote,
  });

  const { highlight, missing, nodes, cardBoxes } = useCanvasNodes({
    hover,
    laid,
    graph,
    showRelatedPill,
    activeId,
    domIds,
    related,
    showRelated,
    movingId,
    draggingId,
    editable,
    connectHot,
    dropAt,
    selectedIds,
    removable: props.removable,
    resizeFromGrip,
    onRemoveCard: props.onRemoveCard,
    inView,
    groupHeads,
    shown,
    absolute,
    flowId,
    relationshipById,
    selectedRelationshipId: props.selectedRelationshipId,
  });

  /** What a click on a line or its label does (`openLink`, below), for the edges' callbacks. */
  const latestOpenLink = useRef<(linkId: string, clientX: number, clientY: number) => void>(
    () => undefined,
  );

  // In a view that saves its layout, a line's bends can be dragged.
  const linesMovable = inView && editable && props.onArranged !== undefined;
  /**
   * A bend being dragged, on this line: from 4px of movement on, the line as it would be if
   * dropped now (`points`).
   */
  const [lineDrag, setLineDrag] = useState<LineDrag | null>(null);
  const { selectedRelationshipId: chosen, litRelationshipId: fresh, shownProperties } = props;
  // Bend handles show on the line under the pointer and on the open relationship's line; while a
  // bend is dragged, only on its line. None while a card is dragged, moved or resized, or while a
  // relationship is drawn.
  const hoveredLink = hover?.kind === 'link' ? hover.id : undefined;
  const bendsAllowed =
    linesMovable && !dragging && moving === null && !resizingCard && drawingFrom === null;
  const { handRoutes, floating, bendLinkIds } = useLineRoutes({
    laid,
    absolute,
    endBoxes,
    held,
    bendsAllowed,
    lineDrag,
    hoveredLink,
    chosen,
  });

  // Tidy relations can be used once the canvas is laid out and draws a line.
  const relationsTidyable =
    props.lines && laid !== null && laid.key === props.layoutKey && laid.drawn.length > 0;
  const { onRelationsTidyable } = props;
  useEffect(() => {
    onRelationsTidyable?.(relationsTidyable);
  }, [relationsTidyable, onRelationsTidyable]);
  // After "Tidy relations" (set while rendering, so a save asked for with it sees the result): the
  // cards stay, the routes given by hand go, and every line follows its cards. Said at once, as
  // there is no layout to wait for.
  const relationsTidyCount = props.relationsTidyCount ?? 0;
  const [relationsSeen, setRelationsSeen] = useState(relationsTidyCount);
  if (relationsSeen !== relationsTidyCount) {
    setRelationsSeen(relationsTidyCount);
    if (laid && relationsTidyable) {
      const next = withoutLineRoutes(laid);
      setLaid(next);
      setHeldState({ canvas: laid.canvas, routes: noRoutes });
      setNote({
        laid: next,
        text:
          handRoutes.size > 0
            ? 'Relations tidied up, including lines moved by hand. No card moved.'
            : 'Relations tidied up. No card moved.',
        canvas: laid.canvas,
      });
    }
  }

  /** A line dropped where the person dragged it: held for every relationship on it, and saved. */
  const latestRouteMoved = useRef<RouteMoved>(() => undefined);
  /**
   * When a line was last dropped, its drag cancelled, or the canvas panned from it: the click that
   * ends it opens nothing.
   */
  const routeMovedAt = useRef(-Infinity);
  /** A line with a bend dragged to a point; undefined where no such line fits. */
  const latestFitted = useRef<FitBend>(() => undefined);
  useEffect(() => {
    latestFitted.current = (linkId, line, index, to) =>
      fittedBend(laid, endBoxes, flow, linkId, line, index, to);
    latestRouteMoved.current = (linkId, line) => {
      routeMovedAt.current = performance.now();
      const next = heldAfterMove(laid, endBoxes, held, linkId, line);
      if (!laid || !next) return;
      setHeldState({ canvas: laid.canvas, routes: next });
      setEdgeMenu(null);
      setNote({ laid, text: 'Line moved.', canvas: laid.canvas });
      wantArranged();
    };
  });
  // Every line as drawn now (reported by the lines), to find the bend nearest a press.
  const drawnLines = useRef(new Map<string, readonly Point[]>());
  const lineDrawn = useCallback((linkId: string, line: readonly Point[] | undefined) => {
    if (line) drawnLines.current.set(linkId, line);
    else drawnLines.current.delete(linkId);
  }, []);
  /** The lines whose bend handles show now: a press grabs the nearest of their bends. */
  const bendLines = useRef<readonly string[]>([]);
  const bendDrag = useRef<{ stop: () => void } | null>(null);
  useEffect(
    () => () => {
      bendDrag.current?.stop();
    },
    [],
  );
  /**
   * What the live region says, for the drag's handlers, until another message or a new canvas
   * (an empty text empties it).
   */
  const latestNote = useRef<(text: string) => void>(() => undefined);
  useEffect(() => {
    latestNote.current = (text) => {
      setNote({ laid, text, ...(laid ? { canvas: laid.canvas } : {}) });
    };
  });
  /** A press on a bend handle: the nearest bend among the lines whose handles show is dragged. */
  const bendPress = useCallback(
    (press: LinePress): boolean =>
      pressBend(press, {
        flow,
        bendDrag,
        bendLines,
        drawnLines,
        latestFitted,
        latestRouteMoved,
        latestNote,
        routeMovedAt,
        setLineDrag,
      }),
    [flow],
  );
  /** A press on a line: a drag pans the canvas, less is a click. */
  const linePress = useCallback(
    (press: LinePress): boolean => pressLine(press, flow, routeMovedAt, setRelated),
    [flow],
  );

  // Where every card is, and the route of every line moved by hand or on the layout's route, once
  // the canvas shows the person's change: the layout made for this canvas, its cards and its widths.
  const { onArranged, arrangeRequest } = props;
  useEffect(() => {
    if (arrangeSeen.current !== arrangeRequest) {
      arrangeSeen.current = arrangeRequest;
      arrangeWanted.current = true;
    }
    if (!arrangeWanted.current || !laid || settling.current) return;
    if (laid.key !== layoutKey || laid.hood !== hood || laid.widths !== widths) return;
    arrangeWanted.current = false;
    onArranged?.(arrangedLayoutOf({ laid, shown, graph, widths, hood, endBoxes, held }));
  }, [
    arrangeTick,
    arrangeRequest,
    laid,
    layoutKey,
    hood,
    widths,
    shown,
    graph,
    onArranged,
    held,
    endBoxes,
  ]);
  useEffect(() => {
    bendLines.current = bendLinkIds;
  });
  const edges = useMemo(
    () =>
      relationshipEdgesOf({
        laid,
        graph,
        highlight,
        flowId,
        cardBoxes,
        dragging,
        chosen,
        fresh,
        floating,
        handRoutes,
        lineDrag,
        linesMovable,
        bendLinkIds,
        shownProperties,
      }).map((edge) => ({
        ...edge,
        data: {
          ...edge.data,
          ...(linesMovable
            ? { onBendPress: bendPress, onLinePress: linePress, onLineDrawn: lineDrawn }
            : {}),
          // The label and the bend handles are part of the line: hovering keeps it lit, a click
          // opens it.
          onLineClick: (clientX: number, clientY: number) => {
            if (performance.now() - routeMovedAt.current < clickAfterDrag) return;
            latestOpenLink.current(edge.id, clientX, clientY);
          },
          onLineHover: (over: boolean) => {
            setHover(over ? { kind: 'link', id: edge.id } : null);
          },
        },
      })),
    [
      laid,
      graph,
      highlight,
      flowId,
      cardBoxes,
      dragging,
      chosen,
      fresh,
      floating,
      handRoutes,
      lineDrag,
      linesMovable,
      bendPress,
      linePress,
      bendLinkIds,
      lineDrawn,
      shownProperties,
    ],
  );

  // After a change: re-read the handles, fit the view to a new layout, and keep keyboard focus in
  // the canvas.
  const fitted = useRef<Laid | null>(null);
  useEffect(() => {
    if (!laid) return;
    return afterLayout({
      laid,
      updateNodeInternals,
      flowId,
      domIds,
      missing,
      fit,
      fitted,
      pendingFocus,
      section,
      hadFocus,
    });
  }, [laid, flow, updateNodeInternals, graph, domIds, flowId, missing, fit]);

  useEffect(() => {
    if (!laid) return;
    const frame = requestAnimationFrame(() => {
      fit(0);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
    // Only when the space around the canvas changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitKey]);

  const closeRelated = useCallback((returnFocus: boolean) => {
    setRelated((current) => {
      if (current && returnFocus) current.opener.focus();
      return null;
    });
  }, []);

  const addRelated = (id: string) => {
    const opener = related?.cardId;
    setRelated(null);
    if (opener !== undefined) {
      pendingFocus.current = { id: opener, part: 'related' };
      hints.current.set(id, { near: opener });
    }
    props.onAddElement(id);
  };

  const nameOf = (id: string) => graph.elements.get(id)?.name || '(unnamed)';

  const { onKeyDown, onFocusCapture, onBlurCapture } = useCanvasKeyboard({
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
    picked: selected.length,
    endPicks,
    dragging,
    resizingCard,
    lineDragging: lineDrag !== null,
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
    sectionRef: section,
    droppedRef: dropped,
    hadFocusRef: hadFocus,
    pointerLastRef: pointerLast,
    fittedPanelRef: fittedPanel,
  });

  // Only a new canvas waits for ELK; other changes are drawn at once.
  const pending = laid?.key !== props.layoutKey && layoutError === null;
  const announcement = announcementOf(
    note,
    laid,
    graph,
    { inView, viewName: props.viewName },
    groupHeads.size,
  );

  const {
    sectionEvents,
    hintAt,
    openLink,
    focusCardOf,
    onConnectStart,
    onConnectEnd,
    newElementAtCentre,
    revealCard,
    closePop,
  } = useCanvasPopovers({
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
    sectionRef: section,
    drawingRef: drawing,
    fittedPanelRef: fittedPanel,
    hintsRef: hints,
  });
  useEffect(() => {
    latestOpenLink.current = openLink;
  });

  // Once drawn, and whenever they resize, the popovers are kept 8px inside the canvas.
  useLayoutEffect(() => {
    const host = section.current;
    if (!host || (pop === null && edgeMenu === null)) return;
    return keepPopoversInside(host);
  }, [pop, edgeMenu]);

  // While drawing: the card under the pointer (and the chip over the source), and Esc.
  useEffect(() => {
    if (drawingFrom === null) return;
    return followDrawing({
      drawingFrom,
      section,
      drawing,
      store,
      laid,
      setDropAt,
      setChip,
      setDrawingFrom,
      setNote,
    });
  }, [drawingFrom, store, laid]);

  // `N`: at the centre of the view. Esc goes back to where focus was when `N` was pressed.
  const newRequest = useRef(props.newElementRequest);
  useEffect(() => {
    if (newRequest.current === props.newElementRequest) return;
    newRequest.current = props.newElementRequest;
    newElementAtCentre();
    // Only on a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.newElementRequest]);

  const revealN = useRef(props.reveal?.n);
  useEffect(() => {
    if (!props.reveal || revealN.current === props.reveal.n) return;
    revealN.current = props.reveal.n;
    revealCard(props.reveal.id, true);
    // Only on a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal]);

  const flowEvents = useFlowEvents({
    props,
    focusId,
    elementIds,
    hold,
    holdFrom,
    shown,
    selected,
    pick,
    endPicks,
    wantArranged,
    openLink,
    setRelated,
    setHold,
    setDraggingId,
    setHover,
    setEdgeMenu,
    droppedRef: dropped,
    routeMovedAtRef: routeMovedAt,
  });

  return (
    <section
      ref={section}
      id="canvas"
      className={`canvas${dragging ? ' is-dragging' : ''}${lineDrag ? ' is-bending' : ''}${dropTarget ? ' is-drop-target' : ''}${drawingFrom !== null ? ' is-drawing' : ''}${editable ? ' is-editable' : ''}`}
      tabIndex={-1}
      onPointerDownCapture={onCanvasInput}
      onWheelCapture={onCanvasInput}
      onKeyDownCapture={onCanvasInput}
      aria-label={
        inView
          ? `Diagram: view ${props.viewName || '(unnamed)'}, ${counted(hood.hops.size, 'element')}`
          : `Diagram: ${focusName || '(unnamed)'} and its neighbours, depth ${depth}`
      }
      onKeyDown={onKeyDown}
      {...sectionEvents}
      onFocusCapture={onFocusCapture}
      onPointerMove={onPointerMove}
      onBlurCapture={onBlurCapture}
    >
      <EdgeMarkers />
      <ReactFlow<CanvasNode, RelationshipFlowEdge>
        ref={wrapper}
        nodes={nodes}
        edges={props.lines ? edges : noEdges}
        {...flowSettings}
        {...flowEvents}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        nodesConnectable={editable}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.3} color="var(--grid-dot)" />
      </ReactFlow>

      <p className="vh" aria-live="polite">
        {announcement}
      </p>
      {props.emptyText !== undefined && hood.hops.size === 0 && (
        <div className="canvas-empty-over">
          <div className="empty">{props.emptyText}</div>
        </div>
      )}

      {related && (
        <CanvasRelatedPopup
          related={related}
          graph={graph}
          laid={laid}
          full={hood.hops.size >= defaultNeighbourhoodCap}
          onPick={addRelated}
          onClose={closeRelated}
        />
      )}

      {chip && (
        <p className="drop-chip" style={{ left: chip.x, top: chip.y }} aria-hidden="true">
          <Icon name="alert" size="sm" />
          Can&apos;t connect an element to itself
        </p>
      )}
      <CanvasPopovers
        canvas={props}
        pop={pop}
        editable={editable}
        nameOf={nameOf}
        isOnCanvas={(id) => laid?.placed.has(id) === true}
        setPop={setPop}
        closePop={closePop}
        focusCardOf={focusCardOf}
        revealCard={revealCard}
        placeAt={hintAt}
      />
      {edgeMenu && (
        <EdgeMenu
          menu={edgeMenu}
          graph={graph}
          relationshipById={relationshipById}
          onClose={() => {
            setEdgeMenu(null);
          }}
          onOpen={(id) => {
            props.onOpenRelationship?.(id);
          }}
        />
      )}

      <CanvasTop
        canvas={props}
        panelsRef={viewpoints}
        inView={inView}
        pending={pending}
        layoutError={layoutError}
        moving={moving ? { name: nameOf(moving.id), resizable: isResizable(moving.id) } : null}
      />
      <ZoomControls
        onFit={() => {
          fit(reducedMotion() ? 0 : 200);
        }}
      />
    </section>
  );
}

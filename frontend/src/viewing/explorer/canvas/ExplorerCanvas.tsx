import {
  containsType,
  displayLabel,
  elementArchitectureState,
  defaultNeighbourhoodCap,
  missingRelatedCount,
  missingRelatedElements,
  nodeTypeDefinitions,
  relationshipVerb,
  type ElementChangeResult,
  type ModelGraph,
  type ModelRelationship,
  type Neighbourhood,
  type RelationshipChangeResult,
  type GroupByChoice,
  type RelationshipViewField,
  type ViewCardLayout,
  type ViewLineRoute,
} from '@simplearchitecture/shared';
import {
  Background,
  BackgroundVariant,
  getBezierPath,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  useStoreApi,
  useUpdateNodeInternals,
  type ConnectionLineComponentProps,
  type EdgeTypes,
  type FitViewOptions,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Icon } from '../../../icons';
import { cardShape, EdgeSample } from '../../../metamodel-ui';
import { counted, formatNumber } from '../../../words';
import { NewElementForm } from '../../../modelling/NewElement';
import { NewRelationshipPopover, relationshipSentence } from '../../../modelling/relationships';
import { nestingParents } from '../views';
import {
  cardHeightAt,
  cardNameCut,
  cardSize,
  containerMinSize,
  containerNameWidth,
  maxSetCardWidth,
  minCardWidth,
  isCircleNameCut,
  isContainerNameCut,
  whenFontsReady,
} from './cardSize';
import { connectHandleAt } from './connectHandle';
import { ElementCard, relatedButtonId, type CardNode } from './ElementCard';
import { currentBends, floatingEnds, simplified, type EndBox, type FloatingLine } from './edgeLine';
import { getElk } from './elkEngine';
import {
  absoluteBoxes,
  containerBox,
  layoutCards,
  layoutFailureMessage,
  layoutTimeLimit,
  LayoutTimeoutError,
  portId,
  withinTimeLimit,
  type LayoutCard,
  type PlacedCard,
  type PlacedHandle,
  type Side,
} from './elkLayout';
import {
  arrangeCards,
  clampToContainer,
  clearFitPadding,
  fitContainers,
  dragThreshold,
  draggedPositions,
  isMoveKey,
  movedBy,
  moveStep,
  panClearOf,
  panToKeepInView,
  pushedByContainer,
  type Box,
  type Holding,
  type MovedPositions,
  type Point,
  type Viewport,
} from './positions';
import { LineProperties } from './LineProperties';
import { GroupBox, groupHandleClass, type GroupNode } from './GroupBox';
import { GroupByPanel } from './GroupByPanel';
import {
  groupCards,
  groupedText,
  groupHeaderWidth,
  groupMinSize,
  groupNowOf,
  groupValueText,
} from './groups';
import { frameOf, groupTextArea, groupValueOf, isGroupId } from './layoutGeometry';
import {
  bendAt,
  bendSnap,
  endPlace,
  fitEnds,
  followCards,
  heldFromStored,
  laidLine,
  moveBend,
  routesToSave,
  squared,
  withLaidRoutes,
  type HeldRoute,
} from './lineRoutes';
import { keepCards, relinkHandles, samePlacement, type PlaceHint } from './placeCards';
import { RelatedPopup } from './RelatedPopup';
import {
  groupOfCard,
  layoutOfCanvas,
  storedGroupedPositions,
  storedPlacement,
  storedPositions,
  type CanvasLayout,
} from './viewLayout';
import {
  EdgeMarkers,
  litArrowMarkerId,
  RelationshipEdge,
  type LinePress,
  type RelationshipFlowEdge,
} from './RelationshipEdge';
import {
  elementDragType,
  isGrayed,
  linkDataParts,
  linkText,
  layoutLinkRelationships,
  layoutLinks,
  mergeRelationships,
  nearestInDirection,
  type CanvasLink,
  type Direction,
} from './view';

const flowNodeTypes: NodeTypes = { element: ElementCard, groupBox: GroupBox };

/** What React Flow draws as nodes: cards, and Group by's boxes. */
type CanvasNode = CardNode | GroupNode;
const flowEdgeTypes: EdgeTypes = { relationship: RelationshipEdge };

/** The zoom a fit may choose; its padding keeps the cards clear of the panels at the top left. */
const fitZoom = { min: 0.2, max: 1.25 } as const;

/** A width set by hand, within the smallest and the widest a card's width can be set to. */
function setWidth(width: number): number {
  return Math.min(maxSetCardWidth, Math.max(minCardWidth, Math.round(width)));
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const arrowDirections: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

interface ExplorerCanvasProps {
  graph: ModelGraph;
  /** What to draw: the neighbourhood plus any elements added from a card's related elements. */
  hood: Neighbourhood;
  focusId: string;
  depth: number;
  /** Elements requested but left out because the canvas was full. */
  refused: number;
  /** The relationship properties a viewpoint can show. */
  lineFields: readonly RelationshipViewField[];
  /** The ones selected: a selection changes how lines look, never the layout. */
  shownProperties: readonly string[];
  onShownProperties: (keys: string[]) => void;
  /** The element properties the cards can be grouped by (Group by); none: no panel. */
  groupChoices?: readonly GroupByChoice[];
  /**
   * The property the cards are grouped by, one box per value, or undefined for none. A change lays
   * the canvas out again (the page makes it part of `layoutKey`).
   */
  groupBy?: string | undefined;
  onGroupBy?: (key: string | undefined) => void;
  /** Adds a related element to the canvas (the focused element stays the same). */
  onAddElement: (id: string) => void;
  /** A double click (or Enter) on a card: it becomes the focus element. */
  onFocusElement: (id: string) => void;
  /** The element shown in the details panel: the focus element unless another is picked. */
  selectedId?: string | undefined;
  /** A single click on a card, or the arrow keys: select it without changing the canvas. */
  onSelectElement?: (id: string) => void;
  onDepth: (depth: number) => void;
  /** Changes when the space around the canvas changes, so the view is fitted again. */
  fitKey: string;
  /** Cards the user moved. Cleared by the page on a focus or depth change. */
  moved: MovedPositions;
  /**
   * A card was dragged or moved with the keyboard to this position; undefined puts it back in the
   * layout (a cancelled keyboard move of a card that hadn't moved before).
   */
  onMove: (id: string, position: Point | undefined) => void;
  /** Card widths set by hand (rectangle cards only): cleared by a new canvas (a view's stay). */
  widths: ReadonlyMap<string, number>;
  /** A card's width was set (its grip, or `Alt` + arrows in move mode); undefined drops it. */
  onResize: (id: string, width: number | undefined) => void;
  /** Goes up by one on each "Tidy up": the view is fitted again and the change announced. */
  tidyCount: number;
  /**
   * Changes when the canvas is a new one (another element or view, a depth, the Nest switch, Tidy
   * up): only then is it laid out. Any other change keeps every card where it is.
   */
  layoutKey: string;
  /** Cards or lines came or went without a new layout: Tidy up has something to do. */
  onKept?: (layoutKey: string) => void;
  /**
   * Goes up by one on each "Tidy relations": every card stays where it is, and every line is drawn
   * again from the cards, its route from the layout or by hand dropped. No new layout.
   */
  relationsTidyCount?: number;
  /** Whether Tidy relations can be used now: the canvas draws a line and isn't laying out. */
  onRelationsTidyable?: (can: boolean) => void;
  /** `T` on the canvas, when Tidy relations can be used. */
  onTidyRelations?: () => void;
  /** "Nest contained elements": draw contained elements inside their container. */
  nest: boolean;
  onToggleNest: () => void;
  /** "Show relationships": off hides every relationship line, with its marks. The cards stay put. */
  lines: boolean;
  onLines: (on: boolean) => void;
  /** Editable Modelling: drawing relationships and adding elements on the canvas. */
  editable?: boolean;
  modelId?: string;
  /** The relationship open in the details panel: its line is drawn selected. */
  selectedRelationshipId?: string | undefined;
  /** A relationship just added: its line is lit for a moment. */
  litRelationshipId?: string | undefined;
  onOpenRelationship?: (id: string) => void;
  /** A click on the empty canvas, or Esc, with a relationship selected. */
  onDeselect?: () => void;
  onRelationshipAdded?: (result: RelationshipChangeResult) => void;
  /** An element created on the canvas (its card goes where the popover was opened). */
  onElementCreated?: (result: ElementChangeResult) => void;
  /** `R` on a card: open Add relationship for it. */
  onAddRelationshipFrom?: (id: string) => void;
  /** Goes up by one on each `N`: the New element popover opens at the view's centre. */
  newElementRequest?: number;
  /**
   * New element's "Add to canvas", or a row dropped on the canvas: bring an existing element onto
   * the canvas (its card goes where it was dropped or asked for). Nothing is created.
   */
  onBringElement?: (id: string) => void;
  /** Goes up by one (with an element on the canvas): select that card and pan to it. */
  reveal?: { id: string; n: number } | undefined;
  /**
   * An open view, by name: no card is focused, the depth keys do nothing, and the canvas says
   * it is the view.
   */
  viewName?: string | undefined;
  /** The related pill on cards (off in a view that can't change). Default: on. */
  related?: boolean;
  /** A notice at the canvas's top (a view's change that wasn't saved), with its actions. */
  notice?: ReactNode;
  /** In place of the full canvas notice (a view has its own words). */
  fullText?: string | undefined;
  /** Over an empty canvas (a view with no elements). */
  emptyText?: ReactNode;
  /** The cards with a remove button (×): they can be taken off the canvas, or out of the view. */
  removable?: ReadonlySet<string>;
  /** The remove button on a card: takes it off the canvas (or out of the open view). */
  onRemoveCard?: (id: string) => void;
  /**
   * An open view's stored layout: a new canvas (but not Tidy up) puts the cards with a position
   * there, and the others at a free spot, in place of a layout by ELK. Read only then.
   */
  storedLayout?: readonly ViewCardLayout[] | undefined;
  /**
   * An open view's stored line routes: read with `storedLayout`, when the canvas opens from it.
   * Tidy up gives every line its automatic route instead.
   */
  storedRoutes?: readonly ViewLineRoute[] | undefined;
  /**
   * The Group by the stored layout was saved with: the layout is read only while the canvas is
   * grouped the same way (a change in Viewing lays the page out afresh).
   */
  storedGroupBy?: string | undefined;
  /**
   * Goes up by one when the person added or took off cards, or chose Tidy up: once the canvas
   * shows it, it reports where its cards are (`onArranged`).
   */
  arrangeRequest?: number;
  /**
   * Where every card is, and the route of every line moved by hand or drawn on the layout's route,
   * after the person moved or resized a card, moved a line, or after `arrangeRequest`. Never for a
   * layout, a placement or a route the canvas made on its own. Given, in a view, the lines' middle
   * stretches can be dragged.
   */
  onArranged?: (layout: CanvasLayout) => void;
}

/** A popover on the canvas: New relationship, or New element (at a point on the canvas). */
type CanvasPop =
  | { kind: 'relationship'; source: string; target: string; top: number; left: number }
  | {
      kind: 'element';
      at: Point;
      from?: string;
      top: number;
      left: number;
      /** Opened with `N`: where focus was then, to go back to on Esc. */
      opener?: HTMLElement;
    };

const relPopWidth = 300;
const relPopHeight = 340;

/** The line while drawing a relationship: dashed accent, arrow at the pointer. */
function ConnectionLine({ fromX, fromY, toX, toY }: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: Position.Right,
    targetX: toX,
    targetY: toY,
    targetPosition: Position.Left,
  });
  return <path className="connection-line" d={path} markerEnd={`url(#${litArrowMarkerId})`} />;
}

/** The innermost card under a point (a nested card is drawn above its container). */
function cardAtPoint(x: number, y: number, within: HTMLElement | null): string | undefined {
  if (typeof document.elementsFromPoint !== 'function') return undefined;
  for (const element of document.elementsFromPoint(x, y)) {
    if (element.closest('.connect-handle')) continue;
    const card = element.closest('.card[data-element-id]');
    if (card && within?.contains(card)) return card.getAttribute('data-element-id') ?? undefined;
  }
  return undefined;
}

function pointOf(event: MouseEvent | TouchEvent): { x: number; y: number } {
  const touch = 'changedTouches' in event ? event.changedTouches[0] : undefined;
  return touch
    ? { x: touch.clientX, y: touch.clientY }
    : { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
}

interface Laid {
  /** The canvas it was made for (`layoutKey`). */
  key: string;
  tidyCount: number;
  /**
   * A new canvas (laid out by ELK, or from a view's stored layout): the view is fitted to it.
   * Otherwise the previous canvas with cards added or taken off.
   */
  fresh: boolean;
  hood: Neighbourhood;
  /** Every relationship on the canvas, including the ones drawn as nesting. */
  links: CanvasLink[];
  /** The links drawn as lines: all but the nesting ones. */
  drawn: CanvasLink[];
  placed: Map<string, PlacedCard>;
  /** Element id → the container it is drawn inside. */
  parents: ReadonlyMap<string, string>;
  /** Elements drawn as containers (with elements inside). */
  containers: ReadonlySet<string>;
  /** Each card's size when ELK laid it out: a line keeps ELK's route only while both stay so. */
  layoutSizes: ReadonlyMap<string, { width: number; height: number }>;
  /** The widths set by hand it was made with. */
  widths: ReadonlyMap<string, number>;
  /** The new canvas it belongs to (one for each new canvas; kept as cards come and go). */
  canvas: number;
  /** The routes given by hand that its lines start with, by relationship id. */
  routes: ReadonlyMap<string, HeldRoute>;
  /** The property its cards are grouped by (its group boxes are in `placed`), or undefined. */
  groupBy: string | undefined;
}

const noRoutes: ReadonlyMap<string, HeldRoute> = new Map();

/** A handle without the layout's route: its line follows its cards. */
function withoutRoute(handle: PlacedHandle): PlacedHandle {
  if (!handle.route) return handle;
  const rest = { ...handle };
  delete rest.route;
  return rest;
}

/** Stacking (React Flow's manual z-index): containers by depth, then edges, then cards. */
const zIndexes = { nestedEdge: 500, card: 1000, lifted: 3000 } as const;

/** How soon after a line is dropped a click on it still counts as the end of the drag (ms). */
const clickAfterDrag = 300;

/** "Show relationships" off: React Flow gets no edges at all, so no line, label or mark is drawn. */
const noEdges: RelationshipFlowEdge[] = [];

type Highlight = { ids: Set<string>; links: Set<string> } | null;
interface RelatedState {
  cardId: string;
  opener: HTMLButtonElement;
  top: number;
  left: number;
}

const popupWidth = 320;

/** The element id of the card a DOM node is in, if any. */
function cardIdOf(target: EventTarget | null): string | undefined {
  return target instanceof HTMLElement
    ? (target.closest('.card')?.getAttribute('data-element-id') ?? undefined)
    : undefined;
}
type Hover = { kind: 'card' | 'link'; id: string } | null;

/** Keyboard move mode: the card, and where it was when the move started (to cancel). */
interface Moving {
  focusId: string;
  id: string;
  /** Its moved position before this move, or undefined when it was where the layout put it. */
  before: Point | undefined;
  /** Its width set by hand before this move, if any (`Alt` + arrows change it). */
  widthBefore: number | undefined;
  /** Its width on the canvas when the move started: Esc puts it back. */
  widthAt: number | undefined;
}

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
  const [fontsReady, setFontsReady] = useState(false);
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
  const pendingFocus = useRef<{ id: string; part: 'main' | 'related' } | null>(null);
  /** Keyboard focus was in the canvas, so it should stay there when cards come and go. */
  const hadFocus = useRef(false);
  // The layout effect reads the moved cards when ELK answers, without re-running on every move.
  const movedRef = useRef(props.moved);
  useEffect(() => {
    movedRef.current = props.moved;
  });
  // The moved cards while the canvas is laid out: Tidy up clears them before its layout answers,
  // so a Tidy up that fails puts them back.
  const movedBeforeTidy = useRef(props.moved);
  useEffect(() => {
    if (laid?.key === props.layoutKey) movedBeforeTidy.current = props.moved;
  });
  /**
   * What the live region says after a keyboard move or a tidy up (until the next layout), or, with
   * `canvas`, until the canvas is a new one (a moved line's save redraws the same canvas).
   */
  const [note, setNote] = useState<{ laid: Laid | null; text: string; canvas?: number } | null>(
    null,
  );
  /** The card being dragged with the mouse: edge labels are hidden until the drop. */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragging = draggingId !== null;
  /** The card being dragged moved: its drop is the person's change to the arrangement. */
  const dragMoved = useRef(false);
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
  /** Whether the last thing the person did was press the pointer (rather than a key). */
  const pointerLast = useRef(false);
  useEffect(() => {
    const pointer = () => {
      pointerLast.current = true;
    };
    const key = () => {
      pointerLast.current = false;
    };
    window.addEventListener('pointerdown', pointer, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);
  /** The panels' box, in screen pixels from the canvas's top left. */
  const viewpointsBox = useCallback((): Box | undefined => {
    const host = section.current?.getBoundingClientRect();
    const box = viewpoints.current?.getBoundingClientRect();
    if (!host || !box) return undefined;
    return { x: box.left - host.left, y: box.top - host.top, width: box.width, height: box.height };
  }, []);
  /**
   * The panels' size at the last fit, while the view is still as that fit left it; null once
   * the person has panned, zoomed or moved anything since (or nothing was fitted yet).
   */
  const fittedPanel = useRef<{ width: number; height: number } | null>(null);
  /** Fits the whole drawing, with every card clear of the panels. */
  const fit = useCallback(
    (duration: number) => {
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
    },
    [flow, store, viewpointsBox],
  );
  // The panels can change size after a fit (choices arrive late, or the cap message comes):
  // fit again so no card ends up under it, unless the person has moved the view since.
  useEffect(() => {
    const panel = viewpoints.current;
    if (!panel || typeof ResizeObserver === 'undefined') return;
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
  }, [fit, viewpointsBox]);
  /** The person did something on the canvas (not in the panels): the last fit no longer holds. */
  const onCanvasInput = (event: { target: EventTarget }) => {
    if (!(event.target instanceof Node && viewpoints.current?.contains(event.target))) {
      fittedPanel.current = null;
    }
  };
  /** Drawing a relationship: from this element. Esc cancels (then the drop is ignored). */
  const drawing = useRef<{ source: string; cancelled: boolean } | null>(null);
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

  useEffect(() => {
    let live = true;
    void whenFontsReady().then(() => {
      if (live) setFontsReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  // React Flow's wrapper says role="application", which would switch screen readers out of
  // browse mode for the whole canvas. Cards are plain buttons, so drop it.
  useEffect(() => {
    wrapper.current?.removeAttribute('role');
  });

  const links = useMemo(() => mergeRelationships(hood.relationships), [hood]);

  const { nest } = props;

  // The latest canvas and page callbacks, read by the layout effect without re-running it.
  const laidRef = useRef(laid);
  const latest = useRef({
    onMove: props.onMove,
    onKept: props.onKept,
    onResize: props.onResize,
    flow,
  });
  useEffect(() => {
    laidRef.current = laid;
    latest.current = { onMove: props.onMove, onKept: props.onKept, onResize: props.onResize, flow };
  });
  /** Where new cards should go (a drop point, or next to a card), until they are placed. */
  const hints = useRef(new Map<string, PlaceHint>());
  // Read only when the canvas is a new one, so a layout saved meanwhile moves nothing.
  const storedRef = useRef({
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
  /**
   * The last Tidy up, and the canvas it was chosen for (`layoutKey` then). Once the canvas is
   * another one (a view, focus, depth or the Nest switch), a Tidy up that hasn't finished is
   * dropped (`key` null): the new canvas opens as it normally would.
   */
  const tidyAsked = useRef<{ count: number; key: string | null }>({
    count: props.tidyCount,
    key: null,
  });

  const { layoutKey, tidyCount, widths, groupBy } = props;
  // A new canvas is measured (after the fonts load) and laid out in ELK's worker. Any other change
  // (cards or lines added or taken off, an element edited) keeps every card where it is.
  useEffect(() => {
    if (tidyAsked.current.count !== tidyCount) {
      tidyAsked.current = { count: tidyCount, key: layoutKey };
    } else if (tidyAsked.current.key !== layoutKey) {
      tidyAsked.current.key = null;
    }
    if (!fontsReady) return;
    let live = true;
    // Nesting: each element inside its container, when that and their Contains are shown.
    const wanted = nest ? nestingParents(graph, hood) : new Map<string, string>();
    const ids = [...hood.hops.keys()].filter((id) => graph.elements.has(id));
    // Group by: each top-level card in its value's group box, one more level above the cards.
    const grouping = groupBy === undefined ? undefined : groupCards(graph, ids, wanted, groupBy);
    const groupIds = grouping?.order ?? [];
    /** The box each card is drawn in: its container, or its group box. */
    const parentOf = new Map(wanted);
    for (const [id, group] of grouping?.groupOf ?? []) parentOf.set(id, group);
    const headerWidthOf = (group: string) =>
      groupHeaderWidth(
        groupValueText(groupBy ?? '', groupValueOf(group)),
        grouping?.members.get(group)?.length ?? 0,
      );
    const sizeOf = (id: string, container: boolean) => {
      if (isGroupId(id)) return groupMinSize(headerWidthOf(id));
      const element = graph.elements.get(id);
      if (!element) return { width: 0, height: 0 };
      const focused = id === hood.focusId;
      return container
        ? containerMinSize({
            name: element.name,
            focused,
            userIcon: nodeTypeDefinitions[element.type].icon === 'user',
          })
        : cardSize({ name: element.name, focused, shape: cardShape(element.type) });
    };
    const heightAt = (id: string, width: number) => {
      const element = graph.elements.get(id);
      if (!element || cardShape(element.type) !== 'card') return sizeOf(id, false).height;
      return cardHeightAt({ name: element.name, focused: id === hood.focusId }, width);
    };
    /** Every card and group box to draw, parents first. */
    const canvasCards = [
      ...groupIds.map((id) => ({ id })),
      ...ids.map((id) => ({ id, parent: parentOf.get(id) })),
    ];
    /** Element containers only: group boxes are drawn as boxes of their own. */
    const elementParents = (placed: ReadonlyMap<string, PlacedCard>) => {
      const parents = new Map<string, string>();
      for (const card of placed.values()) {
        if (card.parent !== undefined && !isGroupId(card.parent)) parents.set(card.id, card.parent);
      }
      return parents;
    };
    const withoutGroups = (set: Iterable<string>) =>
      new Set([...set].filter((id) => !isGroupId(id)));
    // A Contains drawn as nesting: no line.
    const nested =
      (parents: ReadonlyMap<string, string>) =>
      (link: { type: string; source: string; target: string }) =>
        link.type === containsType && parents.get(link.target) === link.source;
    const made = (
      placed: Map<string, PlacedCard>,
      parents: ReadonlyMap<string, string>,
      containers: ReadonlySet<string>,
      fresh: boolean,
      layoutSizes: Laid['layoutSizes'],
      routes: Pick<Laid, 'canvas' | 'routes'>,
    ): Laid => ({
      key: layoutKey,
      tidyCount,
      fresh,
      layoutSizes,
      widths,
      hood,
      links,
      drawn: links.filter((link) => !nested(parents)(link)),
      placed,
      parents,
      containers,
      ...routes,
      groupBy,
    });

    const previous = laidRef.current;
    /**
     * The previous canvas kept, its lines' routes included, with the cards in `moved` where they
     * were put: cards that came go to a free spot, cards that went are taken off. True when a card
     * is somewhere else than before.
     */
    const keep = (previous: Laid, moved: MovedPositions) => {
      // The cards as drawn now, moved ones included, become the canvas's own places.
      const before = arrangeCards(previous.placed, moved, {
        minSizeOf: (id) => sizeOf(id, true),
        holding: holdingRef.current,
      });
      // On a grouped canvas, a card that belongs in another box than it is in (its value changed,
      // or it came into or out of a container) goes, with what it holds, to a free spot in its
      // box, as a new card does, nearest to where it was. No other card moves.
      const staying = new Map(before);
      if (grouping) {
        const at = absoluteBoxes(before);
        const leaving = new Set<string>();
        for (const card of before.values()) {
          const want = parentOf.get(card.id);
          if (card.parent === want || isGroupId(card.id)) continue;
          const inGroup = (id: string | undefined) => id !== undefined && isGroupId(id);
          if (!inGroup(card.parent) && !inGroup(want)) continue;
          leaving.add(card.id);
          const was = at.get(card.id);
          if (was && !hints.current.has(card.id)) {
            hints.current.set(card.id, { at: { x: was.x, y: was.y } });
          }
        }
        for (const card of before.values()) {
          for (
            let up: string | undefined = card.id;
            up !== undefined;
            up = before.get(up)?.parent
          ) {
            if (leaving.has(up)) {
              staying.delete(card.id);
              break;
            }
          }
        }
      }
      const box = section.current?.getBoundingClientRect();
      const kept = keepCards({
        previous: staying,
        previousContainers: previous.containers,
        cards: canvasCards,
        related: hood.relationships,
        sizeOf,
        heightAt,
        widths,
        hints: hints.current,
        centre: box
          ? latest.current.flow.screenToFlowPosition({
              x: box.left + box.width / 2,
              y: box.top + box.height / 2,
            })
          : { x: 0, y: 0 },
      });
      // A container whose card was taken off fits what it still holds, and so do its containers;
      // and a group box whose card went to another box.
      const lostIn = new Set<string>();
      for (const card of before.values()) {
        if (card.parent === undefined) continue;
        const now = kept.placed.get(card.id);
        if (now && (now.parent === card.parent || !isGroupId(card.parent))) continue;
        for (let up: string | undefined = card.parent; up !== undefined && !lostIn.has(up);) {
          lostIn.add(up);
          up = before.get(up)?.parent;
        }
      }
      const fitted =
        lostIn.size === 0
          ? kept.placed
          : fitContainers(kept.placed, lostIn, { minSizeOf: (id) => sizeOf(id, true) });
      const parents = elementParents(fitted);
      const placed = relinkHandles(
        fitted,
        layoutLinkRelationships(previous.hood.relationships),
        layoutLinks(hood.relationships, (relationship) => !nested(parents)(relationship)),
      );
      // A layout's failure message stays: only a new layout, or a new canvas, clears it.
      setLaid(
        made(placed, parents, withoutGroups(kept.containers), false, previous.layoutSizes, {
          canvas: previous.canvas,
          routes: previous.routes,
        }),
      );
      for (const id of placed.keys()) hints.current.delete(id);
      // A moved card taken out of its container keeps its place on the canvas.
      for (const [id, point] of moved) {
        const card = placed.get(id);
        if (card && (card.x !== point.x || card.y !== point.y)) {
          latest.current.onMove(id, { x: card.x, y: card.y });
        }
      }
      return !samePlacement(before, placed);
    };
    if (previous?.key === layoutKey && previous.groupBy === groupBy) {
      if (keep(previous, movedRef.current)) latest.current.onKept?.(layoutKey);
      return;
    }

    /**
     * A new canvas without ELK: the cards with a stored position where they were left (with the
     * lines' stored routes), the others at a free spot. `problem`: why ELK's layout isn't used.
     */
    const placeWithoutElk = (
      stored: ReadonlyMap<string, Point>,
      storedRoutes: readonly ViewLineRoute[],
      problem: string | null,
    ) => {
      const cards = canvasCards;
      // A card at the width it was given, as it was left: the lines' stored routes end on it.
      const leftSize = (id: string, container: boolean) => {
        if (isGroupId(id)) return sizeOf(id, true);
        const element = graph.elements.get(id);
        const set = container ? undefined : widths.get(id);
        if (set === undefined || !element || cardShape(element.type) !== 'card') {
          return sizeOf(id, container);
        }
        const width = setWidth(set);
        return { width, height: heightAt(id, width) };
      };
      const start = storedPlacement({ cards, stored, sizeOf: leftSize });
      const box = section.current?.getBoundingClientRect();
      const kept = keepCards({
        previous: start.placed,
        previousContainers: start.containers,
        cards,
        related: hood.relationships,
        sizeOf,
        heightAt,
        widths,
        hints: new Map(),
        centre: box
          ? latest.current.flow.screenToFlowPosition({
              x: box.left + box.width / 2,
              y: box.top + box.height / 2,
            })
          : { x: 0, y: 0 },
      });
      const parents = elementParents(kept.placed);
      // No routes from ELK: every line follows its cards, as after a move.
      const placed = relinkHandles(
        kept.placed,
        new Map(),
        layoutLinks(hood.relationships, (relationship) => !nested(parents)(relationship)),
      );
      // The lines moved by hand, read against their cards as the layout was left; their ends then
      // follow the cards the containers' fit moved.
      const boxes = absoluteBoxes(arrangeCards(placed, movedRef.current));
      const left = absoluteBoxes(start.asLeft);
      const ends = new Map(
        hood.relationships.map((relationship) => [relationship.id, relationship]),
      );
      const routes = new Map<string, HeldRoute>();
      for (const route of storedRoutes) {
        const relationship = ends.get(route.relationshipId);
        if (!relationship) continue;
        const { source, target } = relationship;
        const held = heldFromStored(
          route.points,
          { source, target },
          left.get(source) ?? boxes.get(source),
          left.get(target) ?? boxes.get(target),
        );
        if (held) routes.set(route.relationshipId, held);
      }
      hints.current.clear();
      setLayoutError(problem);
      const next = made(placed, parents, withoutGroups(kept.containers), true, new Map(), {
        canvas: ++canvasCount.current,
        routes,
      });
      setLaid(next);
      // Not ELK's layout: Tidy up has something to do.
      latest.current.onKept?.(layoutKey);
      return next;
    };

    // A view with a stored layout: its cards where they were left, the others at a free spot.
    // Tidy up lays it out with ELK instead, but only on the canvas it was chosen for.
    const tidied =
      previous !== null && previous.tidyCount !== tidyCount && tidyAsked.current.key === layoutKey;
    // Another Group by: laid out afresh, as Tidy up does (and in a view, saved).
    const regrouped = previous !== null && previous.groupBy !== groupBy;
    /** What the canvas's status says once a regroup is drawn. */
    const regroupNote =
      groupBy === undefined
        ? 'Not grouped.'
        : groupedText(groupBy, groupIds.length, graph.elementProperties);
    // Another canvas: a report asked for on the previous one (Tidy up's save) is never made for it.
    if (!tidied && !regrouped) arrangeWanted.current = false;
    const storedCards = storedRef.current.cards ?? [];
    // A view's stored layout holds for the grouping it was saved with (also on a regroup back to
    // it); any other is laid out afresh.
    const stored =
      tidied || storedRef.current.groupBy !== groupBy
        ? undefined
        : grouping
          ? storedGroupedPositions(
              storedCards,
              (id) => groupNowOf(grouping, wanted, id),
              grouping.members,
            )
          : storedPositions(storedCards);
    if (stored !== undefined && ids.some((id) => stored.has(id))) {
      const next = placeWithoutElk(stored, storedRef.current.routes ?? [], null);
      if (regrouped) setNote({ laid: next, text: regroupNote });
      return;
    }

    hints.current.clear();
    const containers = new Set(wanted.values());
    const groupLayoutCards = groupIds.map((id): LayoutCard => ({
      id,
      ...sizeOf(id, true),
      shape: 'container',
      // Lines into a group box come in beside its value and count.
      nameWidth: headerWidthOf(id),
    }));
    const cards = ids.map((id): LayoutCard => {
      const element = graph.elements.get(id);
      const parent = parentOf.get(id);
      const container = containers.has(id);
      const shape = container ? ('container' as const) : element ? cardShape(element.type) : 'card';
      // A width set by hand is kept by a new layout (Tidy up), with the name wrapped to it.
      const set = container || shape !== 'card' ? undefined : widths.get(id);
      const width = set === undefined ? undefined : setWidth(set);
      return {
        id,
        ...(width === undefined ? sizeOf(id, container) : { width, height: heightAt(id, width) }),
        shape,
        ...(parent === undefined ? {} : { parent }),
        // Lines into a container come in beside its name, however long.
        ...(container && element
          ? {
              nameWidth: containerNameWidth({
                name: element.name,
                focused: id === hood.focusId,
                userIcon: nodeTypeDefinitions[element.type].icon === 'user',
              }),
            }
          : {}),
      };
    });
    const laidOut = layoutLinks(
      hood.relationships,
      (relationship) => !nested(wanted)(relationship),
    );
    // A new try (Tidy up after a failure): "Laying out…" again until it answers.
    setLayoutError(null);
    const elk = getElk();
    // Group boxes first, in the property's order: where the lines leave a choice, they keep it.
    const timed = withinTimeLimit(
      layoutCards(elk, [...groupLayoutCards, ...cards], laidOut),
      layoutTimeLimit,
    );
    timed.promise
      .then((byElk) => {
        if (!live) return;
        setLayoutError(null);
        // ELK's sizes: a line keeps ELK's route only while its cards keep them.
        const sizes = new Map(
          [...byElk.values()].map((card) => [card.id, { width: card.width, height: card.height }]),
        );
        // Every container and group box fits what it holds, as after a move.
        const placed = fitContainers(byElk, [...containers, ...groupIds], {
          minSizeOf: (id) => sizeOf(id, true),
        });
        const next = made(placed, wanted, containers, true, sizes, {
          canvas: ++canvasCount.current,
          routes: noRoutes,
        });
        setLaid(next);
        if (regrouped) {
          setNote({ laid: next, text: regroupNote });
        } else if (tidied) {
          setNote({ laid: next, text: 'Layout tidied up.' });
        }
      })
      .catch((error: unknown) => {
        if (!live) return;
        // Too slow: ELK's worker is stopped, so the next layout doesn't wait behind it.
        if (error instanceof LayoutTimeoutError) elk.terminateWorker();
        console.warn('The automatic layout failed.', error);
        // A failed layout is never saved: Tidy up's save is dropped, unless the person moved a
        // card while it ran.
        if (movedRef.current.size === 0) arrangeWanted.current = false;
        if (previous && tidied) {
          // Tidy up: every card and line stays where it was before (Tidy up cleared the moves).
          keep(previous, new Map([...movedBeforeTidy.current, ...movedRef.current]));
          setLayoutError(layoutFailureMessage(error, { kept: true }));
          latest.current.onKept?.(layoutKey);
          return;
        }
        // A new canvas stays usable: every card at a free spot, with a message.
        placeWithoutElk(new Map(), [], layoutFailureMessage(error));
      });
    return () => {
      live = false;
      timed.cancel();
    };
  }, [fontsReady, hood, links, graph, nest, layoutKey, tidyCount, widths, groupBy]);

  // Model ids can hold any character, but React Flow builds CSS selectors from node ids.
  // So React Flow and the DOM get made-up ids (`n0`, `card-0`), mapped back on events.
  const { domIds, flowIds, elementIds } = useMemo(() => {
    const dom = new Map<string, string>();
    const flow = new Map<string, string>();
    const element = new Map<string, string>();
    [...(laid?.placed.keys() ?? [])].forEach((id, index) => {
      dom.set(id, `card-${index}`);
      flow.set(id, `n${index}`);
      element.set(`n${index}`, id);
    });
    return { domIds: dom, flowIds: flow, elementIds: element };
  }, [laid]);
  const flowId = useCallback((id: string) => flowIds.get(id) ?? '', [flowIds]);

  // Where the cards are drawn: the layout, with the moved cards where the user put them, and the
  // containers they are in fitted to what they hold (while a card is held, only growing).
  const { moved } = props;
  const holding =
    hold && (hold.id === draggingId || hold.id === movingState?.id) ? hold : undefined;
  useEffect(() => {
    holdingRef.current = holding;
  });
  const hoodFocusId = hood.focusId;
  // Each group box's header: its value as shown, its count, and how wide the two are drawn.
  const groupHeads = useMemo(() => {
    const heads = new Map<string, { text: string; count: number; width: number }>();
    if (laid?.groupBy === undefined) return heads;
    const counts = new Map<string, number>();
    for (const card of laid.placed.values()) {
      if (card.parent !== undefined && isGroupId(card.parent)) {
        counts.set(card.parent, (counts.get(card.parent) ?? 0) + 1);
      }
    }
    for (const id of laid.placed.keys()) {
      if (!isGroupId(id)) continue;
      const text = groupValueText(laid.groupBy, groupValueOf(id));
      const count = counts.get(id) ?? 0;
      heads.set(id, { text, count, width: groupHeaderWidth(text, count) });
    }
    return heads;
  }, [laid]);
  const minContainerSize = useCallback(
    (id: string) => {
      const head = groupHeads.get(id);
      if (head) return groupMinSize(head.width);
      const element = graph.elements.get(id);
      return containerMinSize({
        name: element?.name ?? '',
        focused: id === hoodFocusId,
        userIcon: element !== undefined && nodeTypeDefinitions[element.type].icon === 'user',
      });
    },
    [graph, hoodFocusId, groupHeads],
  );
  const shown = useMemo(
    () =>
      laid
        ? arrangeCards(laid.placed, moved, { minSizeOf: minContainerSize, holding })
        : new Map<string, PlacedCard>(),
    [laid, moved, minContainerSize, holding],
  );
  // After a drop, the places the fit gave the cards inside a container become theirs, so the next
  // hold starts from the picture as drawn; and a container that grew over cards beside it pushes
  // them down, for good. Then the drop is reported.
  const { onMove } = props;
  useEffect(() => {
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
      for (const [id, point] of pushedByContainer(shown, drop.id, drop.sizes)) {
        onMove(id, point);
        changed = true;
      }
      wantArranged();
    }
    settling.current = changed;
  }, [laid, shown, moved, holding, onMove, wantArranged]);
  /** Every card's size as drawn now: where a hold starts from. */
  const holdFrom = (id: string): Holding => ({
    id,
    sizes: new Map(
      [...shown].map(([key, card]) => [key, { width: card.width, height: card.height }]),
    ),
  });
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
      if (phase === 'start') {
        const card = shownRef.current.get(id);
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
    },
    [wantArranged],
  );
  // Positions on the canvas (cards inside containers are placed relative to them).
  const absolute = useMemo(() => absoluteBoxes(shown), [shown]);
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
  // The cards as a line's ends see them: a Stakeholder's lines end on its circle, not its box.
  // Group boxes too: a line keeps out of a box it neither starts nor ends in, and off its header text.
  const endBoxes = useMemo(() => {
    const boxes = new Map<string, EndBox>();
    for (const [id, box] of absolute) {
      const element = graph.elements.get(id);
      const circle =
        laid?.containers.has(id) !== true &&
        element !== undefined &&
        cardShape(element.type) === 'circle';
      const parent = shown.get(id)?.parent;
      const head = groupHeads.get(id);
      boxes.set(id, {
        ...box,
        ...(circle ? { circle } : {}),
        ...(parent === undefined ? {} : { parent }),
        ...(head ? { headerWidth: head.width } : {}),
      });
    }
    return boxes;
  }, [absolute, graph, laid, shown, groupHeads]);

  // In Modelling, a line's label can lie over a card's connect handle. With the pointer on the
  // label there, that card (with what is inside it) comes above the labels and shows its handle,
  // so it can be grabbed; it stays so while the pointer stays at the handle.
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

  // Lines moved by hand (in a view): the routes this canvas started with, or as last dragged.
  const [heldState, setHeldState] = useState<{
    canvas: number;
    routes: ReadonlyMap<string, HeldRoute>;
  } | null>(null);
  const held = laid
    ? heldState?.canvas === laid.canvas
      ? heldState.routes
      : laid.routes
    : noRoutes;

  // A line taken out of the view, or given other ends, loses its route for good, as on the server
  // (set while rendering, as React recommends for state that follows a prop).
  if (laid && held.size > 0) {
    const ends = new Map(hood.relationships.map((relationship) => [relationship.id, relationship]));
    const kept = [...held].filter(([id, route]) => {
      const now = ends.get(id);
      return now?.source === route.source && now.target === route.target;
    });
    if (kept.length !== held.size) setHeldState({ canvas: laid.canvas, routes: new Map(kept) });
  }

  // Move mode ends by itself when the focus changes or the card leaves the canvas.
  const moving = movingState?.focusId === focusId && shown.has(movingState.id) ? movingState : null;
  const movingId = moving?.id;

  const highlight: Highlight = useMemo(() => {
    if (!hover || !laid) return null;
    if (hover.kind === 'link') {
      const link = laid.links.find((l) => l.id === hover.id);
      return link ? { ids: new Set([link.source, link.target]), links: new Set([link.id]) } : null;
    }
    const ids = new Set([hover.id]);
    const lit = new Set<string>();
    for (const link of laid.links) {
      if (link.source !== hover.id && link.target !== hover.id) continue;
      ids.add(link.source);
      ids.add(link.target);
      lit.add(link.id);
    }
    return { ids, links: lit };
  }, [hover, laid]);

  // Per card: related elements not on the canvas. Linear in the relationships
  // of the cards shown.
  const missing = useMemo(() => {
    const counts = new Map<string, number>();
    if (!laid) return counts;
    if (!showRelatedPill) return counts;
    for (const id of laid.placed.keys()) {
      if (!isGroupId(id)) counts.set(id, missingRelatedCount(graph, id, laid.placed));
    }
    return counts;
  }, [laid, graph, showRelatedPill]);

  // Card contents, apart from their position: unchanged while a card is dragged, so only the
  // dragged card re-renders.
  const cardData = useMemo(() => {
    if (!laid) return new Map<string, CardNode['data']>();
    const entries = [...laid.placed.values()].flatMap((card) => {
      const element = graph.elements.get(card.id);
      if (!element) return [];
      const focused = card.id === laid.hood.focusId;
      const container = laid.containers.has(card.id);
      const shape = container ? 'container' : cardShape(element.type);
      const parentElement = card.parent === undefined ? undefined : graph.elements.get(card.parent);
      const cut = shape === 'card' ? cardNameCut({ name: element.name, focused }, card) : undefined;
      const group = groupOfCard(laid.placed, card.id);
      const data: CardNode['data'] = {
        element,
        shape,
        ...(group === undefined ? {} : { group: groupHeads.get(group)?.text ?? '' }),
        ...(card.parent !== undefined && isGroupId(card.parent) ? { inGroup: true } : {}),
        ...(parentElement
          ? { containerColour: nodeTypeDefinitions[parentElement.type].colour }
          : {}),
        nameCut: container
          ? isContainerNameCut({
              name: element.name,
              focused,
              userIcon: nodeTypeDefinitions[element.type].icon === 'user',
            })
          : shape === 'circle'
            ? isCircleNameCut(element.name, focused)
            : cut !== undefined,
        ...(cut === undefined ? {} : { nameLines: cut }),
        missing: missing.get(card.id) ?? 0,
        state: elementArchitectureState(element),
        focused,
        selected: card.id === props.selectedId,
        tabbable: card.id === activeId,
        domId: domIds.get(card.id) ?? card.id,
        handles: card.handles,
        relatedOpen: related?.cardId === card.id,
        moving: card.id === movingId,
        ...(editable && card.id === connectHot ? { connectHot: true } : {}),
        onShowRelated: showRelated,
        connectable: editable,
        ...(shape === 'card' ? { onResize: resizeFromGrip } : {}),
        ...(props.onRemoveCard && props.removable?.has(card.id) === true
          ? {
              onRemove: props.onRemoveCard,
              removeIn: inView ? ('view' as const) : ('canvas' as const),
            }
          : {}),
        ...(dropAt?.id === card.id
          ? { drop: dropAt.ok ? ('ok' as const) : ('self' as const) }
          : {}),
      };
      return [[card.id, data] as const];
    });
    return new Map(entries);
  }, [
    laid,
    graph,
    missing,
    activeId,
    domIds,
    related,
    showRelated,
    movingId,
    editable,
    connectHot,
    dropAt,
    props.selectedId,
    props.removable,
    resizeFromGrip,
    props.onRemoveCard,
    inView,
    groupHeads,
  ]);

  // The card being dragged or moved with the keyboard, with everything inside it, goes on top. A
  // group box stays under its cards (CSS lifts it with a shadow).
  const liftedId =
    draggingId !== null && isGroupId(draggingId) ? undefined : (draggingId ?? movingId);
  const baseNodes = useMemo<CanvasNode[]>(() => {
    /** The card whose connect handle is let through, or a card drawn inside it. */
    const hot = (id: string) => {
      if (!editable || connectHot === null) return false;
      for (let up: string | undefined = id; up !== undefined; up = shown.get(up)?.parent) {
        if (up === connectHot) return true;
      }
      return false;
    };
    return [...shown.values()].flatMap((card): CanvasNode[] => {
      const head = groupHeads.get(card.id);
      if (head) {
        return [
          {
            id: flowId(card.id),
            type: 'groupBox' as const,
            position: { x: card.x, y: card.y },
            width: card.width,
            height: card.height,
            measured: { width: card.width, height: card.height },
            // Under the lines and the cards.
            zIndex: -1,
            // Moved by its header only: its body lets presses through, so dragging there pans.
            // Inline, as React Flow sets `pointer-events: all` inline on a draggable node.
            dragHandle: `.${groupHandleClass}`,
            style: { pointerEvents: 'none' },
            draggable: true,
            selectable: false,
            connectable: false,
            domAttributes: { 'aria-roledescription': undefined, 'aria-hidden': true },
            data: {
              text: head.text,
              count: head.count,
              notSet: groupValueOf(card.id) === undefined,
            },
          },
        ];
      }
      const data = cardData.get(card.id);
      if (!data) return [];
      const parent = card.parent === undefined ? undefined : shown.get(card.parent);
      // How deep in containers (a group box isn't one: its cards are the top level).
      let depthInside = 0;
      for (let up = card.parent; up !== undefined; up = shown.get(up)?.parent) {
        if (!isGroupId(up)) depthInside++;
      }
      const { padding } = frameOf(card.parent);
      return [
        {
          id: flowId(card.id),
          type: 'element' as const,
          position: { x: card.x, y: card.y },
          width: card.width,
          height: card.height,
          // The size React Flow would measure (it is fixed). With it, React Flow keeps the
          // measured handles when a node object changes (hover classes), so the lines aren't
          // dropped and drawn again on every hover, which let a click fall through.
          measured: { width: card.width, height: card.height },
          zIndex:
            (data.shape === 'container' ? depthInside : zIndexes.card) +
            (card.id === liftedId || hot(card.id) ? zIndexes.lifted : 0),
          ...(parent
            ? {
                parentId: flowId(parent.id),
                // Left and up, a card stops at its container's content area (the container's
                // corner stays); right and down, the container grows to hold it.
                extent: [
                  [padding.left, padding.top],
                  [Infinity, Infinity],
                ] as [[number, number], [number, number]],
              }
            : {}),
          draggable: true,
          selectable: false,
          connectable: editable,
          // React Flow marks every node "node" for assistive technology; the card says what it is.
          domAttributes: { 'aria-roledescription': undefined },
          data,
        },
      ];
    });
  }, [shown, cardData, flowId, liftedId, editable, connectHot, groupHeads]);

  // What edge labels and state marks must not cover: cards, only the header of a container, and
  // only the value and count of a group box.
  const cardBoxes = useMemo(
    () =>
      [...absolute].map(([id, box]) => {
        const head = groupHeads.get(id);
        if (head) return groupTextArea(box, head.width);
        return laid?.containers.has(id) ? { ...box, height: containerBox.header } : box;
      }),
    [absolute, laid, groupHeads],
  );

  // A selected Contains drawn as nesting has no line: its two cards show it.
  const selected = props.selectedRelationshipId
    ? relationshipById.get(props.selectedRelationshipId)
    : undefined;
  const selectedNest =
    selected && laid?.parents.get(selected.target) === selected.source ? selected : undefined;
  const nodes = useMemo(() => {
    const lit = highlight
      ? baseNodes.map((node) =>
          node.type === 'groupBox'
            ? node
            : {
                ...node,
                className: highlight.ids.has(node.data.element.id) ? 'is-lit' : 'is-dim',
              },
        )
      : baseNodes;
    if (!selectedNest) return lit;
    return lit.map((node) => {
      if (node.type === 'groupBox') return node;
      const id = node.data.element.id;
      if (id === selectedNest.target) return { ...node, className: 'is-lit is-sel-child' };
      return id === selectedNest.source ? { ...node, className: 'is-lit' } : node;
    });
  }, [baseNodes, highlight, selectedNest]);

  /** What a click on a line or its label does (`openLink`, below), for the edges' callbacks. */
  const latestOpenLink = useRef<(linkId: string, clientX: number, clientY: number) => void>(
    () => undefined,
  );

  // Lines moved by hand, with their cards where they are now: the stretches the person moved stay,
  // and the stretches at a moved card's end follow it. A merged line takes its first
  // relationship's route.
  const handRoutes = useMemo(() => {
    const result = new Map<string, Point[]>();
    for (const link of laid?.drawn ?? []) {
      const source = endBoxes.get(link.source);
      const target = endBoxes.get(link.target);
      if (!source || !target) continue;
      for (const id of link.relationshipIds) {
        const route = held.get(id);
        if (route?.source !== link.source || route.target !== link.target) continue;
        const points = followCards(route, source, target);
        if (points) {
          result.set(link.id, points);
          break;
        }
      }
    }
    return result;
  }, [laid, endBoxes, held]);

  // Tidy relations can be used once the canvas is laid out and draws a line.
  const relationsTidyable =
    props.lines && laid !== null && laid.key === props.layoutKey && laid.drawn.length > 0;
  const { onRelationsTidyable } = props;
  useEffect(() => {
    onRelationsTidyable?.(relationsTidyable);
  }, [relationsTidyable, onRelationsTidyable]);
  // After "Tidy relations" (set while rendering, so a save asked for with it sees the result): the
  // cards stay, the layout's routes and the routes given by hand go, and every line follows its
  // cards. Said at once, as there is no layout to wait for.
  const relationsTidyCount = props.relationsTidyCount ?? 0;
  const [relationsSeen, setRelationsSeen] = useState(relationsTidyCount);
  if (relationsSeen !== relationsTidyCount) {
    setRelationsSeen(relationsTidyCount);
    if (laid && relationsTidyable) {
      const placed = new Map<string, PlacedCard>();
      for (const [id, card] of laid.placed) {
        placed.set(id, { ...card, handles: card.handles.map(withoutRoute) });
      }
      const next = { ...laid, placed, routes: noRoutes };
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

  // In a view that saves its layout, a line's bends can be dragged.
  const linesMovable = inView && editable && props.onArranged !== undefined;
  /** A line dropped where the person dragged it: held for every relationship on it, and saved. */
  const latestRouteMoved = useRef<(linkId: string, line: Point[]) => void>(() => undefined);
  /**
   * When a line was last dropped, its drag cancelled, or the canvas panned from it: the click that
   * ends it opens nothing.
   */
  const routeMovedAt = useRef(-Infinity);
  /** A line with a bend dragged to a point; undefined where no such line fits. */
  const latestFitted = useRef<
    (linkId: string, line: readonly Point[], index: number, to: Point) => Point[] | undefined
  >(() => undefined);
  useEffect(() => {
    latestFitted.current = (linkId, line, index, to) => {
      const link = laid?.drawn.find((each) => each.id === linkId);
      const sourceBox = link && endBoxes.get(link.source);
      const targetBox = link && endBoxes.get(link.target);
      if (!sourceBox || !targetBox) return undefined;
      // Snapping is the same distance on the screen at every zoom.
      const snap = bendSnap / (flow.getZoom() || 1);
      return moveBend(line, index, to, sourceBox, targetBox, snap);
    };
    latestRouteMoved.current = (linkId, line) => {
      routeMovedAt.current = performance.now();
      const link = laid?.drawn.find((each) => each.id === linkId);
      const sourceBox = link && endBoxes.get(link.source);
      const targetBox = link && endBoxes.get(link.target);
      if (!laid || !link || !sourceBox || !targetBox) return;
      const points = fitEnds(squared(line), sourceBox, targetBox);
      if (!points) return;
      const next = new Map(held);
      for (const id of link.relationshipIds) {
        next.set(id, { source: link.source, target: link.target, points, sourceBox, targetBox });
      }
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
  /**
   * A bend being dragged, on this line: from 4px of movement on, the line as it would be if
   * dropped now (`points`).
   */
  const [lineDrag, setLineDrag] = useState<{ linkId: string; points?: Point[] } | null>(null);
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
  /**
   * A press on a bend handle: the bend nearest the pointer, among the lines whose handles show, is
   * the one grabbed, where two lines' handles lie on top of each other. True when a bend was
   * grabbed: from 4px on it is dragged, and the drop saves the line. Esc, a cancelled pointer or
   * the window losing focus puts the line back, and nothing is saved.
   */
  const bendPress = useCallback(
    (press: LinePress): boolean => {
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
    },
    [flow],
  );

  /**
   * A press on a line: from 4px on, the drag pans the canvas (React Flow keeps its lines from
   * panning), and the click ending it opens nothing. Less is a click, which opens the line.
   */
  const linePress = useCallback(
    (press: LinePress): boolean => {
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
    },
    [flow],
  );

  // ELK's routes that still hold. Worked out apart from the edges, so a hover keeps the same bends
  // and doesn't place the labels again.
  const routes = useMemo(() => {
    const result = new Map<string, Point[]>();
    // A card whose size changed (a rename, a width set by hand) has lines that follow it, as after a
    // move: ELK's ports on it no longer hold.
    const sameSize = (id: string) => {
      const before = laid?.layoutSizes.get(id);
      const now = shown.get(id);
      return before !== undefined && now?.width === before.width && now.height === before.height;
    };
    for (const link of laid?.drawn ?? []) {
      if (handRoutes.has(link.id)) continue;
      if (!sameSize(link.source) || !sameSize(link.target)) continue;
      const handle = shown
        .get(link.source)
        ?.handles.find((candidate) => candidate.id === portId(link.id, 'source'));
      const bends = currentBends(
        handle?.route,
        absolute.get(link.source),
        absolute.get(link.target),
      );
      if (bends) result.set(link.id, bends);
    }
    return result;
  }, [laid, shown, absolute, handRoutes]);

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
    const cards = layoutOfCanvas(
      shown,
      (id) => {
        const element = graph.elements.get(id);
        return (
          widths.has(id) &&
          !laid.containers.has(id) &&
          element !== undefined &&
          cardShape(element.type) === 'card'
        );
      },
      laid.groupBy !== undefined,
    );
    const ends = new Map(hood.relationships.map((relationship) => [relationship.id, relationship]));
    // Lines on the layout's route (after Tidy up) are saved as drawn, so the view opens with them.
    const laidLines = new Map<string, Point[]>();
    for (const link of laid.drawn) {
      const bends = routes.get(link.id);
      const source = endBoxes.get(link.source);
      const target = endBoxes.get(link.target);
      if (!bends || !source || !target) continue;
      const line = laidLine(
        bends,
        {
          handles: shown.get(link.source)?.handles ?? [],
          box: source,
          port: portId(link.id, 'source'),
        },
        {
          handles: shown.get(link.target)?.handles ?? [],
          box: target,
          port: portId(link.id, 'target'),
        },
      );
      if (line) laidLines.set(link.id, line);
    }
    onArranged?.({
      cards,
      routes: withLaidRoutes(routesToSave(held, ends, endBoxes), laidLines, laid.drawn, endBoxes),
      groupBy: laid.groupBy ?? null,
    });
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
    routes,
  ]);
  // Lines without a route: their ends on the sides where their cards face each other now, so
  // they follow a moved card (live, while it is dragged) and take the shortest way.
  const floating = useMemo(() => {
    if (!laid) return new Map<string, FloatingLine>();
    const boxes = endBoxes;
    // The ends of routed lines keep their places: the others keep clear of them.
    const taken = new Map<string, { side: Side; offset: number }[]>();
    for (const link of laid.drawn) {
      if (!routes.has(link.id)) continue;
      for (const [card, end] of [
        [link.source, 'source'],
        [link.target, 'target'],
      ] as const) {
        const handle = shown.get(card)?.handles.find((h) => h.id === portId(link.id, end));
        if (handle) taken.set(card, [...(taken.get(card) ?? []), handle]);
      }
    }
    // So do the ends of lines moved by hand.
    for (const link of laid.drawn) {
      const points = handRoutes.get(link.id);
      if (!points) continue;
      for (const [card, point] of [
        [link.source, points[0]],
        [link.target, points[points.length - 1]],
      ] as const) {
        const box = absolute.get(card);
        const place = point && box && endPlace(point, box);
        if (place) taken.set(card, [...(taken.get(card) ?? []), place]);
      }
    }
    return floatingEnds(
      laid.drawn.filter((link) => !routes.has(link.id) && !handRoutes.has(link.id)),
      boxes,
      taken,
    );
  }, [laid, absolute, endBoxes, shown, routes, handRoutes]);

  const { selectedRelationshipId: chosen, litRelationshipId: fresh, shownProperties } = props;
  // Bend handles show on the line under the pointer and on the open relationship's line; while a
  // bend is dragged, only on its line. None while a card is dragged, moved or resized, or while a
  // relationship is drawn.
  const hoveredLink = hover?.kind === 'link' ? hover.id : undefined;
  const bendsAllowed =
    linesMovable && !dragging && moving === null && !resizingCard && drawingFrom === null;
  const bendLinkIds = useMemo(() => {
    if (!bendsAllowed || !laid) return [];
    if (lineDrag) return [lineDrag.linkId];
    return laid.drawn
      .filter(
        (link) =>
          link.id === hoveredLink ||
          (chosen !== undefined && link.relationshipIds.includes(chosen)),
      )
      .map((link) => link.id);
  }, [bendsAllowed, laid, lineDrag, hoveredLink, chosen]);
  useEffect(() => {
    bendLines.current = bendLinkIds;
  });
  const edges = useMemo<RelationshipFlowEdge[]>(() => {
    if (!laid) return [];
    const name = (id: string) => graph.elements.get(id)?.name || '(unnamed)';
    return laid.drawn.map((link) => {
      const isSelected = chosen !== undefined && link.relationshipIds.includes(chosen);
      const isFresh = fresh !== undefined && link.relationshipIds.includes(fresh);
      const lit = (highlight?.links.has(link.id) ?? false) || isSelected || isFresh;
      const nested = laid.parents.has(link.source) || laid.parents.has(link.target);
      const text = linkText(link, shownProperties, (member) => displayLabel(member, graph));
      const lists = linkDataParts(link, shownProperties, graph, text);
      const [only] = link.members;
      const resting = text !== '';
      const grayed = isGrayed(link, shownProperties);
      const bends = routes.get(link.id);
      const ends = floating.get(link.id);
      const dragged = lineDrag?.linkId === link.id ? lineDrag.points : undefined;
      const route = dragged ?? handRoutes.get(link.id);
      return {
        id: link.id,
        type: 'relationship' as const,
        // Edges to nested cards go above the container bodies.
        zIndex: nested ? zIndexes.nestedEdge : 0,
        source: flowId(link.source),
        target: flowId(link.target),
        sourceHandle: portId(link.id, 'source'),
        targetHandle: portId(link.id, 'target'),
        focusable: false,
        selectable: false,
        ariaLabel: `${name(link.source)} ${relationshipVerb(link.type, link.twoWay ? 'both' : 'outgoing')} ${name(link.target)}`,
        ...(highlight || grayed || link.state !== 'Current' || isSelected || isFresh
          ? {
              className: [
                highlight || isFresh ? (lit ? 'is-lit' : 'is-dim') : '',
                isSelected ? 'is-selected' : '',
                grayed && !lit ? 'is-grayed' : '',
                link.state === 'Current' ? '' : `is-${link.state.toLowerCase()}`,
              ]
                .filter(Boolean)
                .join(' '),
            }
          : {}),
        data: {
          type: link.type,
          text,
          ...(lists
            ? {
                dataLines: lists.parts,
                title: lists.title,
                ...(only?.source === only?.target ? { self: true } : {}),
              }
            : {}),
          lit,
          state: link.state,
          ...(link.twoWay ? { twoWay: true } : {}),
          ...(bends ? { bends } : {}),
          ...(ends ? { ends } : {}),
          ...(route ? { route } : {}),
          ...(linesMovable
            ? {
                onBendPress: bendPress,
                onLinePress: linePress,
                onLineDrawn: lineDrawn,
                ...(bendLinkIds.includes(link.id) ? { bendHandles: true } : {}),
              }
            : {}),
          ...(highlight && !lit ? { dim: true } : {}),
          ...(grayed && !lit ? { grayed: true } : {}),
          ...(resting ? { resting: true } : {}),
          ...(lit || resting || link.state !== 'Current'
            ? { cards: cardBoxes, hideLabel: dragging }
            : {}),
          // The label and the bend handles are part of the line: hovering keeps it lit, a click
          // opens it.
          onLineClick: (clientX: number, clientY: number) => {
            if (performance.now() - routeMovedAt.current < clickAfterDrag) return;
            latestOpenLink.current(link.id, clientX, clientY);
          },
          onLineHover: (over: boolean) => {
            setHover(over ? { kind: 'link', id: link.id } : null);
          },
        },
      };
    });
  }, [
    laid,
    graph,
    highlight,
    flowId,
    cardBoxes,
    dragging,
    chosen,
    fresh,
    routes,
    floating,
    handRoutes,
    lineDrag,
    linesMovable,
    bendPress,
    linePress,
    bendLinkIds,
    lineDrawn,
    shownProperties,
  ]);

  // After a change: re-read the handles (they may have moved), and fit the view to a new layout
  // (only: when cards come and go, the view stays where it is).
  const fitted = useRef<Laid | null>(null);
  useEffect(() => {
    if (!laid) return;
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
    } else if (hadFocus.current && lost) {
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

  // After "Tidy up": say so at once (set while rendering, as React recommends for state that
  // follows a prop); the new layout says it again when it arrives.
  const [tidySeen, setTidySeen] = useState(props.tidyCount);
  if (tidySeen !== props.tidyCount) {
    setTidySeen(props.tidyCount);
    setNote({ laid, text: 'Layout tidied up.' });
  }

  const focusCard = (id: string) => {
    setActiveId(id);
    document.getElementById(domIds.get(id) ?? '')?.focus();
  };

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
      section.current?.focus();
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
      const busy = dragging || resizingCard || lineDrag !== null || drawingFrom !== null;
      if (!relationsTidyable || busy) return;
      props.onTidyRelations?.();
    } else {
      return;
    }
    event.preventDefault();
  };

  const nameOf = (id: string) => graph.elements.get(id)?.name || '(unnamed)';

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
      dropped.current = hold ?? { id: moving.id, sizes: new Map() };
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
      const box = section.current?.getBoundingClientRect();
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
    hadFocus.current = true;
    const id = cardIdOf(event.target);
    if (id) {
      setActiveId(id);
      setHover({ kind: 'card', id });
      // A card that gets keyboard focus is never hidden under the panels. A click on a card
      // half under it doesn't pan: the card is under the pointer, and may be about to be dragged.
      if (!pointerLast.current) {
        const viewport = clearOfViewpoints(id);
        if (viewport) {
          fittedPanel.current = null;
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
    if (next instanceof Node && !section.current?.contains(next)) hadFocus.current = false;
    if (cardIdOf(event.target) && !(event.relatedTarget && cardIdOf(event.relatedTarget))) {
      setHover(null);
    }
  };

  const capNotice = hood.capped
    ? `Showing ${formatNumber(hood.hops.size)} of ${formatNumber(hood.reachable)} elements.${depth > 1 ? ' Choose a smaller depth to see fewer.' : ''}`
    : null;
  const loneNotice =
    inView || hood.relationships.length > 0 ? null : 'No relationships. This element stands alone.';
  // Only a new canvas waits for ELK; other changes are drawn at once.
  const pending = laid?.key !== props.layoutKey && layoutError === null;
  const fullNotice =
    props.fullText ??
    (props.refused > 0
      ? `The canvas is full (${formatNumber(defaultNeighbourhoodCap)} elements): ${counted(props.refused, 'element')} not added. Choose a smaller depth to make room.`
      : null);
  const relatedCard = related ? graph.elements.get(related.cardId) : undefined;
  const relatedGroups = useMemo(
    () => (related && laid ? missingRelatedElements(graph, related.cardId, laid.placed) : []),
    [graph, related, laid],
  );
  const announcement =
    note && (note.laid === laid || (note.canvas !== undefined && note.canvas === laid?.canvas))
      ? note.text
      : laid
        ? `${inView ? `View ${props.viewName || '(unnamed)'}` : `Focused ${graph.elements.get(laid.hood.focusId)?.name || '(unnamed)'}`}. ${counted(laid.placed.size - groupHeads.size, 'element')} shown.`
        : '';

  /** A popover's place in the canvas: 12px right of the point, kept 8px inside. */
  const placeAt = (x: number, y: number, width = relPopWidth, height = relPopHeight) => {
    const box = section.current?.getBoundingClientRect();
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
  useEffect(() => {
    latestOpenLink.current = openLink;
  });

  // placeAt guesses a popover's size; the real one can be taller (a hint, name matches) and grow
  // while typing. So once drawn, and whenever it resizes, each popover is moved back 8px inside
  // the canvas, or the canvas's overflow cuts off its buttons.
  useLayoutEffect(() => {
    const host = section.current;
    if (!host || (pop === null && edgeMenu === null)) return;
    const popovers = () => host.querySelectorAll<HTMLElement>('.canvas-pop, .rel-pop, .edge-menu');
    const keepInside = () => {
      const box = host.getBoundingClientRect();
      for (const element of popovers()) {
        const rect = element.getBoundingClientRect();
        const overBottom = rect.bottom - (box.bottom - 8);
        if (overBottom > 0) element.style.top = `${Math.max(8, rect.top - box.top - overBottom)}px`;
        const overRight = rect.right - (box.right - 8);
        if (overRight > 0)
          element.style.left = `${Math.max(8, rect.left - box.left - overRight)}px`;
      }
    };
    keepInside();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(keepInside);
    for (const element of popovers()) observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [pop, edgeMenu]);

  const focusCardOf = (id: string) => {
    requestAnimationFrame(() => {
      document.getElementById(domIds.get(id) ?? '')?.focus();
    });
  };

  // While drawing: the card under the pointer (and the chip over the source), and Esc.
  useEffect(() => {
    if (drawingFrom === null) return;
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
  }, [drawingFrom, store, laid]);

  const onConnectStart = (_event: MouseEvent | TouchEvent, params: { nodeId: string | null }) => {
    const source = elementIds.get(params.nodeId ?? '');
    if (!editable || source === undefined) return;
    // The lines come back, so the new one shows once added.
    if (!props.lines) props.onLines(true);
    drawing.current = { source, cancelled: false };
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
    const current = drawing.current;
    drawing.current = null;
    setDrawingFrom(null);
    setDropAt(null);
    setChip(null);
    if (!current || current.cancelled) return;
    const point = pointOf(event);
    const target = cardAtPoint(point.x, point.y, section.current);
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
    const box = section.current?.getBoundingClientRect();
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

  // `N`: at the centre of the view. Esc goes back to where focus was when `N` was pressed.
  const newRequest = useRef(props.newElementRequest);
  useEffect(() => {
    if (newRequest.current === props.newElementRequest) return;
    newRequest.current = props.newElementRequest;
    const box = section.current?.getBoundingClientRect();
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
    // Only on a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.newElementRequest]);

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
    fittedPanel.current = null;
    void flow.setViewport(clearOfViewpoints(id, centred) ?? centred, {
      duration: reducedMotion() ? 0 : 200,
    });
    if (focus) focusCardOf(id);
  };
  const revealN = useRef(props.reveal?.n);
  useEffect(() => {
    if (!props.reveal || revealN.current === props.reveal.n) return;
    revealN.current = props.reveal.n;
    revealCard(props.reveal.id, true);
    // Only on a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.reveal]);

  const closePop = (focusSource: boolean) => {
    const current = pop;
    setPop(null);
    if (!focusSource || !current) return;
    if (current.kind === 'relationship') focusCardOf(current.source);
    else if (current.from !== undefined) focusCardOf(current.from);
    else if (current.opener?.isConnected === true) current.opener.focus();
    else section.current?.focus();
  };

  const onNodesChange = (changes: NodeChange<CanvasNode>[]) => {
    const moves = draggedPositions(changes, (id) => elementIds.get(id));
    if (moves.length > 0) dragMoved.current = true;
    for (const [id, position] of moves) props.onMove(id, position);
  };

  return (
    <section
      ref={section}
      id="canvas"
      className={`canvas${dragging ? ' is-dragging' : ''}${lineDrag ? ' is-bending' : ''}${dropTarget ? ' is-drop-target' : ''}${drawingFrom !== null ? ' is-drawing' : ''}${editable ? ' is-editable' : ''}`}
      tabIndex={-1}
      onPointerDownCapture={onCanvasInput}
      onWheelCapture={onCanvasInput}
      onKeyDownCapture={onCanvasInput}
      onDoubleClick={(event) => {
        const target = event.target as HTMLElement;
        if (!editable || !target.closest('.react-flow__pane') || target.closest('.card')) return;
        newElementAt(event.clientX, event.clientY);
      }}
      aria-label={
        inView
          ? `Diagram: view ${props.viewName || '(unnamed)'}, ${counted(hood.hops.size, 'element')}`
          : `Diagram: ${focusName || '(unnamed)'} and its neighbours, depth ${depth}`
      }
      onKeyDown={onKeyDown}
      onDragOver={(event) => {
        if (!props.onBringElement || !event.dataTransfer.types.includes(elementDragType)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropTarget(true);
      }}
      onDragLeave={(event) => {
        if (!(
          event.relatedTarget instanceof Node && section.current?.contains(event.relatedTarget)
        ))
          setDropTarget(false);
      }}
      onDrop={(event) => {
        setDropTarget(false);
        const id = event.dataTransfer.getData(elementDragType);
        if (!props.onBringElement || !graph.elements.has(id)) return;
        event.preventDefault();
        // On a card or on empty canvas alike: the element lands at the nearest free spot.
        const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        if (!laid?.placed.has(id)) hints.current.set(id, { at: { x: at.x - 60, y: at.y - 22 } });
        props.onBringElement(id);
      }}
      onFocusCapture={onFocusCapture}
      onPointerMove={onPointerMove}
      onBlurCapture={onBlurCapture}
    >
      <EdgeMarkers />
      <ReactFlow<CanvasNode, RelationshipFlowEdge>
        ref={wrapper}
        nodes={nodes}
        edges={props.lines ? edges : noEdges}
        nodeTypes={flowNodeTypes}
        edgeTypes={flowEdgeTypes}
        onMoveStart={(event) => {
          // A pan or zoom by the user (not by code) leaves the popup behind its card: close it.
          if (event) setRelated(null);
        }}
        onNodesChange={onNodesChange}
        onNodeDragStart={(_event, node) => {
          const id = elementIds.get(node.id);
          if (id === undefined) return;
          setRelated(null);
          setHold(holdFrom(id));
          setDraggingId(id);
          dragMoved.current = false;
        }}
        onNodeDragStop={() => {
          setDraggingId(null);
          setHold(null);
          if (dragMoved.current && hold) dropped.current = hold;
          else if (dragMoved.current) wantArranged();
          dragMoved.current = false;
        }}
        onNodeClick={(event, node) => {
          // A group box's header does nothing on a click.
          if (node.type === 'groupBox') return;
          // A single click (or tap) selects; the second click of a double click (or a double tap)
          // focuses. Counting clicks here, rather than on dblclick, works for touch too.
          const id = node.data.element.id;
          if (event.detail >= 2) {
            if (id !== focusId) props.onFocusElement(id);
          } else {
            props.onSelectElement?.(id);
          }
        }}
        onNodeMouseEnter={(_event, node) => {
          if (node.type !== 'groupBox') setHover({ kind: 'card', id: node.data.element.id });
        }}
        onNodeMouseLeave={() => {
          setHover(null);
        }}
        onEdgeMouseEnter={(_event, edge) => {
          setHover({ kind: 'link', id: edge.id });
        }}
        onEdgeMouseLeave={() => {
          setHover(null);
        }}
        onEdgeClick={(event, edge) => {
          // A bend handle keeps a drag's click from the line; this is in case a browser sends it
          // to the line instead.
          if (performance.now() - routeMovedAt.current < clickAfterDrag) return;
          openLink(
            nearestLineAt(event.clientX, event.clientY, edge.id),
            event.clientX,
            event.clientY,
          );
        }}
        onPaneClick={() => {
          // Nor does the end of a bend drag whose handle went (bends that lined up) clear it.
          if (performance.now() - routeMovedAt.current < clickAfterDrag) return;
          setEdgeMenu(null);
          props.onDeselect?.();
        }}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        connectionLineComponent={ConnectionLine}
        nodesDraggable
        // Less movement than this is a click (which selects the element), not a drag.
        nodeDragThreshold={dragThreshold}
        nodeClickDistance={dragThreshold}
        // The same for a press on a line, its label or empty canvas: the pan it starts lets the
        // click through, so the line opens (or the selection clears).
        paneClickDistance={dragThreshold}
        // React Flow's auto-pan near the canvas edge can keep running after the drop (its loop
        // re-arms after an await), panning and moving the card on its own. Pan by hand instead.
        autoPanOnNodeDrag={false}
        nodesConnectable={editable}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        disableKeyboardA11y
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomOnDoubleClick={false}
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        zIndexMode="manual"
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

      {related && relatedCard && (
        <RelatedPopup
          name={relatedCard.name}
          groups={relatedGroups}
          top={related.top}
          left={related.left}
          opener={related.opener}
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
      {editable && pop?.kind === 'relationship' && props.modelId !== undefined && (
        <NewRelationshipPopover
          key={`${pop.source}->${pop.target}`}
          modelId={props.modelId}
          graph={graph}
          source={pop.source}
          target={pop.target}
          style={{ top: pop.top, left: pop.left }}
          nest={nest}
          onAdded={(result) => {
            const { source } = pop;
            setPop(null);
            props.onRelationshipAdded?.(result);
            focusCardOf(source);
          }}
          onCancel={() => {
            closePop(true);
          }}
          onShow={(id) => {
            setPop(null);
            props.onOpenRelationship?.(id);
          }}
        />
      )}
      {editable && pop?.kind === 'element' && props.modelId !== undefined && (
        <NewElementForm
          modelId={props.modelId}
          graph={graph}
          defaultType={graph.elements.get(pop.from ?? focusId)?.type}
          className="canvas-pop"
          style={{ top: pop.top, left: pop.left }}
          hint={
            pop.from === undefined
              ? undefined
              : `Then choose the relationship from ${nameOf(pop.from)}.`
          }
          onClose={(focusOpener) => {
            closePop(focusOpener);
          }}
          isOnCanvas={(id) => laid?.placed.has(id) === true}
          onExisting={(element) => {
            const { at, from, top, left } = pop;
            if (laid?.placed.has(element.id)) {
              revealCard(element.id, from === undefined);
            } else {
              hints.current.set(element.id, { at: { x: at.x - 60, y: at.y - 22 } });
              props.onBringElement?.(element.id);
              if (from === undefined) focusCardOf(element.id);
            }
            // After a dropped line, the element is the relationship's other end (same rules).
            if (from === undefined) setPop(null);
            else setPop({ kind: 'relationship', source: from, target: element.id, top, left });
          }}
          onCreated={(result) => {
            const { at, from, top, left } = pop;
            hints.current.set(result.element.id, { at: { x: at.x - 60, y: at.y - 22 } });
            props.onElementCreated?.(result);
            if (from === undefined) {
              setPop(null);
              focusCardOf(result.element.id);
            } else {
              setPop({ kind: 'relationship', source: from, target: result.element.id, top, left });
            }
          }}
        />
      )}
      {edgeMenu && (
        <div
          className="related-pop edge-menu"
          role="menu"
          aria-label={`${edgeMenu.ids.length} relationships`}
          style={{ top: edgeMenu.top, left: edgeMenu.left }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setEdgeMenu(null);
            }
          }}
        >
          <p className="rp-title">{edgeMenu.ids.length} relationships</p>
          {edgeMenu.ids.map((id) => {
            const relationship = relationshipById.get(id);
            if (!relationship) return null;
            const label = displayLabel(relationship, graph);
            return (
              <button
                key={id}
                type="button"
                role="menuitem"
                className="rp-item"
                onClick={() => {
                  setEdgeMenu(null);
                  props.onOpenRelationship?.(id);
                }}
              >
                <EdgeSample type={relationship.type} twoWay={relationship.twoWay === true} />
                <span>
                  {relationshipSentence(graph, relationship)}
                  {label !== undefined && <span className="rp-label"> &ldquo;{label}&rdquo;</span>}
                </span>
                {relationship.architectureState !== 'Current' && (
                  <span className="tag">{relationship.architectureState}</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Show Viewpoints and Group by at the top left, always open, in one column; the notices
          beside it, or under it when there's no room beside it. */}
      <div className="canvas-top">
        <div ref={viewpoints} className="canvas-panels">
          <LineProperties
            fields={props.lineFields}
            shown={props.shownProperties}
            onChange={props.onShownProperties}
          />
          {props.groupChoices && props.onGroupBy && (
            <GroupByPanel
              choices={props.groupChoices}
              chosen={props.groupBy}
              onChange={props.onGroupBy}
            />
          )}
        </div>
        <div className="canvas-notices">
          {(pending || layoutError !== null) && (
            <div className="canvas-overlay" role="status">
              {layoutError === null ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                  Laying out…
                </>
              ) : (
                layoutError
              )}
            </div>
          )}
          {props.notice ? (
            <div className="canvas-notice view-notice" role="alert">
              {props.notice}
            </div>
          ) : moving ? (
            <p className="canvas-notice move-hint">
              Moving &ldquo;<span className="move-name">{nameOf(moving.id)}</span>&rdquo;. Arrow
              keys move it, Shift for bigger steps
              {isResizable(moving.id) ? <>, Alt + &larr; &rarr; change its width</> : null}. Enter
              drops, Esc cancels.
            </p>
          ) : (
            (fullNotice ?? capNotice) && (
              <p className="canvas-notice" role="status">
                {fullNotice ?? capNotice}
              </p>
            )
          )}
          {!props.notice && !moving && !fullNotice && !capNotice && loneNotice && (
            <p className="canvas-notice muted">{loneNotice}</p>
          )}
        </div>
      </div>
      <ZoomControls
        onFit={() => {
          fit(reducedMotion() ? 0 : 200);
        }}
      />
    </section>
  );
}

function ZoomControls({ onFit }: { onFit: () => void }) {
  const flow = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const duration = () => (reducedMotion() ? 0 : 200);
  return (
    <div className="zoom" role="group" aria-label="Zoom">
      <button
        className="icon-btn"
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => void flow.zoomOut({ duration: duration() })}
      >
        <Icon name="minus" />
      </button>
      <output aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
      <button
        className="icon-btn"
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => void flow.zoomIn({ duration: duration() })}
      >
        <Icon name="plus" />
      </button>
      <button
        className="icon-btn"
        type="button"
        aria-label="Fit view"
        title="Fit view"
        onClick={onFit}
      >
        <Icon name="fit" />
      </button>
    </div>
  );
}

/**
 * The line nearest the pointer among those whose click area is under it. Lines fan out of a card
 * and cross, and a 20px click area then overlaps its neighbour's: without this, the line drawn on
 * top would take a click aimed at the one beside it. `fallback` is the line clicked.
 */
export function nearestLineAt(x: number, y: number, fallback: string): string {
  let under: Element[];
  try {
    under = document.elementsFromPoint(x, y);
  } catch {
    // Not there (test DOMs): the line clicked.
    return fallback;
  }
  let nearest = fallback;
  let nearestDistance = Infinity;
  for (const element of under) {
    if (!element.classList.contains('react-flow__edge-interaction')) continue;
    const path = element as SVGPathElement;
    const id = path.closest('.react-flow__edge')?.getAttribute('data-id');
    const matrix = path.getScreenCTM();
    if (!id || !matrix || typeof path.getTotalLength !== 'function') continue;
    const length = path.getTotalLength();
    // A point every 2px or so along the line (in canvas units), at most 400.
    const steps = Math.min(400, Math.max(16, Math.ceil(length / 2)));
    for (let step = 0; step <= steps; step++) {
      const point = path.getPointAtLength((length * step) / steps);
      const distance = Math.hypot(
        matrix.a * point.x + matrix.c * point.y + matrix.e - x,
        matrix.b * point.x + matrix.d * point.y + matrix.f - y,
      );
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = id;
      }
    }
  }
  return nearest;
}

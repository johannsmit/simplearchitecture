import {
  containsType,
  displayLabel,
  elementArchitectureState,
  defaultNeighbourhoodCap,
  missingRelatedCount,
  missingRelatedElements,
  nodeTypeDefinitions,
  nodeTypes,
  relationshipVerb,
  type ElementChangeResult,
  type ModelGraph,
  type ModelRelationship,
  type Neighbourhood,
  type RelationshipChangeResult,
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
  maxSetCardWidth,
  minCardWidth,
  isCircleNameCut,
  isContainerNameCut,
  whenFontsReady,
} from './cardSize';
import { ElementCard, relatedButtonId, type CardNode } from './ElementCard';
import { currentBends, floatingEnds, type EndBox, type FloatingLine } from './edgeLine';
import { getElk } from './elkEngine';
import {
  absoluteBoxes,
  containerBox,
  layoutCards,
  portId,
  type LayoutCard,
  type PlacedCard,
  type Side,
} from './elkLayout';
import {
  arrangeCards,
  clampToContainer,
  dragThreshold,
  draggedPositions,
  isMoveKey,
  movedBy,
  moveStep,
  panToKeepInView,
  type MovedPositions,
  type Point,
} from './positions';
import { LineProperties } from './LineProperties';
import {
  endPlace,
  followCards,
  heldFromStored,
  moveStretch,
  nearestMiddleStretch,
  routesToSave,
  squared,
  stretchAt,
  type HeldRoute,
} from './lineRoutes';
import { keepCards, relinkHandles, samePlacement, type PlaceHint } from './placeCards';
import { RelatedPopup } from './RelatedPopup';
import { layoutOfCanvas, storedPlacement, storedPositions, type CanvasLayout } from './viewLayout';
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
  linkText,
  layoutLinkRelationships,
  layoutLinks,
  mergeRelationships,
  nearestInDirection,
  type CanvasLink,
  type Direction,
} from './view';

const flowNodeTypes: NodeTypes = { element: ElementCard };
const flowEdgeTypes: EdgeTypes = { relationship: RelationshipEdge };

// The top is fixed: the selector's place doesn't grow with the canvas. The sides are what
// a padding of 0.15 gives.
const fitOptions = {
  padding: { top: '56px', right: '6.5%', bottom: '6.5%', left: '6.5%' },
  minZoom: 0.2,
  maxZoom: 1.25,
} as const;

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
   * Goes up by one when the person added or took off cards, or chose Tidy up: once the canvas
   * shows it, it reports where its cards are (`onArranged`).
   */
  arrangeRequest?: number;
  /**
   * Where every card is, and the route of every line moved by hand, after the person moved or
   * resized a card, moved a line, or after `arrangeRequest`. Never for a layout, a placement or a
   * route the canvas made on its own. Given, in a view, the lines' middle stretches can be dragged.
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
}

const noRoutes: ReadonlyMap<string, HeldRoute> = new Map();

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
  const flow = useReactFlow<CardNode, RelationshipFlowEdge>();
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
  /** What the live region says after a keyboard move or a tidy up (until the next layout). */
  const [note, setNote] = useState<{ laid: Laid | null; text: string } | null>(null);
  /** The card being dragged with the mouse: edge labels are hidden until the drop. */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragging = draggingId !== null;
  /** The card being dragged moved: its drop is the person's change to the arrangement. */
  const dragMoved = useRef(false);
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
  /** Drawing a relationship: from this element. Esc cancels (then the drop is ignored). */
  const drawing = useRef<{ source: string; cancelled: boolean } | null>(null);
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
  const storedRef = useRef({ cards: props.storedLayout, routes: props.storedRoutes });
  useEffect(() => {
    storedRef.current = { cards: props.storedLayout, routes: props.storedRoutes };
  });
  /** How many new canvases there have been: each one's routes given by hand start afresh. */
  const canvasCount = useRef(0);

  const { layoutKey, tidyCount, widths } = props;
  // A new canvas is measured (after the fonts load) and laid out in ELK's worker. Any other change
  // (cards or lines added or taken off, an element edited) keeps every card where it is.
  useEffect(() => {
    if (!fontsReady) return;
    let live = true;
    // Nesting: each element inside its container, when that and their Contains are shown.
    const wanted = nest ? nestingParents(graph, hood) : new Map<string, string>();
    const sizeOf = (id: string, container: boolean) => {
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
    const ids = [...hood.hops.keys()].filter((id) => graph.elements.has(id));
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
    });

    const previous = laidRef.current;
    if (previous?.key === layoutKey) {
      // The cards as drawn now, moved ones included, become the canvas's own places.
      const before = arrangeCards(previous.placed, movedRef.current);
      const box = section.current?.getBoundingClientRect();
      const kept = keepCards({
        previous: before,
        previousContainers: previous.containers,
        cards: ids.map((id) => ({ id, parent: wanted.get(id) })),
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
      const parents = new Map<string, string>();
      for (const card of kept.placed.values()) {
        if (card.parent !== undefined) parents.set(card.id, card.parent);
      }
      const placed = relinkHandles(
        kept.placed,
        layoutLinkRelationships(previous.hood.relationships),
        layoutLinks(hood.relationships, (relationship) => !nested(parents)(relationship)),
      );
      setLayoutError(null);
      setLaid(
        made(placed, parents, kept.containers, false, previous.layoutSizes, {
          canvas: previous.canvas,
          routes: previous.routes,
        }),
      );
      for (const id of placed.keys()) hints.current.delete(id);
      // A moved card taken out of its container keeps its place on the canvas.
      for (const [id, point] of movedRef.current) {
        const card = placed.get(id);
        if (card && (card.x !== point.x || card.y !== point.y)) {
          latest.current.onMove(id, { x: card.x, y: card.y });
        }
      }
      if (!samePlacement(before, placed)) latest.current.onKept?.(layoutKey);
      return;
    }

    // A view with a stored layout: its cards where they were left, the others at a free spot.
    // Tidy up lays it out with ELK instead.
    const tidied = previous !== null && previous.tidyCount !== tidyCount;
    const stored = tidied ? undefined : storedPositions(storedRef.current.cards ?? []);
    if (stored !== undefined && ids.some((id) => stored.has(id))) {
      const cards = ids.map((id) => ({ id, parent: wanted.get(id) }));
      const start = storedPlacement({ cards, stored, sizeOf });
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
      const parents = new Map<string, string>();
      for (const card of kept.placed.values()) {
        if (card.parent !== undefined) parents.set(card.id, card.parent);
      }
      // No routes from ELK: every line follows its cards, as after a move.
      const placed = relinkHandles(
        kept.placed,
        new Map(),
        layoutLinks(hood.relationships, (relationship) => !nested(parents)(relationship)),
      );
      // The lines moved by hand, where their two cards are as the canvas first shows them.
      const boxes = absoluteBoxes(arrangeCards(placed, movedRef.current));
      const ends = new Map(
        hood.relationships.map((relationship) => [relationship.id, relationship]),
      );
      const routes = new Map<string, HeldRoute>();
      for (const route of storedRef.current.routes ?? []) {
        const relationship = ends.get(route.relationshipId);
        if (!relationship) continue;
        const { source, target } = relationship;
        const held = heldFromStored(
          route.points,
          { source, target },
          boxes.get(source),
          boxes.get(target),
        );
        if (held) routes.set(route.relationshipId, held);
      }
      hints.current.clear();
      setLayoutError(null);
      setLaid(
        made(placed, parents, kept.containers, true, new Map(), {
          canvas: ++canvasCount.current,
          routes,
        }),
      );
      // Not ELK's layout: Tidy up has something to do.
      latest.current.onKept?.(layoutKey);
      return;
    }

    hints.current.clear();
    const containers = new Set(wanted.values());
    const cards = ids.map((id): LayoutCard => {
      const element = graph.elements.get(id);
      const parent = wanted.get(id);
      const container = containers.has(id);
      const shape = container ? ('container' as const) : element ? cardShape(element.type) : 'card';
      // A width set by hand is kept by a new layout (Tidy up), with the name wrapped to it.
      const set = container || shape !== 'card' ? undefined : widths.get(id);
      const width = set === undefined ? undefined : setWidth(set);
      return {
        id,
        ...(width === undefined ? sizeOf(id, container) : { width, height: heightAt(id, width) }),
        partition: element ? nodeTypes.indexOf(element.type) : 0,
        shape,
        ...(parent === undefined ? {} : { parent }),
      };
    });
    const laidOut = layoutLinks(
      hood.relationships,
      (relationship) => !nested(wanted)(relationship),
    );
    layoutCards(getElk(), cards, laidOut)
      .then((placed) => {
        if (!live) return;
        setLayoutError(null);
        const sizes = new Map(
          [...placed.values()].map((card) => [card.id, { width: card.width, height: card.height }]),
        );
        const next = made(placed, wanted, containers, true, sizes, {
          canvas: ++canvasCount.current,
          routes: noRoutes,
        });
        setLaid(next);
        if (previous && previous.tidyCount !== tidyCount) {
          setNote({ laid: next, text: 'Layout tidied up.' });
        }
      })
      .catch((error: unknown) => {
        if (live) setLayoutError(error instanceof Error ? error.message : 'Unknown error');
      });
    return () => {
      live = false;
    };
  }, [fontsReady, hood, links, graph, nest, layoutKey, tidyCount, widths]);

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

  // Where the cards are drawn: the layout, with the moved cards where the user put them.
  const { moved } = props;
  const shown = useMemo(
    () => (laid ? arrangeCards(laid.placed, moved) : new Map<string, PlacedCard>()),
    [laid, moved],
  );
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
  const resizeFromGrip = useCallback(
    (id: string, phase: 'start' | 'move' | 'end', dx: number) => {
      if (phase === 'start') {
        const card = shownRef.current.get(id);
        resizing.current = card ? { id, width: card.width } : null;
        setRelated(null);
        return;
      }
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
      counts.set(id, missingRelatedCount(graph, id, laid.placed));
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
      const data: CardNode['data'] = {
        element,
        shape,
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
    dropAt,
    props.selectedId,
    props.removable,
    resizeFromGrip,
    props.onRemoveCard,
    inView,
  ]);

  // The card being dragged or moved with the keyboard, with everything inside it, goes on top.
  const liftedId = draggingId ?? movingId;
  const baseNodes = useMemo<CardNode[]>(
    () =>
      [...shown.values()].flatMap((card) => {
        const data = cardData.get(card.id);
        if (!data) return [];
        const parent = card.parent === undefined ? undefined : shown.get(card.parent);
        let depthInside = 0;
        for (let up = card.parent; up !== undefined; up = shown.get(up)?.parent) depthInside++;
        const { padding } = containerBox;
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
              (card.id === liftedId ? zIndexes.lifted : 0),
            ...(parent
              ? {
                  parentId: flowId(parent.id),
                  // A card stays within its container's content area.
                  extent: [
                    [padding.left, padding.top],
                    [parent.width - padding.right, parent.height - padding.bottom],
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
      }),
    [shown, cardData, flowId, liftedId, editable],
  );

  // What edge labels and state marks must not cover: cards, and only the header of a container.
  const cardBoxes = useMemo(
    () =>
      [...absolute].map(([id, box]) =>
        laid?.containers.has(id) ? { ...box, height: containerBox.header } : box,
      ),
    [absolute, laid],
  );

  // A selected Contains drawn as nesting has no line: its two cards show it.
  const selected = props.selectedRelationshipId
    ? relationshipById.get(props.selectedRelationshipId)
    : undefined;
  const selectedNest =
    selected && laid?.parents.get(selected.target) === selected.source ? selected : undefined;
  const nodes = useMemo(() => {
    const lit = highlight
      ? baseNodes.map((node) => ({
          ...node,
          className: highlight.ids.has(node.data.element.id) ? 'is-lit' : 'is-dim',
        }))
      : baseNodes;
    if (!selectedNest) return lit;
    return lit.map((node) => {
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
      const source = absolute.get(link.source);
      const target = absolute.get(link.target);
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
  }, [laid, absolute, held]);

  // In a view that saves its layout, a line's middle stretches can be dragged.
  const linesMovable = inView && editable && props.onArranged !== undefined;
  /** A line dropped where the person dragged it: held for every relationship on it, and saved. */
  const latestRouteMoved = useRef<(linkId: string, line: Point[]) => void>(() => undefined);
  /** When a line was last dropped: the click that ends the drag opens nothing. */
  const routeMovedAt = useRef(-Infinity);
  useEffect(() => {
    latestRouteMoved.current = (linkId, line) => {
      routeMovedAt.current = performance.now();
      const link = laid?.drawn.find((each) => each.id === linkId);
      const sourceBox = link && absolute.get(link.source);
      const targetBox = link && absolute.get(link.target);
      if (!laid || !link || !sourceBox || !targetBox) return;
      const points = squared(line);
      const next = new Map(held);
      for (const id of link.relationshipIds) {
        next.set(id, { source: link.source, target: link.target, points, sourceBox, targetBox });
      }
      setHeldState({ canvas: laid.canvas, routes: next });
      setEdgeMenu(null);
      wantArranged();
    };
  });
  // Every line as drawn now (reported by the lines), to find the line nearest a press.
  const drawnLines = useRef(new Map<string, readonly Point[]>());
  const lineDrawn = useCallback((linkId: string, line: readonly Point[] | undefined) => {
    if (line) drawnLines.current.set(linkId, line);
    else drawnLines.current.delete(linkId);
  }, []);
  /** A stretch being dragged: the line as it would be if dropped now. */
  const [lineDrag, setLineDrag] = useState<{ linkId: string; points: Point[] } | null>(null);
  const stretchDrag = useRef<{
    pointer: number;
    linkId: string;
    index: number;
    line: readonly Point[];
    from: Point;
    screen: { x: number; y: number };
    moved: boolean;
    stop: () => void;
  } | null>(null);
  useEffect(
    () => () => {
      stretchDrag.current?.stop();
    },
    [],
  );
  /**
   * A press on a line's grip or label. On a grip, the line nearest the pointer is the one moved,
   * as a click there opens it, even where another line's grip lies on top; on a label, that line's
   * nearest middle stretch. True when the press grabbed a stretch: from 4px on it is dragged, and
   * the drop saves the line.
   */
  const linePress = useCallback(
    (linkId: string, press: LinePress, on: 'grip' | 'label'): boolean => {
      stretchDrag.current?.stop();
      const from = flow.screenToFlowPosition({ x: press.clientX, y: press.clientY });
      let grabbed: { id: string; index: number } | undefined;
      if (on === 'grip') {
        grabbed = stretchAt(drawnLines.current, from);
      } else {
        const own = drawnLines.current.get(linkId);
        const index = own && nearestMiddleStretch(own, from);
        grabbed = index === undefined ? undefined : { id: linkId, index };
      }
      const line = grabbed && drawnLines.current.get(grabbed.id);
      if (!grabbed || !line) return false;
      const to = (event: PointerEvent) => {
        const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        return moveStretch(line, drag.index, { x: at.x - from.x, y: at.y - from.y });
      };
      const onMove = (event: PointerEvent) => {
        if (event.pointerId !== drag.pointer) return;
        const distance = Math.hypot(event.clientX - drag.screen.x, event.clientY - drag.screen.y);
        if (!drag.moved && distance <= dragThreshold) return;
        drag.moved = true;
        setLineDrag({ linkId: drag.linkId, points: to(event) });
      };
      const onUp = (event: PointerEvent) => {
        if (event.pointerId !== drag.pointer) return;
        drag.stop();
        // A drag: the line is held where it was dropped, and saved.
        if (drag.moved) latestRouteMoved.current(drag.linkId, to(event));
      };
      const stop = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', stop);
        if (stretchDrag.current === drag) stretchDrag.current = null;
        setLineDrag(null);
      };
      const drag = {
        pointer: press.pointerId,
        linkId: grabbed.id,
        index: grabbed.index,
        line,
        from,
        screen: { x: press.clientX, y: press.clientY },
        moved: false,
        stop,
      };
      stretchDrag.current = drag;
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

  // Where every card is, and the route of every line moved by hand, once the canvas shows the
  // person's change: the layout made for this canvas, its cards and its widths.
  const { onArranged, arrangeRequest } = props;
  useEffect(() => {
    if (arrangeSeen.current !== arrangeRequest) {
      arrangeSeen.current = arrangeRequest;
      arrangeWanted.current = true;
    }
    if (!arrangeWanted.current || !laid) return;
    if (laid.key !== layoutKey || laid.hood !== hood || laid.widths !== widths) return;
    arrangeWanted.current = false;
    const cards = layoutOfCanvas(shown, (id) => {
      const element = graph.elements.get(id);
      return (
        widths.has(id) &&
        !laid.containers.has(id) &&
        element !== undefined &&
        cardShape(element.type) === 'card'
      );
    });
    const ends = new Map(hood.relationships.map((relationship) => [relationship.id, relationship]));
    onArranged?.({ cards, routes: routesToSave(held, ends, absolute) });
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
    absolute,
  ]);
  // Lines without a route: their ends on the sides where their cards face each other now, so
  // they follow a moved card (live, while it is dragged) and take the shortest way.
  const floating = useMemo(() => {
    if (!laid) return new Map<string, FloatingLine>();
    const boxes = new Map<string, EndBox>();
    for (const [id, box] of absolute) {
      const element = graph.elements.get(id);
      const circle =
        !laid.containers.has(id) && element !== undefined && cardShape(element.type) === 'circle';
      const parent = shown.get(id)?.parent;
      boxes.set(id, {
        ...box,
        ...(circle ? { circle } : {}),
        ...(parent === undefined ? {} : { parent }),
      });
    }
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
  }, [laid, absolute, shown, routes, handRoutes, graph]);

  const { selectedRelationshipId: chosen, litRelationshipId: fresh, shownProperties } = props;
  const edges = useMemo<RelationshipFlowEdge[]>(() => {
    if (!laid) return [];
    const name = (id: string) => graph.elements.get(id)?.name || '(unnamed)';
    return laid.drawn.map((link) => {
      const isSelected = chosen !== undefined && link.relationshipIds.includes(chosen);
      const isFresh = fresh !== undefined && link.relationshipIds.includes(fresh);
      const lit = (highlight?.links.has(link.id) ?? false) || isSelected || isFresh;
      const nested = laid.parents.has(link.source) || laid.parents.has(link.target);
      const text = linkText(link, shownProperties, (member) => displayLabel(member, graph));
      const resting = text !== '';
      const grayed = isGrayed(link, shownProperties);
      const bends = routes.get(link.id);
      const ends = floating.get(link.id);
      const route = lineDrag?.linkId === link.id ? lineDrag.points : handRoutes.get(link.id);
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
          lit,
          state: link.state,
          ...(link.twoWay ? { twoWay: true } : {}),
          ...(bends ? { bends } : {}),
          ...(ends ? { ends } : {}),
          ...(route ? { route } : {}),
          ...(linesMovable ? { onLinePress: linePress, onLineDrawn: lineDrawn } : {}),
          ...(highlight && !lit ? { dim: true } : {}),
          ...(grayed && !lit ? { grayed: true } : {}),
          ...(resting ? { resting: true } : {}),
          ...(lit || resting || link.state !== 'Current'
            ? { cards: cardBoxes, hideLabel: dragging }
            : {}),
          // The label is part of the line: hovering keeps it lit, a click opens it.
          onLabelClick: (clientX: number, clientY: number) => {
            if (performance.now() - routeMovedAt.current < clickAfterDrag) return;
            latestOpenLink.current(link.id, clientX, clientY);
          },
          onLabelHover: (over: boolean) => {
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
    linePress,
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
          void flow.fitView({ ...fitOptions, duration: reducedMotion() ? 0 : 200 });
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
        : laid.placed.keys().next().value;
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
  }, [laid, flow, updateNodeInternals, graph, domIds, flowId, missing]);

  useEffect(() => {
    if (!laid) return;
    const frame = requestAnimationFrame(() => {
      void flow.fitView({ ...fitOptions, duration: 0 });
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
      const next = nearestInDirection(centre([cardId, from]), [...absolute].map(centre), direction);
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
      void flow.fitView({ ...fitOptions, duration: reducedMotion() ? 0 : 200 });
    } else {
      return;
    }
    event.preventDefault();
  };

  const nameOf = (id: string) => graph.elements.get(id)?.name || '(unnamed)';

  /** Keyboard move mode (the keyboard way to drag, WCAG 2.5.7): M on a card starts it. */
  const startMove = (id: string) => {
    setRelated(null);
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
      wantArranged();
    }
    if (how === 'cancel') {
      props.onMove(moving.id, moving.before);
      if (props.widths.get(moving.id) !== moving.widthBefore) {
        props.onResize(moving.id, moving.widthBefore ?? moving.widthAt);
      }
    }
    setMoving(null);
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
      const next = parent ? clampToContainer(step, card, parent) : step;
      props.onMove(card.id, next);
      // Keep the card in view: pan just enough.
      const box = section.current?.getBoundingClientRect();
      const offset = parent ? absolute.get(parent.id) : undefined;
      const at = { ...card, x: next.x + (offset?.x ?? 0), y: next.y + (offset?.y ?? 0) };
      const viewport = box ? panToKeepInView(at, flow.getViewport(), box) : undefined;
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
    note && note.laid === laid
      ? note.text
      : laid
        ? `${inView ? `View ${props.viewName || '(unnamed)'}` : `Focused ${graph.elements.get(laid.hood.focusId)?.name || '(unnamed)'}`}. ${counted(laid.placed.size, 'element')} shown.`
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
  const [drawingFrom, setDrawingFrom] = useState<string | null>(null);
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
    void flow.setCenter(at.x + at.width / 2, at.y + at.height / 2, {
      zoom: flow.getZoom(),
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

  const onNodesChange = (changes: NodeChange<CardNode>[]) => {
    const moves = draggedPositions(changes, (id) => elementIds.get(id));
    if (moves.length > 0) dragMoved.current = true;
    for (const [id, position] of moves) props.onMove(id, position);
  };

  return (
    <section
      ref={section}
      id="canvas"
      className={`canvas${dragging ? ' is-dragging' : ''}${dropTarget ? ' is-drop-target' : ''}${drawingFrom !== null ? ' is-drawing' : ''}${editable ? ' is-editable' : ''}`}
      tabIndex={-1}
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
      onBlurCapture={onBlurCapture}
    >
      <EdgeMarkers />
      <ReactFlow<CardNode, RelationshipFlowEdge>
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
          setRelated(null);
          setDraggingId(node.data.element.id);
          dragMoved.current = false;
        }}
        onNodeDragStop={() => {
          setDraggingId(null);
          if (dragMoved.current) wantArranged();
          dragMoved.current = false;
        }}
        onNodeClick={(event, node) => {
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
          setHover({ kind: 'card', id: node.data.element.id });
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
          // The line's own grip keeps a drag's click from the line; this is in case a browser
          // sends it to the line instead.
          if (performance.now() - routeMovedAt.current < clickAfterDrag) return;
          openLink(
            nearestLineAt(event.clientX, event.clientY, edge.id),
            event.clientX,
            event.clientY,
          );
        }}
        onPaneClick={() => {
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

      {(pending || layoutError !== null) && (
        <div className="canvas-overlay" role="status">
          {layoutError === null ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Laying out…
            </>
          ) : (
            <>The diagram couldn&apos;t be laid out: {layoutError}</>
          )}
        </div>
      )}
      {props.notice ? (
        <div className="canvas-notice view-notice" role="alert">
          {props.notice}
        </div>
      ) : moving ? (
        <p className="canvas-notice move-hint">
          Moving &ldquo;<span className="move-name">{nameOf(moving.id)}</span>&rdquo;. Arrow keys
          move it, Shift for bigger steps
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

      <div className="canvas-views">
        <LineProperties
          fields={props.lineFields}
          shown={props.shownProperties}
          onChange={props.onShownProperties}
        />
      </div>
      <ZoomControls />
    </section>
  );
}

function ZoomControls() {
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
        onClick={() => void flow.fitView({ ...fitOptions, duration: duration() })}
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

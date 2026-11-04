import {
  containerOf,
  containsType,
  elementArchitectureState,
  defaultNeighbourhoodCap,
  informationFlowKey,
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
} from 'react';
import { Icon } from '../../../icons';
import { cardShape, EdgeSample, TypeMark } from '../../../metamodel-ui';
import { counted, formatNumber } from '../../../words';
import { NewElementForm } from '../../../modelling/NewElement';
import { NewRelationshipPopover, relationshipSentence } from '../../../modelling/relationships';
import { readLegendOpen, writeLegendOpen } from '../prefs';
import {
  cardSize,
  containerMinSize,
  isCircleNameCut,
  isContainerNameCut,
  whenFontsReady,
} from './cardSize';
import { ElementCard, relatedButtonId, type CardNode } from './ElementCard';
import { currentBends } from './edgeLine';
import { getElk } from './elkEngine';
import {
  absoluteBoxes,
  containerBox,
  layoutCards,
  portId,
  type LayoutCard,
  type PlacedCard,
} from './elkLayout';
import {
  alignLayout,
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
import { RelatedPopup } from './RelatedPopup';
import {
  EdgeMarkers,
  litArrowMarkerId,
  RelationshipEdge,
  statePath,
  type RelationshipFlowEdge,
} from './RelationshipEdge';
import {
  elementDragType,
  isGrayed,
  linkText,
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
  /** Cards the user moved (visual only). Cleared by the page on a focus or depth change. */
  moved: MovedPositions;
  /**
   * A card was dragged or moved with the keyboard to this position; undefined puts it back in the
   * layout (a cancelled keyboard move of a card that hadn't moved before).
   */
  onMove: (id: string, position: Point | undefined) => void;
  /** Goes up by one on each "Tidy up": the view is fitted again and the change announced. */
  tidyCount: number;
  /** "Nest contained elements": draw contained elements inside their container. */
  nest: boolean;
  onToggleNest: () => void;
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
  /** An element created on the canvas, to be placed at `position` (visual only, like a drag). */
  onElementCreated?: (result: ElementChangeResult, position: Point) => void;
  /** `R` on a card: open Add relationship for it. */
  onAddRelationshipFrom?: (id: string) => void;
  /** Goes up by one on each "+ Element": the New element popover opens at the view's centre. */
  newElementRequest?: number;
  /**
   * New element's "Add to canvas": bring an existing element onto the canvas, at
   * `position` when there is one (visual only). Nothing is created.
   */
  onBringElement?: (id: string, position: Point | undefined) => void;
  /** Goes up by one (with an element on the canvas): select that card and pan to it. */
  reveal?: { id: string; n: number } | undefined;
}

/** A popover on the canvas: New relationship, or New element (at a point on the canvas). */
type CanvasPop =
  | { kind: 'relationship'; source: string; target: string; top: number; left: number }
  | { kind: 'element'; at: Point; from?: string; top: number; left: number };

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
  hood: Neighbourhood;
  /** The relationship types shown when this layout was asked for. */
  /** Every relationship on the canvas, including the ones drawn as nesting. */
  links: CanvasLink[];
  /** The links drawn as lines: all but the nesting ones. */
  drawn: CanvasLink[];
  placed: Map<string, PlacedCard>;
  /** Element id → the container it is drawn inside. */
  parents: ReadonlyMap<string, string>;
  /** Elements drawn as containers (with elements inside). */
  containers: ReadonlySet<string>;
}

/** Stacking (React Flow's manual z-index): containers by depth, then edges, then cards. */
const zIndexes = { nestedEdge: 500, card: 1000, lifted: 3000 } as const;

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
}

/**
 * The focused element and its neighbours, laid out by ELK, drawn with React Flow. Read-only: cards
 * can't be connected, and moving them (mouse drag, or M then arrows) changes only the picture. One
 * Tab stop (the focused element's card); arrow keys move between cards.
 */
export function ExplorerCanvas(props: ExplorerCanvasProps) {
  const { graph, hood, focusId, depth } = props;
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
  const activeId = active.focusId === focusId ? active.id : focusId;
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
  const [movingState, setMoving] = useState<Moving | null>(null);
  const editable = props.editable === true && props.modelId !== undefined;
  const store = useStoreApi();
  /** Drawing a relationship: from this element. Esc cancels (then the drop is ignored). */
  const drawing = useRef<{ source: string; cancelled: boolean } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; ok: boolean } | null>(null);
  const [chip, setChip] = useState<{ x: number; y: number } | null>(null);
  const [pop, setPop] = useState<CanvasPop | null>(null);
  /**
   * A card was placed on the canvas by hand: layouts until then keep the view (no re-fit), so the
   * card stays where it was put. A time, as one change can give more than one layout.
   */
  const keepViewUntil = useRef(0);
  /** A row from the element list is dragged over the canvas. */
  const [dropTarget, setDropTarget] = useState(false);
  const [edgeMenu, setEdgeMenu] = useState<{ ids: string[]; top: number; left: number } | null>(
    null,
  );
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

  // Measure the cards (after the fonts load) and lay them out in ELK's worker.
  useEffect(() => {
    if (!fontsReady) return;
    let live = true;
    // Nesting: each element inside its container, when that is shown.
    const parents = new Map<string, string>();
    if (nest) {
      for (const id of hood.hops.keys()) {
        const container = containerOf(graph, id);
        if (container !== undefined && hood.hops.has(container)) parents.set(id, container);
      }
    }
    const containers = new Set(parents.values());
    const drawn = links.filter(
      (link) => !(link.type === containsType && parents.get(link.target) === link.source),
    );
    const cards = [...hood.hops.keys()].flatMap((id): LayoutCard[] => {
      const element = graph.elements.get(id);
      if (!element) return [];
      const focused = id === hood.focusId;
      const parent = parents.get(id);
      if (containers.has(id)) {
        const userIcon = nodeTypeDefinitions[element.type].icon === 'user';
        return [
          {
            id,
            ...containerMinSize({ name: element.name, focused, userIcon }),
            partition: nodeTypes.indexOf(element.type),
            shape: 'container' as const,
            ...(parent === undefined ? {} : { parent }),
          },
        ];
      }
      const shape = cardShape(element.type);
      return [
        {
          id,
          ...cardSize({ name: element.name, focused, shape }),
          partition: nodeTypes.indexOf(element.type),
          shape,
          ...(parent === undefined ? {} : { parent }),
        },
      ];
    });
    const laidOut = layoutLinks(
      hood.relationships,
      (relationship) =>
        !(
          relationship.type === containsType &&
          parents.get(relationship.target) === relationship.source
        ),
    );
    layoutCards(getElk(), cards, laidOut)
      .then((placed) => {
        if (!live) return;
        setLayoutError(null);
        // With moved cards on the canvas (elements were added, or a relationship type shown or
        // hidden), the new layout keeps the focused card where it was, so the cards around the
        // moved ones stay put. A focus or depth change has no moved cards: a fresh layout.
        setLaid((previous) => ({
          hood,
          links,
          drawn,
          parents,
          containers,
          placed:
            movedRef.current.size > 0 && previous?.hood.focusId === hood.focusId
              ? alignLayout(previous.placed, placed, hood.focusId)
              : placed,
        }));
      })
      .catch((error: unknown) => {
        if (live) setLayoutError(error instanceof Error ? error.message : 'Unknown error');
      });
    return () => {
      live = false;
    };
  }, [fontsReady, hood, links, graph, nest]);

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
  // Positions on the canvas (cards inside containers are placed relative to them).
  const absolute = useMemo(() => absoluteBoxes(shown), [shown]);
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
    for (const id of laid.placed.keys()) {
      counts.set(id, missingRelatedCount(graph, id, laid.placed));
    }
    return counts;
  }, [laid, graph]);

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
          : shape === 'circle' && isCircleNameCut(element.name, focused),
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

  // ELK's routes that still hold. Worked out apart from the edges, so a hover keeps the same bends
  // and doesn't place the labels again.
  const routes = useMemo(() => {
    const result = new Map<string, Point[]>();
    for (const link of laid?.drawn ?? []) {
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
  }, [laid, shown, absolute]);

  const { selectedRelationshipId: chosen, litRelationshipId: fresh, shownProperties } = props;
  const edges = useMemo<RelationshipFlowEdge[]>(() => {
    if (!laid) return [];
    const name = (id: string) => graph.elements.get(id)?.name || '(unnamed)';
    return laid.drawn.map((link) => {
      const isSelected = chosen !== undefined && link.relationshipIds.includes(chosen);
      const isFresh = fresh !== undefined && link.relationshipIds.includes(fresh);
      const lit = (highlight?.links.has(link.id) ?? false) || isSelected || isFresh;
      const nested = laid.parents.has(link.source) || laid.parents.has(link.target);
      const text = linkText(link, shownProperties);
      const resting = text !== '';
      const grayed = isGrayed(link, shownProperties);
      const bends = routes.get(link.id);
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
        ariaLabel: `${name(link.source)} ${relationshipVerb(link.type, link.twoWay ? 'both' : 'outgoing', link.informationFlow)} ${name(link.target)}`,
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
          ...(highlight && !lit ? { dim: true } : {}),
          ...(grayed && !lit ? { grayed: true } : {}),
          ...(resting ? { resting: true } : {}),
          ...(lit || resting || link.state !== 'Current'
            ? { cards: cardBoxes, hideLabel: dragging }
            : {}),
          // The label is part of the line: hovering keeps it lit, a click opens it.
          onLabelClick: (clientX: number, clientY: number) => {
            latestOpenLink.current(link.id, clientX, clientY);
          },
          onLabelHover: (over: boolean) => {
            setHover(over ? { kind: 'link', id: link.id } : null);
          },
        },
      };
    });
  }, [laid, graph, highlight, flowId, cardBoxes, dragging, chosen, fresh, routes, shownProperties]);

  // After a new layout: re-read the handles (they moved), fit the view, and announce the change.
  useEffect(() => {
    if (!laid) return;
    updateNodeInternals([...laid.placed.keys()].map(flowId));
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (Date.now() < keepViewUntil.current) return;
        void flow.fitView({ ...fitOptions, duration: reducedMotion() ? 0 : 200 });
      });
    });
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
      focusPart(laid.hood.focusId, 'main');
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

  // After "Tidy up" (the page cleared the moved cards): say so (set while rendering, as React
  // recommends for state that follows a prop), and fit the view to the layout.
  const [tidyCount, setTidyCount] = useState(props.tidyCount);
  if (tidyCount !== props.tidyCount) {
    setTidyCount(props.tidyCount);
    setNote({ laid, text: 'Layout tidied up.' });
  }
  const tidied = useRef(props.tidyCount);
  useEffect(() => {
    if (tidied.current === props.tidyCount) return;
    tidied.current = props.tidyCount;
    const frame = requestAnimationFrame(() => {
      void flow.fitView({ ...fitOptions, duration: reducedMotion() ? 0 : 200 });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
    // Only on a tidy up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tidyCount]);

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
    if (opener !== undefined) pendingFocus.current = { id: opener, part: 'related' };
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
    setMoving({ focusId, id, before: moved.get(id) });
    setNote({
      laid,
      text: `Moving ${nameOf(id)}. Use the arrow keys, then Enter to drop or Escape to cancel.`,
    });
  };

  const endMove = (how: 'drop' | 'cancel') => {
    if (!moving) return;
    if (how === 'cancel') props.onMove(moving.id, moving.before);
    setMoving(null);
    setNote({ laid, text: how === 'drop' ? `${nameOf(moving.id)} moved.` : 'Move cancelled.' });
  };

  /** In move mode: arrows move the card, Enter or M drop it, Esc cancels. Other canvas keys wait. */
  const onMoveModeKey = (event: KeyboardEvent<HTMLElement>, direction: Direction | undefined) => {
    if (!moving) return;
    const card = shown.get(moving.id);
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

  const typesOnCanvas = useMemo(() => {
    const present = new Set(
      [...(laid?.placed.keys() ?? [])].map((id) => graph.elements.get(id)?.type),
    );
    return nodeTypes.filter((type) => present.has(type));
  }, [laid, graph]);

  const capNotice = hood.capped
    ? `Showing ${formatNumber(hood.hops.size)} of ${formatNumber(hood.reachable)} elements.${depth > 1 ? ' Choose a smaller depth to see fewer.' : ''}`
    : null;
  const loneNotice =
    hood.relationships.length > 0 ? null : 'No relationships. This element stands alone.';
  const pending = laid?.hood !== hood && layoutError === null;
  const fullNotice =
    props.refused > 0
      ? `The canvas is full (${formatNumber(defaultNeighbourhoodCap)} elements): ${counted(props.refused, 'element')} not added. Choose a smaller depth to make room.`
      : null;
  const relatedCard = related ? graph.elements.get(related.cardId) : undefined;
  const relatedGroups = useMemo(
    () => (related && laid ? missingRelatedElements(graph, related.cardId, laid.placed) : []),
    [graph, related, laid],
  );
  const announcement =
    note && note.laid === laid
      ? note.text
      : laid
        ? `Focused ${graph.elements.get(laid.hood.focusId)?.name || '(unnamed)'}. ${counted(laid.placed.size, 'element')} shown.`
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

  // "+ Element" in the toolbar: at the centre of the view.
  const newRequest = useRef(props.newElementRequest);
  useEffect(() => {
    if (newRequest.current === props.newElementRequest) return;
    newRequest.current = props.newElementRequest;
    const box = section.current?.getBoundingClientRect();
    if (!box || !editable) return;
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    setRelated(null);
    setPop({
      kind: 'element',
      at: flow.screenToFlowPosition({ x, y }),
      top: Math.max(8, box.height / 2 - 160),
      left: Math.max(8, box.width / 2 - 160),
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
    else if (props.newElementRequest !== undefined) {
      document.getElementById('canvas-new-element')?.focus();
    }
  };

  const onNodesChange = (changes: NodeChange<CardNode>[]) => {
    const moves = draggedPositions(changes, (id) => elementIds.get(id));
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
      aria-label={`Diagram: ${focusName || '(unnamed)'} and its neighbours, depth ${depth}`}
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
        // On a card or on empty canvas alike: the element lands near the drop point.
        const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        if (!laid?.placed.has(id)) keepViewUntil.current = Date.now() + 2000;
        props.onBringElement(id, { x: at.x - 60, y: at.y - 22 });
      }}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <EdgeMarkers />
      <ReactFlow<CardNode, RelationshipFlowEdge>
        ref={wrapper}
        nodes={nodes}
        edges={edges}
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
        }}
        onNodeDragStop={() => {
          setDraggingId(null);
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
      {moving ? (
        <p className="canvas-notice move-hint">
          Moving &ldquo;<span className="move-name">{nameOf(moving.id)}</span>&rdquo;. Arrow keys
          move it, Shift for bigger steps. Enter drops, Esc cancels.
        </p>
      ) : (
        (fullNotice ?? capNotice) && (
          <p className="canvas-notice" role="status">
            {fullNotice ?? capNotice}
          </p>
        )
      )}
      {!moving && !fullNotice && !capNotice && loneNotice && (
        <p className="canvas-notice muted">{loneNotice}</p>
      )}
      <p className="vh" aria-live="polite">
        {announcement}
      </p>

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
          startsAsFlow={props.shownProperties.includes(informationFlowKey)}
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
              keepViewUntil.current = Date.now() + 2000;
              props.onBringElement?.(element.id, { x: at.x - 60, y: at.y - 22 });
              if (from === undefined) focusCardOf(element.id);
            }
            // After a dropped line, the element is the relationship's other end (same rules).
            if (from === undefined) setPop(null);
            else setPop({ kind: 'relationship', source: from, target: element.id, top, left });
          }}
          onCreated={(result) => {
            const { at, from, top, left } = pop;
            keepViewUntil.current = Date.now() + 2000;
            props.onElementCreated?.(result, { x: at.x - 60, y: at.y - 22 });
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
                <span>{relationshipSentence(graph, relationship)}</span>
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
      <Legend types={typesOnCanvas} nest={props.nest} onToggleNest={props.onToggleNest} />
      <ZoomControls />
    </section>
  );
}

function Legend(props: {
  types: readonly (typeof nodeTypes)[number][];
  nest: boolean;
  onToggleNest: () => void;
}) {
  const [open, setOpen] = useState(readLegendOpen);
  return (
    <details
      className="legend"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        writeLegendOpen(next);
      }}
    >
      <summary>
        <Icon name="chev-right" size="sm" />
        Legend
      </summary>
      <div className="legend-body">
        {/* h2: the legend comes right after the page's h1 (axe heading-order). */}
        <h2>Elements</h2>
        <ul>
          {props.types.map((type) => (
            <li key={type}>
              <TypeMark type={type} />
              {type}
            </li>
          ))}
        </ul>
        <h2>Relationship state</h2>
        <ul>
          {(['Target', 'Deprecate'] as const).map((state) => (
            <li key={state}>
              <StateSample state={state} />
              {state}
            </li>
          ))}
        </ul>
        <label className="nest" title="Draw contained elements inside their container">
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={props.nest}
            onChange={props.onToggleNest}
          />
          <span className="lname">Nest contained elements</span>
        </label>
      </div>
    </details>
  );
}

/** A 28px line sample with a 12px state mark, as in the legend. */
function StateSample({ state }: { state: 'Target' | 'Deprecate' }) {
  return (
    <svg className="edge-sample" width="28" height="12" aria-hidden="true" focusable="false">
      <path className="lsample" d="M1 6h22" />
      <path className="mk" d="M21 2l6 4-6 4z" />
      <g className={`smark ${state.toLowerCase()} legend-mark`} transform="translate(11 6)">
        <circle r={6} />
        <path d={statePath(state, 3)} />
      </g>
    </svg>
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

import {
  elementArchitectureState,
  nodeTypeDefinitions,
  type ModelGraph,
} from '@simplearchitecture/shared';
import { cardShape } from '../../../metamodel-ui';
import { cardNameCut, isCircleNameCut, isContainerNameCut } from './cardSize';
import {
  zIndexes,
  type CanvasNode,
  type Highlight,
  type Hover,
  type Laid,
  type RelatedState,
} from './canvasModel';
import type { CardNode } from './ElementCard';
import type { EndBox } from './edgeLine';
import { containerBox, type PlacedCard } from './elkLayout';
import { groupHandleClass } from './GroupBox';
import { groupHeaderWidth, groupValueText } from './groups';
import { frameOf, groupTextArea, groupValueOf, isGroupId } from './layoutGeometry';
import type { Box } from './positions';
import { groupOfCard } from './viewLayout';

/** A group box's header: its value as shown, its count, and how wide the two are drawn. */
export interface GroupHead {
  text: string;
  count: number;
  width: number;
}

/** Each group box's header, by its id. */
export function groupHeadsOf(laid: Laid | null): Map<string, GroupHead> {
  const heads = new Map<string, GroupHead>();
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
}

/**
 * The cards as a line's ends see them: a Stakeholder's lines end on its circle, not its box. Group
 * boxes too: a line keeps out of a box it neither starts nor ends in, and off its header text.
 */
export function endBoxesOf(
  absolute: ReadonlyMap<string, Box>,
  graph: ModelGraph,
  laid: Laid | null,
  shown: ReadonlyMap<string, PlacedCard>,
  groupHeads: ReadonlyMap<string, GroupHead>,
): Map<string, EndBox> {
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
}

/** The cards and lines lit by the card or line under the pointer (or with keyboard focus). */
export function highlightOf(hover: Hover, laid: Laid | null): Highlight {
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
}

/** What a card shows, apart from its position. */
export interface CardDataInput {
  laid: Laid | null;
  graph: ModelGraph;
  missing: ReadonlyMap<string, number>;
  activeId: string;
  domIds: ReadonlyMap<string, string>;
  related: RelatedState | null;
  showRelated: CardNode['data']['onShowRelated'];
  movingId: string | undefined;
  editable: boolean;
  connectHot: string | null;
  dropAt: { id: string; ok: boolean } | null;
  /** The selected cards: the details card, and any picked with it. */
  selectedIds: ReadonlySet<string>;
  removable: ReadonlySet<string> | undefined;
  resizeFromGrip: NonNullable<CardNode['data']['onResize']>;
  onRemoveCard: ((id: string) => void) | undefined;
  inView: boolean;
  groupHeads: ReadonlyMap<string, GroupHead>;
}

/** Card contents, apart from their position, by element id. */
export function cardDataOf(input: CardDataInput): Map<string, CardNode['data']> {
  const {
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
    resizeFromGrip,
    inView,
    groupHeads,
  } = input;
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
      ...(parentElement ? { containerColour: nodeTypeDefinitions[parentElement.type].colour } : {}),
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
      selected: input.selectedIds.has(card.id),
      tabbable: card.id === activeId,
      domId: domIds.get(card.id) ?? card.id,
      handles: card.handles,
      relatedOpen: related?.cardId === card.id,
      moving: card.id === movingId,
      ...(editable && card.id === connectHot ? { connectHot: true } : {}),
      onShowRelated: showRelated,
      connectable: editable,
      ...(shape === 'card' ? { onResize: resizeFromGrip } : {}),
      ...(input.onRemoveCard && input.removable?.has(card.id) === true
        ? {
            onRemove: input.onRemoveCard,
            removeIn: inView ? ('view' as const) : ('canvas' as const),
          }
        : {}),
      ...(dropAt?.id === card.id ? { drop: dropAt.ok ? ('ok' as const) : ('self' as const) } : {}),
    };
    return [[card.id, data] as const];
  });
  return new Map(entries);
}

/** What React Flow draws as nodes, as the cards are shown now. */
export interface CanvasNodesInput {
  shown: ReadonlyMap<string, PlacedCard>;
  cardData: ReadonlyMap<string, CardNode['data']>;
  flowId: (id: string) => string;
  /** The card being dragged or moved with the keyboard: it goes on top. */
  liftedId: string | null | undefined;
  editable: boolean;
  connectHot: string | null;
  groupHeads: ReadonlyMap<string, GroupHead>;
}

/**
 * Every card and group box as a React Flow node. The card being dragged or moved with the
 * keyboard, with everything inside it, goes on top. A group box stays under its cards.
 */
export function canvasNodesOf(input: CanvasNodesInput): CanvasNode[] {
  const { shown, cardData, flowId, liftedId, editable, connectHot, groupHeads } = input;
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
}

/**
 * What edge labels and state marks must not cover: cards, only the header of a container, and
 * only the value and count of a group box.
 */
export function cardBoxesOf(
  absolute: ReadonlyMap<string, Box>,
  laid: Laid | null,
  groupHeads: ReadonlyMap<string, GroupHead>,
): Box[] {
  return [...absolute].map(([id, box]) => {
    const head = groupHeads.get(id);
    if (head) return groupTextArea(box, head.width);
    return laid?.containers.has(id) ? { ...box, height: containerBox.header } : box;
  });
}

/**
 * The nodes lit and dimmed by the highlight; and a selected Contains drawn as nesting (it has no
 * line) shows on its two cards.
 */
export function litNodesOf(
  baseNodes: CanvasNode[],
  highlight: Highlight,
  selectedNest: { source: string; target: string } | undefined,
): CanvasNode[] {
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
}

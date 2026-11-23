import {
  missingRelatedCount,
  type ModelGraph,
  type ModelRelationship,
} from '@simplearchitecture/shared';
import { useMemo } from 'react';
import {
  canvasNodesOf,
  cardBoxesOf,
  cardDataOf,
  highlightOf,
  litNodesOf,
  type GroupHead,
} from './canvasCards';
import type { Hover, Laid, RelatedState } from './canvasModel';
import type { CardNode } from './ElementCard';
import type { PlacedCard } from './elkLayout';
import { isGroupId } from './layoutGeometry';
import type { Box } from './positions';

/** What the cards are drawn from. */
export interface CanvasNodesInput {
  hover: Hover;
  laid: Laid | null;
  graph: ModelGraph;
  showRelatedPill: boolean;
  activeId: string;
  domIds: ReadonlyMap<string, string>;
  related: RelatedState | null;
  showRelated: CardNode['data']['onShowRelated'];
  movingId: string | undefined;
  draggingId: string | null;
  editable: boolean;
  connectHot: string | null;
  dropAt: { id: string; ok: boolean } | null;
  selectedIds: ReadonlySet<string>;
  removable: ReadonlySet<string> | undefined;
  resizeFromGrip: NonNullable<CardNode['data']['onResize']>;
  onRemoveCard: ((id: string) => void) | undefined;
  inView: boolean;
  groupHeads: ReadonlyMap<string, GroupHead>;
  shown: ReadonlyMap<string, PlacedCard>;
  absolute: ReadonlyMap<string, Box>;
  flowId: (id: string) => string;
  relationshipById: ReadonlyMap<string, ModelRelationship>;
  selectedRelationshipId: string | undefined;
}

/**
 * The cards and group boxes as React Flow nodes, lit by the card or line under the pointer; and
 * what the lines' labels must not cover.
 */
export function useCanvasNodes(input: CanvasNodesInput) {
  const {
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
    removable,
    resizeFromGrip,
    onRemoveCard,
    inView,
    groupHeads,
    shown,
    absolute,
    flowId,
    relationshipById,
    selectedRelationshipId,
  } = input;

  const highlight = useMemo(() => highlightOf(hover, laid), [hover, laid]);

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
  const cardData = useMemo(
    () =>
      cardDataOf({
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
        selectedIds,
        removable,
        resizeFromGrip,
        onRemoveCard,
        inView,
        groupHeads,
      }),
    [
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
      selectedIds,
      removable,
      resizeFromGrip,
      onRemoveCard,
      inView,
      groupHeads,
    ],
  );

  // The card being dragged or moved with the keyboard, with everything inside it, goes on top. A
  // group box stays under its cards (CSS lifts it with a shadow).
  const liftedId =
    draggingId !== null && isGroupId(draggingId) ? undefined : (draggingId ?? movingId);
  const baseNodes = useMemo(
    () => canvasNodesOf({ shown, cardData, flowId, liftedId, editable, connectHot, groupHeads }),
    [shown, cardData, flowId, liftedId, editable, connectHot, groupHeads],
  );

  // What edge labels and state marks must not cover: cards, only the header of a container, and
  // only the value and count of a group box.
  const cardBoxes = useMemo(
    () => cardBoxesOf(absolute, laid, groupHeads),
    [absolute, laid, groupHeads],
  );

  // A selected Contains drawn as nesting has no line: its two cards show it.
  const selected = selectedRelationshipId
    ? relationshipById.get(selectedRelationshipId)
    : undefined;
  const selectedNest =
    selected && laid?.parents.get(selected.target) === selected.source ? selected : undefined;
  const nodes = useMemo(
    () => litNodesOf(baseNodes, highlight, selectedNest),
    [baseNodes, highlight, selectedNest],
  );

  return { highlight, missing, nodes, cardBoxes };
}

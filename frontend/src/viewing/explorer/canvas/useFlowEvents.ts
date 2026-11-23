import { useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { ReactFlowProps } from '@xyflow/react';
import { nearestLineAt } from './canvasDom';
import { clickAfterDrag, type CanvasNode, type Hover, type RelatedState } from './canvasModel';
import type { ExplorerCanvasProps } from './explorerCanvasProps';
import { draggedPositions, type Holding } from './positions';
import type { RelationshipFlowEdge } from './RelationshipEdge';

type FlowEvents = Pick<
  ReactFlowProps<CanvasNode, RelationshipFlowEdge>,
  | 'onMoveStart'
  | 'onNodesChange'
  | 'onNodeDragStart'
  | 'onNodeDragStop'
  | 'onNodeClick'
  | 'onNodeMouseEnter'
  | 'onNodeMouseLeave'
  | 'onEdgeMouseEnter'
  | 'onEdgeMouseLeave'
  | 'onEdgeClick'
  | 'onPaneClick'
>;

/** What React Flow's events on the canvas read and update. */
export interface FlowEventsInput {
  props: ExplorerCanvasProps;
  focusId: string;
  /** React Flow's node id → element id. */
  elementIds: ReadonlyMap<string, string>;
  hold: Holding | null;
  holdFrom: (id: string) => Holding;
  wantArranged: () => void;
  openLink: (linkId: string, clientX: number, clientY: number) => void;
  setRelated: Dispatch<SetStateAction<RelatedState | null>>;
  setHold: Dispatch<SetStateAction<Holding | null>>;
  setDraggingId: Dispatch<SetStateAction<string | null>>;
  setHover: Dispatch<SetStateAction<Hover>>;
  setEdgeMenu: Dispatch<SetStateAction<{ ids: string[]; top: number; left: number } | null>>;
  /** A hold just dropped: once the canvas shows the drop, a grown container pushes cards aside. */
  droppedRef: RefObject<Holding | null>;
  /** When a line was last dropped, its drag cancelled, or the canvas panned from it. */
  routeMovedAtRef: RefObject<number>;
}

/**
 * React Flow's events: dragging a card (its drop is the person's change to the arrangement),
 * clicks on cards, lines and empty canvas, and hovering over cards and lines.
 */
export function useFlowEvents(input: FlowEventsInput): FlowEvents {
  const {
    props,
    focusId,
    elementIds,
    hold,
    holdFrom,
    wantArranged,
    openLink,
    setRelated,
    setHold,
    setDraggingId,
    setHover,
    setEdgeMenu,
    droppedRef,
    routeMovedAtRef,
  } = input;
  /** The card being dragged moved: its drop is the person's change to the arrangement. */
  const dragMovedRef = useRef(false);
  return {
    onMoveStart: (event) => {
      // A pan or zoom by the user (not by code) leaves the popup behind its card: close it.
      if (event) setRelated(null);
    },
    onNodesChange: (changes) => {
      const moves = draggedPositions(changes, (id) => elementIds.get(id));
      if (moves.length > 0) dragMovedRef.current = true;
      for (const [id, position] of moves) props.onMove(id, position);
    },
    onNodeDragStart: (_event, node) => {
      const id = elementIds.get(node.id);
      if (id === undefined) return;
      setRelated(null);
      setHold(holdFrom(id));
      setDraggingId(id);
      dragMovedRef.current = false;
    },
    onNodeDragStop: () => {
      setDraggingId(null);
      setHold(null);
      if (dragMovedRef.current && hold) droppedRef.current = hold;
      else if (dragMovedRef.current) wantArranged();
      dragMovedRef.current = false;
    },
    onNodeClick: (event, node) => {
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
    },
    onNodeMouseEnter: (_event, node) => {
      if (node.type !== 'groupBox') setHover({ kind: 'card', id: node.data.element.id });
    },
    onNodeMouseLeave: () => {
      setHover(null);
    },
    onEdgeMouseEnter: (_event, edge) => {
      setHover({ kind: 'link', id: edge.id });
    },
    onEdgeMouseLeave: () => {
      setHover(null);
    },
    onEdgeClick: (event, edge) => {
      // A bend handle keeps a drag's click from the line; this is in case a browser sends it
      // to the line instead.
      if (performance.now() - routeMovedAtRef.current < clickAfterDrag) return;
      openLink(nearestLineAt(event.clientX, event.clientY, edge.id), event.clientX, event.clientY);
    },
    onPaneClick: () => {
      // Nor does the end of a bend drag whose handle went (bends that lined up) clear it.
      if (performance.now() - routeMovedAtRef.current < clickAfterDrag) return;
      setEdgeMenu(null);
      props.onDeselect?.();
    },
  };
}

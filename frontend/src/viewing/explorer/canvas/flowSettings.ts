import type { EdgeTypes, NodeTypes, ReactFlowProps } from '@xyflow/react';
import type { CanvasNode } from './canvasModel';
import { ConnectionLine } from './ConnectionLine';
import { ElementCard } from './ElementCard';
import { GroupBox } from './GroupBox';
import { dragThreshold } from './positions';
import { RelationshipEdge, type RelationshipFlowEdge } from './RelationshipEdge';

const flowNodeTypes: NodeTypes = { element: ElementCard, groupBox: GroupBox };
const flowEdgeTypes: EdgeTypes = { relationship: RelationshipEdge };

/** How React Flow is set up for the canvas: what never changes between renders. */
export const flowSettings = {
  nodeTypes: flowNodeTypes,
  edgeTypes: flowEdgeTypes,
  connectionLineComponent: ConnectionLine,
  nodesDraggable: true,
  // Less movement than this is a click (which selects the element), not a drag.
  nodeDragThreshold: dragThreshold,
  nodeClickDistance: dragThreshold,
  // The same for a press on a line, its label or empty canvas: the pan it starts lets the
  // click through, so the line opens (or the selection clears).
  paneClickDistance: dragThreshold,
  // React Flow's auto-pan near the canvas edge can keep running after the drop (its loop
  // re-arms after an await), panning and moving the card on its own. Pan by hand instead.
  autoPanOnNodeDrag: false,
  nodesFocusable: false,
  edgesFocusable: false,
  elementsSelectable: false,
  disableKeyboardA11y: true,
  deleteKeyCode: null,
  selectionKeyCode: null,
  multiSelectionKeyCode: null,
  zoomOnDoubleClick: false,
  minZoom: 0.1,
  maxZoom: 2,
  proOptions: { hideAttribution: true },
  zIndexMode: 'manual',
} satisfies ReactFlowProps<CanvasNode, RelationshipFlowEdge>;

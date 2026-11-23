import { getBezierPath, Position, type ConnectionLineComponentProps } from '@xyflow/react';
import { litArrowMarkerId } from './RelationshipEdge';

/** The line while drawing a relationship: dashed accent, arrow at the pointer. */
export function ConnectionLine({ fromX, fromY, toX, toY }: ConnectionLineComponentProps) {
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

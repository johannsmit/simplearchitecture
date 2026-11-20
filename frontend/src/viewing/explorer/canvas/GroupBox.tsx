import type { Node, NodeProps } from '@xyflow/react';
import { memo } from 'react';

export interface GroupData extends Record<string, unknown> {
  /** The value as the header shows it ("Not set" for none). */
  text: string;
  /** The cards placed in the box by their value (a container once, not what it holds). */
  count: number;
  notSet: boolean;
}

export type GroupNode = Node<GroupData, 'groupBox'>;

/** The header, the box's drag handle (React Flow's `dragHandle`). */
export const groupHandleClass = 'group-head';

/**
 * A group box of Group by: a dashed neutral box headed by its value and count. Only the header
 * takes the pointer (it moves the box with its cards); the body lets presses through to the
 * canvas, so dragging there pans. Hidden from screen readers: each card's name says its group.
 */
export const GroupBox = memo(function GroupBox({ data }: NodeProps<GroupNode>) {
  return (
    <div className={`group-box${data.notSet ? ' is-notset' : ''}`} aria-hidden="true">
      <div className={groupHandleClass} title={data.text}>
        <span className="group-value">{data.text}</span>
        <span className="group-count">· {data.count}</span>
      </div>
    </div>
  );
});

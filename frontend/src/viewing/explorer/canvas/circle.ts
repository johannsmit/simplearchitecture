import type { PlacedHandle } from './elkLayout';

/**
 * The Stakeholder circle: a 48px circle at the top of a 120px wide node
 * box, with the name underneath. Edges attach to the circle's edge, never to the label, so the
 * handles ELK placed on the node box are moved onto the circle. Pure, so it is tested
 * without a browser. The numbers match .card.is-circle in styles/explorer.css.
 */

export const circleNodeWidth = 120;
export const circleDiameter = 48;
/** Between the circle and the label. */
export const circleLabelGap = 6;

const radius = circleDiameter / 2;
const centre = { x: circleNodeWidth / 2, y: radius };

/** Most degrees between two handles on one side (about 12px of arc, as `spacing.ports`). */
const maxStep = 28;
/** The arc handles may use on each side; 0° points straight out, positive is downwards. */
const arcs = {
  // The top is kept clear for the pill, the bottom for the label.
  right: { from: -15, to: 60 },
  left: { from: -50, to: 50 },
} as const;

export interface CircleHandle {
  id: string;
  kind: 'source' | 'target';
  side: 'left' | 'right';
  /** The point on the circle, from the node box's top left corner. */
  x: number;
  y: number;
}

/** The angles (degrees) of `count` handles on one side, top first. */
export function circleAngles(side: 'left' | 'right', count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const { from, to } = arcs[side];
  const step = Math.min(maxStep, (to - from) / (count - 1));
  const span = step * (count - 1);
  // Centred on 0°, moved just enough to keep the span inside the arc.
  const middle = Math.min(Math.max(0, from + span / 2), to - span / 2);
  return Array.from({ length: count }, (_, index) => middle - span / 2 + index * step);
}

/**
 * The handles of a circle node, moved onto the circle: ELK's left and right ports keep their side
 * and order; top and bottom ones go to the left (offset under the middle) or the right, after the
 * ports already there.
 */
export function circleHandles(handles: readonly PlacedHandle[]): CircleHandle[] {
  const bySide = { left: [] as PlacedHandle[], right: [] as PlacedHandle[] };
  const moved = { left: [] as PlacedHandle[], right: [] as PlacedHandle[] };
  for (const handle of handles) {
    if (handle.side === 'left' || handle.side === 'right') bySide[handle.side].push(handle);
    else moved[handle.offset < centre.x ? 'left' : 'right'].push(handle);
  }
  const byOffset = (a: PlacedHandle, b: PlacedHandle) => a.offset - b.offset;
  return (['left', 'right'] as const).flatMap((side) => {
    const ordered = [...bySide[side].sort(byOffset), ...moved[side].sort(byOffset)];
    const angles = circleAngles(side, ordered.length);
    return ordered.map((handle, index): CircleHandle => {
      const angle = ((angles[index] ?? 0) * Math.PI) / 180;
      const dx = radius * Math.cos(angle);
      return {
        id: handle.id,
        kind: handle.kind,
        side,
        x: side === 'right' ? centre.x + dx : centre.x - dx,
        y: centre.y + radius * Math.sin(angle),
      };
    });
  });
}

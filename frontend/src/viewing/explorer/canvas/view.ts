import {
  containsType,
  displayLabel,
  relationshipViewText,
  relationshipViewValues,
  type ArchitectureState,
  type EdgeType,
  type ModelRelationship,
} from '@simplearchitecture/shared';

/** One drawn edge: the relationships of one type from one card to another, merged. */
export interface CanvasLink {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  /** The relationship's label when there is exactly one with a label. */
  label?: string;
  /** How many relationships this edge stands for. */
  count: number;
  /** The ids of those relationships (`ModelRelationship.id`), in model order. */
  relationshipIds: string[];
  /** The relationships' Architecture state when they all share it; Current when mixed. */
  state: ArchitectureState;
  /** Two-way: an arrow at both ends. One-way and two-way relationships are never merged. */
  twoWay: boolean;
  /** The relationships this edge stands for, in model order. */
  members: ModelRelationship[];
}

/**
 * Merges parallel relationships (same source, target, type and direction) into
 * one edge. Ids are made up here because relationship ids from imports can hold any character: an
 * edge is `l` and the position of its first relationship, as in `layoutLinks`.
 */
export function mergeRelationships(relationships: readonly ModelRelationship[]): CanvasLink[] {
  const byKey = new Map<string, CanvasLink>();
  relationships.forEach((relationship, index) => {
    const twoWay = relationship.twoWay === true;
    const key = JSON.stringify([
      relationship.source,
      relationship.target,
      relationship.type,
      twoWay,
    ]);
    const existing = byKey.get(key);
    if (existing) {
      existing.count++;
      existing.relationshipIds.push(relationship.id);
      existing.members.push(relationship);
      delete existing.label;
      if (existing.state !== relationship.architectureState) existing.state = 'Current';
      return;
    }
    byKey.set(key, {
      id: layoutLinkId(index),
      source: relationship.source,
      target: relationship.target,
      type: relationship.type,
      ...(relationship.label === undefined ? {} : { label: relationship.label }),
      count: 1,
      relationshipIds: [relationship.id],
      state: relationship.architectureState,
      twoWay,
      members: [relationship],
    });
  });
  return [...byKey.values()];
}

const layoutLinkId = (index: number) => `l${index}`;

/**
 * What the layout is given: one link per relationship, merged or not, so merging or splitting lines
 * (picking properties to show) gives ELK the same input, and no card moves. A merged line uses
 * the port and route of its first relationship; the others only keep room for it.
 */
export function layoutLinks(
  relationships: readonly ModelRelationship[],
  isDrawn: (relationship: ModelRelationship) => boolean,
): { id: string; relationshipId: string; source: string; target: string }[] {
  return relationships.flatMap((relationship, index) =>
    isDrawn(relationship)
      ? [
          {
            id: layoutLinkId(index),
            relationshipId: relationship.id,
            source: relationship.source,
            target: relationship.target,
          },
        ]
      : [],
  );
}

/** Layout link id → the relationship it stands for (ids move as relationships come and go). */
export function layoutLinkRelationships(
  relationships: readonly ModelRelationship[],
): Map<string, string> {
  return new Map(
    relationships.map((relationship, index) => [layoutLinkId(index), relationship.id]),
  );
}

/**
 * What a line shows. With no property selected: its label filled in (`labelOf`), or nothing. With
 * properties selected: their values in place of its label, Data's "Req: …" and "Resp: …" on
 * lines of their own below the rest. Merged lines always say how many they
 * are. Contains isn't part of a viewpoint, so it only ever shows its label or count. There is no
 * type name, on hover either: the details panel and screen readers have it.
 */
export function linkText(
  link: CanvasLink,
  shown: readonly string[] = [],
  labelOf: (relationship: ModelRelationship) => string | undefined = displayLabel,
): string {
  if (link.count > 1) return `×${link.count}`;
  if (shown.length === 0 || link.type === containsType) {
    // A line with a label stands for one relationship: its properties fill the label in.
    const [only] = link.members;
    // A label is one line, as it always showed: only Data's parts get lines of their own.
    const label =
      link.label === undefined || only === undefined
        ? (link.label ?? '')
        : (labelOf({ ...only, label: link.label }) ?? '');
    return label.replace(/\s*[\r\n]+\s*/g, ' ');
  }
  // Data's parts go on lines of their own (`relationshipViewText`).
  return link.members
    .map((member) => relationshipViewText(member, shown))
    .filter((text) => text !== '')
    .join('\n');
}

/** Whether a line is grayed out: properties are selected and it has none of them. */
export function isGrayed(link: CanvasLink, shown: readonly string[]): boolean {
  if (shown.length === 0 || link.type === containsType) return false;
  return link.members.every((member) => relationshipViewValues(member, shown).length === 0);
}

export type Direction = 'left' | 'right' | 'up' | 'down';

interface Point {
  id: string;
  x: number;
  y: number;
}

/**
 * The nearest card in a direction, by card centres, within a 60° cone around it. Undefined when
 * there is none.
 */
export function nearestInDirection(
  from: Point,
  candidates: readonly Point[],
  direction: Direction,
): string | undefined {
  const unit: Record<Direction, readonly [number, number]> = {
    left: [-1, 0],
    right: [1, 0],
    up: [0, -1],
    down: [0, 1],
  };
  const [ux, uy] = unit[direction];
  let best: { id: string; distance: number } | undefined;
  for (const candidate of candidates) {
    if (candidate.id === from.id) continue;
    const dx = candidate.x - from.x;
    const dy = candidate.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) continue;
    // Within 30° either side: cos(angle) >= cos(30°).
    if ((dx * ux + dy * uy) / distance < Math.cos(Math.PI / 6)) continue;
    if (!best || distance < best.distance) best = { id: candidate.id, distance };
  }
  return best?.id;
}

/** The drag data type of an element row dragged from the element list onto the canvas. */
export const elementDragType = 'application/x-simplearchitecture-element';

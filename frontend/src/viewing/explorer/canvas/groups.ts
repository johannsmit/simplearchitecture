import {
  compareGroupValues,
  elementGroupValue,
  groupByLabel,
  type ModelGraph,
} from '@simplearchitecture/shared';
import { displayValue } from '../ElementFilter';
import { textWidth } from './cardSize';
import { groupBox, groupId, groupValueOf } from './layoutGeometry';

/**
 * Group by on the canvas: which group box each card goes in, the boxes' order, and their headers.
 * A group box is one more level above the top-level cards: a card drawn inside a container goes
 * where its container goes, whatever its own value. Pure, so it is tested without a browser.
 */

/** What a group box's header says of its value: Not set, a country as "Netherlands (NL)". */
export function groupValueText(key: string, value: string | undefined): string {
  return value === undefined ? 'Not set' : displayValue(key, value);
}

/** The width of a header's text: the value (12.5px, 600), 6px, and "· N" (12.5px, 400). */
export function groupHeaderWidth(text: string, count: number): number {
  return textWidth(text, 12.5, 600) + 6 + textWidth(`· ${String(count)}`, 12.5, 400);
}

/**
 * A group box's smallest size: as wide as its header text and 24px, from 200 to 400px (a longer
 * value ends in "…"), and room for one card.
 */
export function groupMinSize(headerWidth: number): { width: number; height: number } {
  const { minWidth, minHeight, maxHeaderWidth, textInset } = groupBox;
  return {
    width: Math.max(minWidth, Math.min(maxHeaderWidth, Math.ceil(headerWidth + 2 * textInset))),
    height: minHeight,
  };
}

/** A canvas's group boxes: each top-level card's box, and the boxes in their order. */
export interface Grouping {
  /** The property grouped by. */
  key: string;
  /** Top-level card (element id) → its group box's id. */
  groupOf: Map<string, string>;
  /** The group boxes with cards, by the property's order, Not set last. */
  order: string[];
  /** Group box id → the cards right inside it (counted in its header), in the canvas's order. */
  members: Map<string, string[]>;
}

/**
 * The group box of each top-level card (`ids` without a container in `parents`), by its value of
 * `key`, and the boxes in the property's order.
 */
export function groupCards(
  graph: ModelGraph,
  ids: readonly string[],
  parents: ReadonlyMap<string, string>,
  key: string,
): Grouping {
  const groupOf = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const id of ids) {
    if (parents.has(id)) continue;
    const element = graph.elements.get(id);
    if (!element) continue;
    const group = groupId(elementGroupValue(element, key));
    groupOf.set(id, group);
    const list = members.get(group);
    if (list) list.push(id);
    else members.set(group, [id]);
  }
  const compare = compareGroupValues(key);
  const order = [...members.keys()].sort((a, b) => compare(groupValueOf(a), groupValueOf(b)));
  return { key, groupOf, order, members };
}

/** The group box a card is in on a grouped canvas: its own, or its outermost container's. */
export function groupNowOf(
  grouping: Grouping,
  parents: ReadonlyMap<string, string>,
  id: string,
): string | undefined {
  let top = id;
  const seen = new Set([id]);
  for (let up = parents.get(id); up !== undefined && !seen.has(up); up = parents.get(up)) {
    seen.add(up);
    top = up;
  }
  return grouping.groupOf.get(top);
}

/** "Grouped by Owning team, 4 groups." for the canvas's status. */
export function groupedText(key: string, groups: number): string {
  return `Grouped by ${groupByLabel(key)}, ${String(groups)} ${groups === 1 ? 'group' : 'groups'}.`;
}

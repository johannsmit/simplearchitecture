import { compareElements, containerOf, type ModelElement, type ModelGraph } from './graph.js';
import { nodeTypes, type NodeType } from './metamodel.js';

/**
 * The element list on the left (Viewing and Modelling) as a tree: an
 * element is listed under the element it is drawn inside on the canvas (`containerOf`) when that
 * one has the same type; otherwise it is at the top of its type group. The canvas's rules decide
 * the container: the first Contains in the model's order, and never in a cycle or itself.
 */

export interface ElementListRow {
  element: ModelElement;
  /** The rows listed under this one, sorted by name. */
  children: ElementListRow[];
  /**
   * Shown only because a row under it matches the search or filters: it doesn't match itself
   * (the list shows it muted). Never set without a search or filters.
   */
  context: boolean;
}

export interface ElementListGroup {
  type: NodeType;
  /** The top-level rows, sorted by name. */
  rows: ElementListRow[];
  /** How many elements in the group match. Context rows don't count. */
  matchCount: number;
}

/** The element an element is listed under, or undefined when it is at the top of its group. */
export function listParentOf(graph: ModelGraph, elementId: string): string | undefined {
  const container = containerOf(graph, elementId);
  if (container === undefined) return undefined;
  const type = graph.elements.get(elementId)?.type;
  return type !== undefined && graph.elements.get(container)?.type === type ? container : undefined;
}

/**
 * The elements an element is listed under, from its top-level row down to its parent: the rows
 * to open so it shows. Empty for a top-level element or an unknown id.
 */
export function listAncestorsOf(graph: ModelGraph, elementId: string): string[] {
  const ancestors: string[] = [];
  // The nesting is a forest, so this ends; the set only guards against a broken invariant.
  const seen = new Set([elementId]);
  for (let id = listParentOf(graph, elementId); id !== undefined && !seen.has(id);) {
    seen.add(id);
    ancestors.push(id);
    id = listParentOf(graph, id);
  }
  return ancestors.reverse();
}

/**
 * The list as a tree per type, groups in metamodel order and empty groups left out. `matches`
 * (default: every element) are the elements that match the search and filters; each one is shown
 * with the rows it is listed under, which are marked `context` when they don't match themselves.
 * Any depth: nothing here recurses.
 */
export function elementListTree(
  graph: ModelGraph,
  matches: Iterable<ModelElement> = graph.elements.values(),
): ElementListGroup[] {
  const rows = new Map<string, ElementListRow>();
  const matchCounts = new Map<NodeType, number>();
  const countMatch = (type: NodeType) => matchCounts.set(type, (matchCounts.get(type) ?? 0) + 1);

  for (const element of matches) {
    const shown = rows.get(element.id);
    if (shown !== undefined) {
      // Added before as the context of another match, or listed twice.
      if (shown.context) {
        shown.context = false;
        countMatch(shown.element.type);
      }
      continue;
    }
    rows.set(element.id, { element, children: [], context: false });
    countMatch(element.type);
    // Stops at a row already shown: its own parents are shown with it.
    for (let id = listParentOf(graph, element.id); id !== undefined && !rows.has(id);) {
      const parent = graph.elements.get(id);
      if (parent === undefined) break;
      rows.set(id, { element: parent, children: [], context: true });
      id = listParentOf(graph, id);
    }
  }

  const topLevel = new Map<NodeType, ElementListRow[]>();
  for (const row of rows.values()) {
    const parentId = listParentOf(graph, row.element.id);
    const parent = parentId === undefined ? undefined : rows.get(parentId);
    if (parent !== undefined) {
      parent.children.push(row);
    } else {
      const group = topLevel.get(row.element.type);
      if (group) group.push(row);
      else topLevel.set(row.element.type, [row]);
    }
  }
  const byName = (a: ElementListRow, b: ElementListRow) => compareElements(a.element, b.element);
  for (const row of rows.values()) row.children.sort(byName);

  return nodeTypes
    .filter((type) => topLevel.has(type))
    .map((type) => ({
      type,
      rows: (topLevel.get(type) ?? []).sort(byName),
      matchCount: matchCounts.get(type) ?? 0,
    }));
}

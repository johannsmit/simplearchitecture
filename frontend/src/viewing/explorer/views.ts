import {
  containerOf,
  containsType,
  defaultNeighbourhoodCap,
  relationshipsOf,
  type AddedNeighbourhood,
  type ModelGraph,
  type Neighbourhood,
} from '@simplearchitecture/shared';

/**
 * An open view on the canvas: exactly its elements and relationships, with no focused element, no
 * depth and no containers brought in. A change to a view is worked out here and saved whole by the
 * page. Nothing here changes the model.
 */

/** A view's contents, by id. */
export interface ViewContents {
  elementIds: readonly string[];
  relationshipIds: readonly string[];
}

/** The most elements a view holds: as many as the canvas draws. */
export const viewCap = defaultNeighbourhoodCap;

/** No card is focused in a view: no element has this id (node ids are never empty). */
export const noFocus = '';

/**
 * What the canvas draws for a view: its elements that are in the model, and its relationships
 * whose two elements are drawn. Ids no longer in the model are skipped quietly.
 */
export function viewHood(graph: ModelGraph, contents: ViewContents): AddedNeighbourhood {
  const hops = new Map<string, number>();
  for (const id of contents.elementIds) {
    if (graph.elements.has(id) && hops.size < viewCap) hops.set(id, 0);
  }
  const wanted = new Set(contents.relationshipIds);
  const relationships = graph.relationships.filter(
    (relationship) =>
      wanted.has(relationship.id) && hops.has(relationship.source) && hops.has(relationship.target),
  );
  return {
    focusId: noFocus,
    hops,
    relationships,
    reachable: hops.size,
    capped: false,
    added: [],
    refused: [],
  };
}

/**
 * Element id → the container its card is drawn inside: its container in the model, when that
 * container and the Contains between them are both on the canvas. On a focus canvas every
 * relationship between two cards is shown, so this is the model's nesting; in a view, only a
 * Contains the view holds nests.
 */
export function nestingParents(graph: ModelGraph, hood: Neighbourhood): Map<string, string> {
  const contains = new Set<string>();
  for (const relationship of hood.relationships) {
    if (relationship.type === containsType) {
      contains.add(`${relationship.source}\n${relationship.target}`);
    }
  }
  const parents = new Map<string, string>();
  for (const id of hood.hops.keys()) {
    const container = containerOf(graph, id);
    if (
      container !== undefined &&
      hood.hops.has(container) &&
      contains.has(`${container}\n${id}`)
    ) {
      parents.set(id, container);
    }
  }
  return parents;
}

/**
 * What Save as view stores: every card the canvas draws, and every relationship among them,
 * including those drawn as nesting and each one inside a merged line. Relationships without an id
 * of their own (`hasId`) can't be named, so they are left out.
 */
export function canvasContents(
  hood: Neighbourhood,
  hasId: (relationshipId: string) => boolean,
): ViewContents {
  return {
    elementIds: [...hood.hops.keys()],
    relationshipIds: hood.relationships.map((r) => r.id).filter(hasId),
  };
}

/**
 * The contents with an element added, and its relationships (any type, either way) to elements
 * already in the view; undefined when it is in the view already. Neither its containers nor its
 * contents come along.
 */
export function withElementInView(
  graph: ModelGraph,
  contents: ViewContents,
  id: string,
  hasId: (relationshipId: string) => boolean,
): { contents: ViewContents; relationships: number } | undefined {
  if (contents.elementIds.includes(id)) return undefined;
  const inView = new Set([...contents.elementIds, id]);
  const present = new Set(contents.relationshipIds);
  const added = relationshipsOf(graph, id)
    .filter((r) => hasId(r.id) && !present.has(r.id))
    .filter((r) => inView.has(r.source) && inView.has(r.target))
    .map((r) => r.id);
  return {
    contents: {
      elementIds: [...contents.elementIds, id],
      relationshipIds: [...contents.relationshipIds, ...new Set(added)],
    },
    relationships: new Set(added).size,
  };
}

/** The contents with a new relationship added, when both of its elements are in the view. */
export function withRelationshipInView(
  contents: ViewContents,
  relationship: { id: string; source: string; target: string },
): ViewContents | undefined {
  if (contents.relationshipIds.includes(relationship.id)) return undefined;
  const inView = new Set(contents.elementIds);
  if (!inView.has(relationship.source) || !inView.has(relationship.target)) return undefined;
  return { ...contents, relationshipIds: [...contents.relationshipIds, relationship.id] };
}

/**
 * The contents without a card, its relationships and, with `nest`, the cards drawn inside it (all
 * the way down), with theirs. The elements stay in the model.
 */
export function withoutElementInView(
  graph: ModelGraph,
  contents: ViewContents,
  id: string,
  nest: boolean,
): ViewContents {
  const gone = new Set([id]);
  if (nest) {
    const parents = nestingParents(graph, viewHood(graph, contents));
    // Inside a removed card, at any depth: follow each card's chain of containers up.
    for (const card of parents.keys()) {
      const seen = new Set([card]);
      for (let up = parents.get(card); up !== undefined && !seen.has(up); up = parents.get(up)) {
        if (gone.has(up)) {
          gone.add(card);
          break;
        }
        seen.add(up);
      }
    }
  }
  const ends = new Map(graph.relationships.map((r) => [r.id, r] as const));
  return {
    elementIds: contents.elementIds.filter((other) => !gone.has(other)),
    relationshipIds: contents.relationshipIds.filter((relationshipId) => {
      const relationship = ends.get(relationshipId);
      return (
        relationship === undefined ||
        !(gone.has(relationship.source) || gone.has(relationship.target))
      );
    }),
  };
}

/** The contents without one relationship. Its elements stay in the view, and it in the model. */
export function withoutRelationshipInView(contents: ViewContents, id: string): ViewContents {
  return { ...contents, relationshipIds: contents.relationshipIds.filter((other) => other !== id) };
}

/**
 * The contents without what was deleted from the model (the server has removed it from every view
 * already): an element and the relationships it had, or one relationship.
 */
export function withoutDeleted(
  contents: ViewContents,
  deleted: { elementIds?: readonly string[]; relationshipIds?: readonly string[] },
): ViewContents {
  const elements = new Set(deleted.elementIds ?? []);
  const relationships = new Set(deleted.relationshipIds ?? []);
  return {
    elementIds: contents.elementIds.filter((id) => !elements.has(id)),
    relationshipIds: contents.relationshipIds.filter((id) => !relationships.has(id)),
  };
}

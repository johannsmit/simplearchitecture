import { randomUUID } from 'node:crypto';

/**
 * Every imported relationship gets an id, so it can be named, for example in a view. Ids that are
 * present are kept. Only imports call this: models already stored are never changed by it.
 */

/** A new id that isn't in `taken`, added to it. A UUID, as new relationships get. */
export function newRelationshipId(taken: Set<string>): string {
  let id = randomUUID();
  while (taken.has(id)) id = randomUUID();
  taken.add(id);
  return id;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The JGF document with an id on every edge that has none (`id` absent), unique among the edge ids
 * in the document, and how many were given. Never throws, whatever the input's shape, and leaves
 * the input unchanged: anything that isn't an edge object without an id stays as it is.
 */
export function withRelationshipIds(input: unknown): { document: unknown; given: number } {
  const graph = isPlainObject(input) ? input.graph : undefined;
  if (!isPlainObject(graph) || !Array.isArray(graph.edges)) return { document: input, given: 0 };
  const edges = graph.edges as unknown[];
  const needsId = (edge: unknown): edge is Record<string, unknown> =>
    isPlainObject(edge) && edge.id === undefined;
  if (!edges.some(needsId)) return { document: input, given: 0 };
  const taken = new Set<string>();
  for (const edge of edges) {
    if (isPlainObject(edge) && typeof edge.id === 'string') taken.add(edge.id);
  }
  let given = 0;
  const withIds = edges.map((edge) => {
    if (!needsId(edge)) return edge;
    given += 1;
    const id = newRelationshipId(taken);
    // The id first, as edges are written; an `id` key without a value is replaced.
    return Object.assign({ id }, edge, { id });
  });
  return { document: { ...(input as object), graph: { ...graph, edges: withIds } }, given };
}

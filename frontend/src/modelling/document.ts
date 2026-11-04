import type { JgfDocument, JgfEdge, JgfNode } from '@simplearchitecture/shared';

/**
 * Changes to the explorer's in-memory copy of a model after the server accepted them, so the
 * list, canvas, filters and containment update without loading the model again.
 */

/** The model with one element added or replaced by the server's copy. */
export function withNode(document: JgfDocument, id: string, node: JgfNode): JgfDocument {
  // The same copy (e.g. the version read on focus): keep the model, so the canvas isn't redrawn.
  if (JSON.stringify(document.graph.nodes?.[id]) === JSON.stringify(node)) return document;
  return {
    ...document,
    graph: { ...document.graph, nodes: { ...document.graph.nodes, [id]: node } },
  };
}

/** The model without an element and every relationship from or to it, as the server deletes. */
export function withoutElement(document: JgfDocument, id: string): JgfDocument {
  const nodes = Object.fromEntries(
    Object.entries(document.graph.nodes ?? {}).filter(([nodeId]) => nodeId !== id),
  );
  const graph = { ...document.graph, nodes };
  if (document.graph.edges) {
    graph.edges = document.graph.edges.filter((edge) => edge.source !== id && edge.target !== id);
  }
  return { ...document, graph };
}

/**
 * The model with one relationship replaced by the server's copy (same id), or added at the end,
 * as the server adds it (the first Contains in the model's order nests).
 */
export function withEdge(document: JgfDocument, edge: JgfEdge & { id: string }): JgfDocument {
  const edges = [...(document.graph.edges ?? [])];
  const at = edges.findIndex((other) => other.id === edge.id);
  if (at === -1) edges.push(edge);
  else if (JSON.stringify(edges[at]) === JSON.stringify(edge)) return document;
  else edges[at] = edge;
  return { ...document, graph: { ...document.graph, edges } };
}

/** The model without one relationship. */
export function withoutEdge(document: JgfDocument, id: string): JgfDocument {
  const edges = (document.graph.edges ?? []).filter((edge) => edge.id !== id);
  return { ...document, graph: { ...document.graph, edges } };
}

/**
 * Read-only queries over a stored model: an index of elements and relationships, the
 * neighbourhood of an element, and relationships in words. Pure functions with no UI or I/O, so
 * the web app, the API and a future MCP server answer the same questions the same way.
 *
 * The data says node and edge; these helpers (like the UI) say element and relationship.
 */
import type { JgfDocument, JgfEdge } from './jgf.js';
import {
  architectureStates,
  canBeTwoWay,
  defaultArchitectureState,
  canHaveInformationFlow,
  edgeTypes,
  informationFlowKey,
  hasStandardProperty,
  isEdgeType,
  isNodeType,
  isStandardPropertyOf,
  nodeTypeDefinitions,
  nodeTypeKey,
  nodeTypes,
  standardProperties,
  type ArchitectureState,
  type EdgeType,
  type NodeType,
  type StandardPropertyKey,
} from './metamodel.js';

export interface ModelElement {
  id: string;
  /** The node's label; empty when it has none. */
  name: string;
  type: NodeType;
  metadata: Readonly<Record<string, unknown>>;
}

export interface ModelRelationship {
  /** The edge's id, or `edges[3]` when it has none. */
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  /** The edge's label (e.g. an imported relationship name), when it has a non-empty one. */
  label?: string;
  /** The edge's Architecture state; Current when it has none (or an unknown one). */
  architectureState: ArchitectureState;
  /** An Information flow: only `true` on a type that can have it counts, else left out. */
  informationFlow?: boolean;
  /** The edge's metadata as stored: the Architecture state, description and custom properties. */
  metadata: Readonly<Record<string, unknown>>;
  /**
   * Two-way (JGF `"directed": false`) on a type that may be (`canBeTwoWay`). A Contains edge
   * marked so is read as one-way (a validation warning).
   */
  twoWay?: boolean;
}

export interface ModelGraph {
  name: string;
  elements: ReadonlyMap<string, ModelElement>;
  relationships: readonly ModelRelationship[];
  /** Every relationship that touches an element (a self-relationship once). */
  relationshipsByElement: ReadonlyMap<string, readonly ModelRelationship[]>;
  /**
   * Edges left out because an end is missing or the type isn't in the metamodel. Stored models
   * are validated on save, so this is normally 0.
   */
  skippedRelationships: number;
}

const noRelationships: readonly ModelRelationship[] = [];

/** Builds the index of a JGF model. Nodes with a type outside the metamodel count as Other. */
export function buildModelGraph(document: JgfDocument): ModelGraph {
  const graph = document.graph;
  const elements = new Map<string, ModelElement>();
  for (const [id, node] of Object.entries(graph.nodes ?? {})) {
    const metadata = node.metadata ?? {};
    const type = metadata[nodeTypeKey];
    elements.set(id, {
      id,
      name: typeof node.label === 'string' ? node.label : '',
      type: isNodeType(type) ? type : 'Other',
      metadata,
    });
  }

  const relationships: ModelRelationship[] = [];
  const relationshipsByElement = new Map<string, ModelRelationship[]>();
  let skippedRelationships = 0;
  (graph.edges ?? []).forEach((edge, index) => {
    const relationship =
      elements.has(edge.source) && elements.has(edge.target)
        ? relationshipOfEdge(edge, index)
        : undefined;
    if (relationship === undefined) {
      skippedRelationships++;
      return;
    }
    relationships.push(relationship);
    for (const end of new Set([edge.source, edge.target])) {
      const list = relationshipsByElement.get(end);
      if (list) list.push(relationship);
      else relationshipsByElement.set(end, [relationship]);
    }
  });

  return {
    name: typeof graph.label === 'string' ? graph.label : '',
    elements,
    relationships,
    relationshipsByElement,
    skippedRelationships,
  };
}

/** An edge as the model's index reads it; undefined when its type isn't in the metamodel. */
export function relationshipOfEdge(edge: JgfEdge, index = 0): ModelRelationship | undefined {
  if (!isEdgeType(edge.relation)) return undefined;
  const label = typeof edge.label === 'string' ? edge.label.trim() : '';
  return {
    id: typeof edge.id === 'string' && edge.id !== '' ? edge.id : `edges[${index}]`,
    source: edge.source,
    target: edge.target,
    type: edge.relation,
    ...(label === '' ? {} : { label }),
    architectureState: edgeArchitectureState(edge.metadata),
    ...(edge.metadata?.[informationFlowKey] === true && canHaveInformationFlow(edge.relation)
      ? { informationFlow: true }
      : {}),
    metadata: edge.metadata ?? {},
    ...(edge.directed === false && canBeTwoWay(edge.relation) ? { twoWay: true } : {}),
  };
}

/** An edge's Architecture state from its metadata: missing or unknown means Current. */
export function edgeArchitectureState(
  metadata: Readonly<Record<string, unknown>> | undefined,
): ArchitectureState {
  const value = metadata?.architectureState;
  return (architectureStates as readonly unknown[]).includes(value)
    ? (value as ArchitectureState)
    : defaultArchitectureState;
}

export function relationshipsOf(
  graph: ModelGraph,
  elementId: string,
): readonly ModelRelationship[] {
  return graph.relationshipsByElement.get(elementId) ?? noRelationships;
}

/** Number of relationships of an element in the whole model, optionally of some types only. */
export function degree(
  graph: ModelGraph,
  elementId: string,
  types?: ReadonlySet<EdgeType>,
): number {
  const all = relationshipsOf(graph, elementId);
  return types === undefined ? all.length : all.filter((r) => types.has(r.type)).length;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Orders names the way people expect ("Item 2" before "Item 10"), ignoring case. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

/** By name (see `compareNames`), then by id, so the order is stable. */
export function compareElements(a: ModelElement, b: ModelElement): number {
  return compareNames(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Lower case without accents, so "Zürich" matches "zurich". */
export function normaliseForSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * Where the query first matches in the text (case- and accent-insensitive), as [start, end)
 * indices into the original text, or undefined.
 */
export function matchRange(text: string, query: string): [number, number] | undefined {
  const needle = normaliseForSearch(query.trim());
  if (needle === '') return undefined;
  // The normalised text, with the original index of each of its characters.
  let normalised = '';
  const origin: number[] = [];
  let index = 0;
  for (const char of text) {
    const part = normaliseForSearch(char);
    normalised += part;
    for (let i = 0; i < part.length; i++) origin.push(index);
    index += char.length;
  }
  origin.push(index);
  const at = normalised.indexOf(needle);
  if (at === -1) return undefined;
  const start = origin[at] ?? 0;
  const lastChar = origin[at + needle.length - 1] ?? start;
  const code = text.codePointAt(lastChar) ?? 0;
  return [start, lastChar + (code > 0xffff ? 2 : 1)];
}

/** Elements whose name contains the query (case- and accent-insensitive). Empty query: all. */
export function searchElements(graph: ModelGraph, query: string): ModelElement[] {
  const needle = normaliseForSearch(query.trim());
  const all = [...graph.elements.values()];
  return needle === '' ? all : all.filter((e) => normaliseForSearch(e.name).includes(needle));
}

export interface ElementGroup {
  type: NodeType;
  elements: ModelElement[];
}

/** Elements grouped by node type in metamodel order, sorted by name. Empty groups are left out. */
export function groupByType(elements: Iterable<ModelElement>): ElementGroup[] {
  const byType = new Map<NodeType, ModelElement[]>();
  for (const element of elements) {
    const list = byType.get(element.type);
    if (list) list.push(element);
    else byType.set(element.type, [element]);
  }
  return nodeTypes
    .filter((type) => byType.has(type))
    .map((type) => ({ type, elements: (byType.get(type) ?? []).sort(compareElements) }));
}

/** The elements with the most relationships, most first (then by name). */
export function mostConnected(graph: ModelGraph, count: number): ModelElement[] {
  return [...graph.elements.values()]
    .map((element) => ({ element, degree: degree(graph, element.id) }))
    .filter(({ degree: d }) => d > 0)
    .sort((a, b) => b.degree - a.degree || compareElements(a.element, b.element))
    .slice(0, count)
    .map(({ element }) => element);
}

/** The largest neighbourhood the explorer draws (elements, including the focused one). */
export const defaultNeighbourhoodCap = 150;
export const maxDepth = 3;

export interface NeighbourhoodOptions {
  /** Relationship steps from the focused element, 1 to `maxDepth`. */
  depth: number;
  /** Relationship types to follow and return. Default: all. */
  types?: ReadonlySet<EdgeType>;
  /** Most elements to return, including the focused one. Default: `defaultNeighbourhoodCap`. */
  cap?: number;
}

export interface Neighbourhood {
  focusId: string;
  /** Element id → relationship steps from the focused element; nearest first. */
  hops: ReadonlyMap<string, number>;
  /** Every relationship of the followed types between two returned elements. */
  relationships: ModelRelationship[];
  /** Elements within `depth` before the cap, including the focused one. */
  reachable: number;
  /** True when `reachable` is more than the cap allowed. */
  capped: boolean;
}

/**
 * Breadth-first neighbourhood of an element, following relationships of the given types in both
 * directions. When it holds more than `cap` elements, the nearest are kept, then the most
 * connected, then by name. Every kept element has a path to the focused one through kept elements.
 * An unknown `focusId` gives an empty neighbourhood.
 */
export function neighbourhood(
  graph: ModelGraph,
  focusId: string,
  options: NeighbourhoodOptions,
): Neighbourhood {
  const types = options.types ?? new Set(edgeTypes);
  const cap = Math.max(1, options.cap ?? defaultNeighbourhoodCap);
  const depth = Math.max(0, Math.min(maxDepth, Math.floor(options.depth)));
  if (!graph.elements.has(focusId)) {
    return { focusId, hops: new Map(), relationships: [], reachable: 0, capped: false };
  }

  // Full breadth-first levels first, so `reachable` is the real count.
  const seen = new Set([focusId]);
  const levels: string[][] = [[focusId]];
  for (let hop = 1; hop <= depth; hop++) {
    const next: string[] = [];
    for (const id of levels[hop - 1] ?? []) {
      for (const relationship of relationshipsOf(graph, id)) {
        if (!types.has(relationship.type)) continue;
        const other = relationship.source === id ? relationship.target : relationship.source;
        if (seen.has(other)) continue;
        seen.add(other);
        next.push(other);
      }
    }
    if (next.length === 0) break;
    levels.push(next);
  }

  const hops = new Map<string, number>();
  levels.forEach((level, hop) => {
    const ranked = level
      .map((id) => ({ id, degree: degree(graph, id, types) }))
      .sort((a, b) => {
        const elementA = graph.elements.get(a.id);
        const elementB = graph.elements.get(b.id);
        return (
          b.degree - a.degree || (elementA && elementB ? compareElements(elementA, elementB) : 0)
        );
      });
    for (const { id } of ranked) {
      if (hops.size >= cap) return;
      hops.set(id, hop);
    }
  });

  const relationships: ModelRelationship[] = [];
  const added = new Set<ModelRelationship>();
  for (const id of hops.keys()) {
    for (const relationship of relationshipsOf(graph, id)) {
      if (added.has(relationship) || !types.has(relationship.type)) continue;
      if (!hops.has(relationship.source) || !hops.has(relationship.target)) continue;
      added.add(relationship);
      relationships.push(relationship);
    }
  }

  return { focusId, hops, relationships, reachable: seen.size, capped: seen.size > hops.size };
}

export interface AddedNeighbourhood extends Neighbourhood {
  /** Elements added on request and what they brought, in the order added (only those that fit). */
  added: string[];
  /** Requested or brought elements left out because the cap was reached. */
  refused: string[];
}

/**
 * A neighbourhood with extra elements added on request (e.g. from a card's related elements),
 * up to the cap. Added elements count as one step further than the nearest shown element they
 * relate to. All relationships of the followed types between shown elements are returned, as in
 * `neighbourhood`. Unknown ids are ignored, and elements already shown aren't added again. Each
 * requested element also brings what it contains, up to `depth` Contains steps down.
 */
export function withAddedElements(
  graph: ModelGraph,
  hood: Neighbourhood,
  addedIds: readonly string[],
  options: Pick<NeighbourhoodOptions, 'types' | 'cap'> & { depth?: number } = {},
): AddedNeighbourhood {
  const types = options.types ?? new Set(edgeTypes);
  const cap = Math.max(1, options.cap ?? defaultNeighbourhoodCap);
  const hops = new Map(hood.hops);
  const added: string[] = [];
  const refused = new Set<string>();
  const add = (id: string) => {
    if (hops.has(id)) return;
    if (hops.size >= cap) {
      refused.add(id);
      return;
    }
    let nearest = Number.POSITIVE_INFINITY;
    for (const relationship of relationshipsOf(graph, id)) {
      if (!types.has(relationship.type)) continue;
      const other = relationship.source === id ? relationship.target : relationship.source;
      nearest = Math.min(nearest, hops.get(other) ?? Number.POSITIVE_INFINITY);
    }
    hops.set(id, Number.isFinite(nearest) ? nearest + 1 : maxDepth + 1);
    added.push(id);
  };
  const contentDepth = types.has(containsType) ? (options.depth ?? 0) : 0;
  for (const id of addedIds) {
    if (!graph.elements.has(id)) continue;
    add(id);
    // Also through elements already shown: a shown container's contents still count.
    containedWithin(graph, id, contentDepth).forEach(add);
  }
  const refusedIds = [...refused];
  if (added.length === 0) return { ...hood, added, refused: refusedIds };
  return {
    ...hood,
    hops,
    relationships: relationshipsAmong(graph, hops, types),
    added,
    refused: refusedIds,
  };
}

/**
 * What an element contains, up to `depth` Contains steps down, nearest first. Every Contains
 * relationship from it counts, not only those drawn as nesting. Never the element itself.
 */
function containedWithin(graph: ModelGraph, id: string, depth: number): string[] {
  const seen = new Set([id]);
  let level = [id];
  const found: string[] = [];
  for (let step = 0; step < depth && level.length > 0; step++) {
    const next: string[] = [];
    for (const container of level) {
      for (const relationship of relationshipsOf(graph, container)) {
        if (relationship.type !== containsType || relationship.source !== container) continue;
        if (seen.has(relationship.target)) continue;
        seen.add(relationship.target);
        next.push(relationship.target);
      }
    }
    found.push(...next);
    level = next;
  }
  return found;
}

/** The edge type whose target is drawn nested inside its source. */
export const containsType: EdgeType = 'Contains';

/** A Contains relationship, as far as nesting needs it: an id and its two ends. */
export interface ContainsEdge {
  id: string;
  source: string;
  target: string;
}

export interface Containment<T extends ContainsEdge = ContainsEdge> {
  /** Element id → the Contains relationship that nests it in its container. */
  nestedBy: ReadonlyMap<string, T>;
  /** Container id → the elements nested in it, in model order. */
  children: ReadonlyMap<string, readonly string[]>;
  /** The relationships that nest (all others are drawn as lines). */
  nesting: ReadonlySet<T>;
  /** Contains relationships from an element to itself. */
  selfContains: readonly T[];
  /** Contains relationships that are part of a cycle (A contains B contains A). */
  inCycle: readonly T[];
  /** Element id → number of different elements that contain it, when more than one. */
  multipleContainers: ReadonlyMap<string, number>;
}

/**
 * Which Contains relationships nest and which are drawn as lines:
 * - an element containing itself, and relationships in a cycle, are drawn as lines;
 * - an element with several containers nests in the container of the first relationship in the
 *   model's edge order (parallel relationships from that container nest too); the others are
 *   drawn as lines. New relationships are added at the end, so adding one never moves a nesting.
 * The nesting relationships form a forest. Linear in the number of relationships (Tarjan's
 * strongly connected components, iterative so deep chains can't overflow the stack).
 */
export function analyseContainment<T extends ContainsEdge>(edges: readonly T[]): Containment<T> {
  const selfContains: T[] = [];
  const outgoing = new Map<string, T[]>();
  const containers = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.source === edge.target) {
      selfContains.push(edge);
      continue;
    }
    const list = outgoing.get(edge.source);
    if (list) list.push(edge);
    else outgoing.set(edge.source, [edge]);
    if (!outgoing.has(edge.target)) outgoing.set(edge.target, []);
    const sources = containers.get(edge.target);
    if (sources) sources.add(edge.source);
    else containers.set(edge.target, new Set([edge.source]));
  }

  const component = stronglyConnectedComponents(outgoing);
  const inCycle: T[] = [];
  for (const edges of outgoing.values()) {
    for (const edge of edges) {
      // Different ends in one component: there is a path back, so the edge is in a cycle.
      if (component.get(edge.source) === component.get(edge.target)) inCycle.push(edge);
    }
  }
  const cyclic = new Set(inCycle);
  const first = new Map<string, T>();
  for (const edge of edges) {
    if (edge.source === edge.target || cyclic.has(edge) || first.has(edge.target)) continue;
    first.set(edge.target, edge);
  }

  const nesting = new Set<T>();
  const nestedBy = new Map<string, T>();
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    // Parallel relationships from the chosen container nest too. (A self-relationship never
    // matches: the chosen container is never the element itself.)
    const chosen = first.get(edge.target);
    if (chosen === undefined || chosen.source !== edge.source) continue;
    nesting.add(edge);
    if (nestedBy.has(edge.target)) continue;
    nestedBy.set(edge.target, chosen);
    const list = children.get(edge.source);
    if (list) list.push(edge.target);
    else children.set(edge.source, [edge.target]);
  }

  const multipleContainers = new Map<string, number>();
  for (const [id, sources] of containers) {
    if (sources.size > 1) multipleContainers.set(id, sources.size);
  }
  return { nestedBy, children, nesting, selfContains, inCycle, multipleContainers };
}

/** Component number of each vertex (Tarjan's algorithm, without recursion). */
function stronglyConnectedComponents(
  outgoing: ReadonlyMap<string, readonly ContainsEdge[]>,
): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const component = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let nextIndex = 0;
  let components = 0;
  const visit = (vertex: string) => {
    index.set(vertex, nextIndex);
    low.set(vertex, nextIndex);
    nextIndex += 1;
    stack.push(vertex);
    onStack.add(vertex);
  };
  for (const root of outgoing.keys()) {
    if (index.has(root)) continue;
    visit(root);
    // Each frame: a vertex and the position of the next edge to follow from it.
    const work: { vertex: string; next: number }[] = [{ vertex: root, next: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1] as { vertex: string; next: number };
      const edges = outgoing.get(frame.vertex) ?? [];
      const edge = edges[frame.next];
      if (edge !== undefined) {
        frame.next += 1;
        const to = edge.target;
        if (!index.has(to)) {
          visit(to);
          work.push({ vertex: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.vertex, Math.min(low.get(frame.vertex) ?? 0, index.get(to) ?? 0));
        }
        continue;
      }
      work.pop();
      const vertexLow = low.get(frame.vertex) ?? 0;
      const parent = work[work.length - 1];
      if (parent) low.set(parent.vertex, Math.min(low.get(parent.vertex) ?? 0, vertexLow));
      if (vertexLow === index.get(frame.vertex)) {
        let member: string | undefined;
        do {
          member = stack.pop();
          if (member === undefined) break;
          onStack.delete(member);
          component.set(member, components);
        } while (member !== frame.vertex);
        components += 1;
      }
    }
  }
  return component;
}

const containmentCache = new WeakMap<ModelGraph, Containment<ModelRelationship>>();

/** The model's nesting (see `analyseContainment`), worked out once per graph. */
export function containment(graph: ModelGraph): Containment<ModelRelationship> {
  let result = containmentCache.get(graph);
  if (result === undefined) {
    result = analyseContainment(graph.relationships.filter((r) => r.type === containsType));
    containmentCache.set(graph, result);
  }
  return result;
}

/** The element that an element is drawn inside, or undefined when it isn't nested. */
export function containerOf(graph: ModelGraph, elementId: string): string | undefined {
  return containment(graph).nestedBy.get(elementId)?.source;
}

/**
 * Every other element with a Contains relationship to this one, in model order, whether it is
 * drawn nested or as a line.
 */
export function containersOf(graph: ModelGraph, elementId: string): string[] {
  const sources = new Set<string>();
  for (const relationship of relationshipsOf(graph, elementId)) {
    if (
      relationship.type === containsType &&
      relationship.target === elementId &&
      relationship.source !== elementId
    ) {
      sources.add(relationship.source);
    }
  }
  return [...sources];
}

/** The elements drawn inside an element, in model order. */
export function childrenOf(graph: ModelGraph, elementId: string): readonly string[] {
  return containment(graph).children.get(elementId) ?? [];
}

/** Whether a relationship is drawn as nesting rather than as a line. */
export function isNestingRelationship(graph: ModelGraph, relationship: ModelRelationship): boolean {
  return relationship.type === containsType && containment(graph).nesting.has(relationship);
}

/**
 * A neighbourhood with each shown element's chain of containers added (the elements it is drawn
 * inside, see `containerOf`), so nesting always shows on the canvas. Containers count towards the
 * cap: once it is reached, no more are added (the nested element is then drawn at the top level).
 * A container counts as one step further than the element it holds. Relationships of the
 * followed types between shown elements are returned, as in `neighbourhood`.
 */
export function withContainers<T extends Neighbourhood>(
  graph: ModelGraph,
  hood: T,
  options: Pick<NeighbourhoodOptions, 'types' | 'cap'> = {},
): T {
  const cap = Math.max(1, options.cap ?? defaultNeighbourhoodCap);
  const hops = new Map(hood.hops);
  for (const [id, hop] of hood.hops) {
    let step = hop;
    for (let container = containerOf(graph, id); container !== undefined;) {
      if (hops.has(container) || hops.size >= cap) break;
      step += 1;
      hops.set(container, step);
      container = containerOf(graph, container);
    }
  }
  if (hops.size === hood.hops.size) return hood;
  return { ...hood, hops, relationships: relationshipsAmong(graph, hops, options.types) };
}

/** Every relationship of the given types (default: all) between two of the elements. */
function relationshipsAmong(
  graph: ModelGraph,
  ids: ReadonlyMap<string, unknown>,
  types?: ReadonlySet<EdgeType>,
): ModelRelationship[] {
  const relationships: ModelRelationship[] = [];
  const seen = new Set<ModelRelationship>();
  for (const id of ids.keys()) {
    for (const relationship of relationshipsOf(graph, id)) {
      if (seen.has(relationship) || (types !== undefined && !types.has(relationship.type))) {
        continue;
      }
      if (!ids.has(relationship.source) || !ids.has(relationship.target)) continue;
      seen.add(relationship);
      relationships.push(relationship);
    }
  }
  return relationships;
}

/** From the element's side: its source (outgoing), its target (incoming), or two-way (both). */
export type RelationshipDirection = 'outgoing' | 'incoming' | 'both';

/**
 * How each relationship type reads from its source (outgoing), from its target (incoming), and
 * from either end of a two-way relationship (both). Contains is never two-way.
 */
export const relationshipVerbs: Record<EdgeType, Record<RelationshipDirection, string>> = {
  Relation: {
    outgoing: 'relates to',
    incoming: 'is related to',
    both: 'relates both ways to',
  },
  Contains: { outgoing: 'contains', incoming: 'is contained in', both: 'contains' },
};

/** How a Relation with Information flow reads: it says more than "relates to". */
export const informationFlowVerbs: Record<RelationshipDirection, string> = {
  outgoing: 'sends information to',
  incoming: 'receives information from',
  both: 'exchanges information both ways with',
};

export function relationshipVerb(
  type: EdgeType,
  direction: RelationshipDirection,
  informationFlow = false,
): string {
  return informationFlow && canHaveInformationFlow(type)
    ? informationFlowVerbs[direction]
    : relationshipVerbs[type][direction];
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export interface RelationshipRow {
  relationship: ModelRelationship;
  /** The element at the other end; the element itself for a self-relationship. */
  other: ModelElement;
  self: boolean;
}

export interface RelationshipGroup {
  type: EdgeType;
  /** A group of Information flows: worded apart from the other Relations. */
  informationFlow: boolean;
  direction: RelationshipDirection;
  /** E.g. "Sends information to". */
  heading: string;
  rows: RelationshipRow[];
}

/**
 * An element's relationships in words, grouped per wording in metamodel order (Information flows
 * first, outgoing first), each sorted by the other element's name. Only groups with rows are
 * returned.
 */
export function relationshipGroups(graph: ModelGraph, elementId: string): RelationshipGroup[] {
  const kinds = edgeTypes.flatMap((type) =>
    canHaveInformationFlow(type)
      ? [
          { type, informationFlow: true },
          { type, informationFlow: false },
        ]
      : [{ type, informationFlow: false }],
  );
  const groups: RelationshipGroup[] = kinds.flatMap(({ type, informationFlow }) =>
    (['outgoing', 'incoming', 'both'] as const).map((direction) => ({
      type,
      informationFlow,
      direction,
      heading: sentenceCase(relationshipVerb(type, direction, informationFlow)),
      rows: [] as RelationshipRow[],
    })),
  );
  for (const relationship of relationshipsOf(graph, elementId)) {
    const outgoing = relationship.source === elementId;
    const direction: RelationshipDirection =
      relationship.twoWay === true ? 'both' : outgoing ? 'outgoing' : 'incoming';
    const otherId = outgoing ? relationship.target : relationship.source;
    const other = graph.elements.get(otherId);
    if (!other) continue;
    const flow = relationship.informationFlow === true;
    const group = groups.find(
      (g) =>
        g.type === relationship.type && g.informationFlow === flow && g.direction === direction,
    );
    group?.rows.push({ relationship, other, self: otherId === elementId });
  }
  for (const group of groups) {
    group.rows.sort((a, b) => compareElements(a.other, b.other));
  }
  return groups.filter((group) => group.rows.length > 0);
}

export interface RelatedGroup {
  type: EdgeType;
  informationFlow: boolean;
  direction: RelationshipDirection;
  /** E.g. "Sends information to". */
  heading: string;
  /** Each related element once, sorted by name. */
  elements: ModelElement[];
}

/**
 * The elements related to an element, grouped like `relationshipGroups` (wording and direction),
 * each element once per group (parallel relationships merged), the element itself left out.
 * Only relationships of the given types (default: all).
 */
export function relatedElements(
  graph: ModelGraph,
  elementId: string,
  types?: ReadonlySet<EdgeType>,
): RelatedGroup[] {
  return relationshipGroups(graph, elementId)
    .filter((group) => types === undefined || types.has(group.type))
    .map((group) => {
      const elements: ModelElement[] = [];
      const seen = new Set<string>();
      for (const row of group.rows) {
        if (row.self || seen.has(row.other.id)) continue;
        seen.add(row.other.id);
        elements.push(row.other);
      }
      return {
        type: group.type,
        informationFlow: group.informationFlow,
        direction: group.direction,
        heading: group.heading,
        elements,
      };
    })
    .filter((group) => group.elements.length > 0);
}

/** The elements on a canvas or in a view: anything that says whether an id is in it. */
export interface ElementIdSet {
  has(id: string): boolean;
}

/**
 * Like `relatedElements`, but only the related elements that aren't in `shown` (e.g. not on the
 * canvas): what can still be added. Groups left empty are left out.
 */
export function missingRelatedElements(
  graph: ModelGraph,
  elementId: string,
  shown: ElementIdSet,
  types?: ReadonlySet<EdgeType>,
): RelatedGroup[] {
  return relatedElements(graph, elementId, types)
    .map((group) => ({ ...group, elements: group.elements.filter((e) => !shown.has(e.id)) }))
    .filter((group) => group.elements.length > 0);
}

/**
 * How many different elements related to an element (through relationships of the given types,
 * default all) aren't in `shown`. Several relationships to the same element count once; the
 * element itself never counts. Linear in the element's relationships.
 */
export function missingRelatedCount(
  graph: ModelGraph,
  elementId: string,
  shown: ElementIdSet,
  types?: ReadonlySet<EdgeType>,
): number {
  const missing = new Set<string>();
  for (const relationship of relationshipsOf(graph, elementId)) {
    if (types !== undefined && !types.has(relationship.type)) continue;
    const other = relationship.source === elementId ? relationship.target : relationship.source;
    if (other !== elementId && !shown.has(other)) missing.add(other);
  }
  return missing.size;
}

/** A relationship as a sentence, e.g. `"Portal" sends information to "Order Hub"`. */
export function describeRelationship(graph: ModelGraph, relationship: ModelRelationship): string {
  const name = (id: string) => `"${graph.elements.get(id)?.name || id}"`;
  const direction = relationship.twoWay === true ? 'both' : 'outgoing';
  const verb = relationshipVerb(relationship.type, direction, relationship.informationFlow);
  return `${name(relationship.source)} ${verb} ${name(relationship.target)}`;
}

/** The element's description with line breaks normalised, or undefined when it has none. */
export function elementDescription(element: ModelElement): string | undefined {
  const value = element.metadata.description;
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\r\n?/g, '\n').trim();
  return text === '' ? undefined : text;
}

/** The Functions list, for types that have it; empty otherwise. */
export function elementFunctions(element: ModelElement): string[] {
  if (!hasStandardProperty(element.type, 'functions')) return [];
  const value = element.metadata.functions;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** The Architecture state, for types that have it, when it holds a known value. */
export function elementArchitectureState(element: ModelElement): ArchitectureState | undefined {
  if (!hasStandardProperty(element.type, 'architectureState')) return undefined;
  const value = element.metadata.architectureState;
  return (architectureStates as readonly unknown[]).includes(value)
    ? (value as ArchitectureState)
    : undefined;
}

export interface PropertyRow {
  key: StandardPropertyKey;
  label: string;
  /** The stored value; undefined when not set. */
  value: unknown;
}

/** Properties shown in their own sections rather than in the property list. */
const ownSectionProperties: ReadonlySet<StandardPropertyKey> = new Set([
  'description',
  'functions',
]);

/** The type's standard properties in metamodel order, without description and functions. */
export function standardPropertyRows(element: ModelElement): PropertyRow[] {
  return nodeTypeDefinitions[element.type].properties
    .filter((key) => !ownSectionProperties.has(key))
    .map((key) => ({ key, label: standardProperties[key].label, value: element.metadata[key] }));
}

/**
 * A metadata value as plain text, as the details panel shows it: text as is, numbers and
 * true/false as text, a list of plain values joined with ", ", anything else as JSON.
 */
export function metadataText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((entry) => typeof entry !== 'object' || entry === null)) {
    return value.map((entry) => String(entry)).join(', ');
  }
  return JSON.stringify(value, null, 2);
}

/**
 * Metadata that isn't the type and isn't a standard property of this element's type (including
 * the original `archimateType`), sorted by key.
 */
export function customMetadata(element: ModelElement): [string, unknown][] {
  return Object.entries(element.metadata)
    .filter(([key]) => key !== nodeTypeKey && !isStandardPropertyOf(element.type, key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

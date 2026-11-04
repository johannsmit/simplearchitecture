import { containsType, relationshipsOf, type ModelGraph, type ModelRelationship } from './graph.js';
import type { EdgeType } from './metamodel.js';

/**
 * The rules for a relationship added or changed in Modelling, in one place so the
 * REST routes, the explorer and a future MCP server agree. Stored models are never checked
 * against them: an imported self-relationship or cycle stays readable.
 */

/** A relationship as it would be after the change. */
export interface RelationshipCandidate {
  source: string;
  target: string;
  type: EdgeType;
  /** The relationship being changed, left out of the checks (`ModelRelationship.id`). */
  ignore?: string;
}

export type RelationshipProblem =
  | { kind: 'self'; message: string }
  /** `duplicateOf`: the existing Contains with the same source and target. */
  | { kind: 'duplicate'; duplicateOf: string; message: string }
  /** `chain`: the Contains path from the target down to the source (target first, source last). */
  | { kind: 'cycle'; chain: string[]; message: string };

const nameOf = (graph: ModelGraph, id: string): string => graph.elements.get(id)?.name || id;

const containsCache = new WeakMap<ModelGraph, Map<string, ModelRelationship[]>>();

/** Outgoing Contains relationships per element, worked out once per graph. */
function containsBySource(graph: ModelGraph): Map<string, ModelRelationship[]> {
  let bySource = containsCache.get(graph);
  if (bySource === undefined) {
    bySource = new Map();
    for (const relationship of graph.relationships) {
      if (relationship.type !== containsType) continue;
      const list = bySource.get(relationship.source);
      if (list) list.push(relationship);
      else bySource.set(relationship.source, [relationship]);
    }
    containsCache.set(graph, bySource);
  }
  return bySource;
}

/** The shortest Contains path from `from` down to `to` (both included), or undefined. */
function containsPath(
  graph: ModelGraph,
  from: string,
  to: string,
  ignore: string | undefined,
): string[] | undefined {
  const bySource = containsBySource(graph);
  const previous = new Map<string, string>([[from, from]]);
  const queue = [from];
  for (let at = 0; at < queue.length; at++) {
    const id = queue[at] as string;
    if (id === to) {
      const path = [to];
      for (let step = to; step !== from;) {
        step = previous.get(step) as string;
        path.unshift(step);
      }
      return path;
    }
    for (const relationship of bySource.get(id) ?? []) {
      if (relationship.id === ignore || previous.has(relationship.target)) continue;
      previous.set(relationship.target, id);
      queue.push(relationship.target);
    }
  }
  return undefined;
}

/**
 * Why a relationship can't be added (or changed into this), in words; empty when it can:
 * - an element related to itself (any type);
 * - the same Contains twice (several Relations may link the same two elements);
 * - a Contains whose target already contains its source, directly or through others.
 * A second container is not a problem (it is drawn as a line, with a warning).
 */
export function relationshipProblems(
  graph: ModelGraph,
  candidate: RelationshipCandidate,
): RelationshipProblem[] {
  const { source, target, type, ignore } = candidate;
  if (source === target) {
    return [{ kind: 'self', message: "Can't connect an element to itself." }];
  }
  const problems: RelationshipProblem[] = [];
  if (type === containsType) {
    const twin = relationshipsOf(graph, source).find(
      (r) => r.id !== ignore && r.source === source && r.target === target && r.type === type,
    );
    if (twin !== undefined) {
      problems.push({
        kind: 'duplicate',
        duplicateOf: twin.id,
        message: `${nameOf(graph, source)} already contains ${nameOf(graph, target)}.`,
      });
    }
    const chain = containsPath(graph, target, source, ignore);
    if (chain !== undefined) {
      const message =
        chain.length === 2
          ? `Not possible: ${nameOf(graph, target)} contains ${nameOf(graph, source)}.`
          : `Not possible: ${nameOf(graph, source)} is inside ${nameOf(graph, target)} (through ${nameOf(graph, chain[1] as string)}).`;
      problems.push({ kind: 'cycle', chain, message });
    }
  }
  return problems;
}

import {
  storedModelKey,
  type JgfDocument,
  type ModelAuthor,
  type ModelSummary,
} from '@simplearchitecture/shared';
import { z } from 'zod';
import { countJgf } from '../jgf/validate.js';
import { maxModelNameLength, maxSourceIdLength } from '../limits.js';

/** How every store builds a stored model, so they agree exactly. */

/** The name of a model without a usable `graph.label`. */
export const untitledModelName = 'Untitled model';

/** Logs ids and reasons only, never model content. */
export interface StoreLogger {
  warn(details: object, message: string): void;
}

// Unknown fields are ignored (and dropped), so a model written by a newer version still reads.
export const summarySchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  createdBy: z.object({ id: z.string(), name: z.string() }),
  nodeCount: z.number().int().nonnegative(),
  edgeCount: z.number().int().nonnegative(),
  sourceId: z.string().optional(),
});

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cuts `text` to `max` characters (plus an ellipsis), never inside a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 1)) ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

export function modelName(label: unknown): string {
  const name = typeof label === 'string' ? label.trim() : '';
  return name === '' ? untitledModelName : cut(name, maxModelNameLength);
}

/** The client's own graph id, cut short, or undefined. */
export function sourceIdOf(id: unknown): string | undefined {
  if (typeof id !== 'string' || id.trim() === '') return undefined;
  return cut(id, maxSourceIdLength);
}

/** The server-owned data of a model about to be stored. */
export function newSummary(
  id: string,
  document: JgfDocument,
  createdBy: ModelAuthor,
  createdAt: number,
): ModelSummary {
  const counts = countJgf(document);
  const sourceId = sourceIdOf(document.graph.id);
  return {
    id,
    name: modelName(document.graph.label),
    createdAt: new Date(createdAt).toISOString(),
    createdBy: { id: createdBy.id, name: createdBy.name },
    nodeCount: counts.nodes,
    edgeCount: counts.edges,
    ...(sourceId === undefined ? {} : { sourceId }),
  };
}

/**
 * The document as stored: the server's id in `graph.id` and its data in
 * `graph.metadata["simplearchitecture:stored"]`, replacing whatever the client sent there. The
 * client's other metadata is kept.
 */
export function storedDocument(document: JgfDocument, summary: ModelSummary): JgfDocument {
  const graph = { ...document.graph };
  const clientMetadata = Object.entries(graph.metadata ?? {}).filter(
    ([key]) => key !== storedModelKey,
  );
  delete graph.id;
  delete graph.metadata;
  return {
    graph: {
      id: summary.id,
      ...graph,
      // Object.fromEntries defines own properties, so no key can touch a prototype.
      metadata: Object.fromEntries([[storedModelKey, summary], ...clientMetadata]),
    },
  };
}

/** The summary recorded in a stored document, or undefined when it has none for this id. */
export function recordedSummary(document: unknown, id: string): ModelSummary | undefined {
  const graph = isPlainObject(document) ? document.graph : undefined;
  if (!isPlainObject(graph) || graph.id !== id || !isPlainObject(graph.metadata)) return undefined;
  const parsed = summarySchema.safeParse(graph.metadata[storedModelKey]);
  if (!parsed.success || parsed.data.id !== id) return undefined;
  const { sourceId, ...summary } = parsed.data;
  return sourceId === undefined ? summary : { ...summary, sourceId };
}

/** Newest first, then by id: the order of every model list. */
export function newestFirst(a: ModelSummary, b: ModelSummary): number {
  if (a.createdAt === b.createdAt) return a.id.localeCompare(b.id);
  return a.createdAt < b.createdAt ? 1 : -1;
}

/** Runs `task` on every item, at most `limit` at a time, and keeps the order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

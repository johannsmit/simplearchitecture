import {
  informationFlowKey,
  type JgfValidationResult,
  type ValidationIssue,
} from '@simplearchitecture/shared';
import { validateJgf } from './validate.js';

/**
 * Older JGF has the edge types `Information flow` and `Integration`. Both are a
 * Relation now, and `Information flow` also sets the property. Older files and imports convert, so
 * a model never fails or reads as damaged for this. Migration 006 does the same in SQL.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The edge in today's types; the same object when there is nothing to convert. */
function convertedEdge(edge: unknown): unknown {
  if (!isPlainObject(edge)) return edge;
  if (edge.relation === 'Integration') return { ...edge, relation: 'Relation' };
  if (edge.relation !== 'Information flow') return edge;
  // Metadata of the wrong shape stays as it is, for the validation to report.
  const { metadata } = edge;
  const flowing =
    metadata === undefined || isPlainObject(metadata)
      ? { ...metadata, [informationFlowKey]: true }
      : metadata;
  return { ...edge, relation: 'Relation', metadata: flowing };
}

/**
 * The document with its older edge types converted, and how many were. Never throws, whatever the
 * input's shape, and leaves anything but those edges alone (and the input unchanged).
 */
export function convertOlderTypes(input: unknown): { document: unknown; converted: number } {
  const graph = isPlainObject(input) ? input.graph : undefined;
  if (!isPlainObject(graph) || !Array.isArray(graph.edges)) {
    return { document: input, converted: 0 };
  }
  let converted = 0;
  const edges = (graph.edges as unknown[]).map((edge) => {
    const next = convertedEdge(edge);
    if (next !== edge) converted += 1;
    return next;
  });
  if (converted === 0) return { document: input, converted };
  return { document: { ...(input as object), graph: { ...graph, edges } }, converted };
}

/**
 * What an import is checked as: converted first, with a note in the report's warnings when any edge
 * was. `document` is what to store.
 */
export function validateImported(input: unknown): {
  document: unknown;
  validation: JgfValidationResult;
} {
  const { document, converted } = convertOlderTypes(input);
  const validation = validateJgf(document);
  if (converted === 0) return { document, validation };
  const note: ValidationIssue = {
    severity: 'warning',
    code: 'older-relationship-types',
    message: `Document: ${converted} ${converted === 1 ? 'relationship' : 'relationships'} with the older type Information flow or Integration converted to Relation.`,
    field: '',
  };
  return {
    document,
    validation: {
      ...validation,
      warningCount: validation.warningCount + 1,
      warnings: [note, ...validation.warnings],
    },
  };
}

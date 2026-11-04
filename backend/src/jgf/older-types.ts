import type { JgfValidationResult, ValidationIssue } from '@simplearchitecture/shared';
import { validateJgf } from './validate.js';

/**
 * Older JGF has the edge types `Information flow` and `Integration`, and later the yes-or-no
 * property `"informationFlow": true` on a Relation. All are a plain Relation now. Where Information
 * flow was a yes on a Relation with a label, the label also becomes its Data, unless it has Data
 * already; the label stays. Older files and imports convert, so a model never fails or reads as
 * damaged for this. Migrations 006 and 009 do the same in SQL.
 */

/** The retired property's key: never custom metadata, as reading a model removes it. */
export const retiredInformationFlowKey = 'informationFlow';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The edge in today's types; the same object when there is nothing to convert. */
export function convertedEdge(edge: unknown): unknown {
  if (!isPlainObject(edge)) return edge;
  const olderFlow = edge.relation === 'Information flow';
  const relation = olderFlow || edge.relation === 'Integration' ? 'Relation' : edge.relation;
  const { metadata } = edge;
  const hasFlowKey = isPlainObject(metadata) && Object.hasOwn(metadata, retiredInformationFlowKey);
  if (relation === edge.relation && !hasFlowKey) return edge;
  // Metadata of the wrong shape stays as it is, for the validation to report. An older Information
  // flow without metadata can still take its label as Data.
  if (!isPlainObject(metadata) && !(olderFlow && metadata === undefined)) {
    return { ...edge, relation };
  }
  const flowing = olderFlow || metadata?.[retiredInformationFlowKey] === true;
  const rest = Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => key !== retiredInformationFlowKey),
  );
  const label = typeof edge.label === 'string' ? edge.label : '';
  if (flowing && relation === 'Relation' && label.trim() !== '' && !Object.hasOwn(rest, 'data')) {
    rest.data = label;
  }
  // An older Information flow without metadata gets none, unless its label became its Data.
  if (metadata === undefined && Object.keys(rest).length === 0) return { ...edge, relation };
  return { ...edge, relation, metadata: rest };
}

/**
 * The document with its older edge types and Information flow converted, and how many edges were.
 * Never throws, whatever the input's shape, and leaves anything but those edges alone (and the
 * input unchanged).
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
    message: `Document: ${converted} ${converted === 1 ? 'relationship' : 'relationships'} with the older type Information flow or Integration, or with Information flow, converted to a Relation. A labelled Information flow keeps its label as Data.`,
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

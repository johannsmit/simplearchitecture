import {
  retiredDataKey,
  type JgfValidationResult,
  type ValidationIssue,
} from '@simplearchitecture/shared';
import { withRelationshipIds } from './relationship-ids.js';
import { validateJgf } from './validate.js';

/**
 * Older JGF has the edge types `Information flow` and `Integration`, and later the yes-or-no
 * property `"informationFlow": true` on a Relation. All are a plain Relation now. Where Information
 * flow was a yes on a Relation with a label, the label also becomes its Data, unless it has Data
 * already; the label stays. Migrations 006 and 009 do the same in SQL.
 *
 * Later still, Data (`"data"`) became two properties, Request Data and Response Data: Data moves to
 * Request Data (`"requestData"`), on any edge, unless it has Request Data already (then both stay as
 * they are), and every `{Data}` in a label becomes `{Request Data}`, ignoring case and spaces inside
 * the braces (`{{Data}}` is literal text and stays). Migration 012 does the same in SQL.
 *
 * Older files and imports convert, so a model never fails or reads as damaged for this.
 */

/** The retired property's key: never custom metadata, as reading a model removes it. */
export const retiredInformationFlowKey = 'informationFlow';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Request Data: where Data goes. */
const requestDataKey = 'requestData';

/**
 * A label's pieces, as `fillLabel` reads them: `{{` and `}}` (literal braces), `{Data}` with any case
 * and white space inside the braces, text without braces, and a lone brace. `\s` is JavaScript's
 * white space, the same set as migration 012's.
 */
const labelPieces = /\{\{|\}\}|\{\s*[Dd][Aa][Tt][Aa]\s*\}|[^{}]+|[{}]/g;
const dataExpression = /^\{\s*[Dd][Aa][Tt][Aa]\s*\}$/;

/** The label with every `{Data}` as `{Request Data}`; the same string when it has none. */
export function withRequestDataInLabel(label: string): string {
  if (!/\{\s*[Dd][Aa][Tt][Aa]\s*\}/.test(label)) return label;
  const pieces = label.match(labelPieces) ?? [];
  const next = pieces
    .map((piece) => (dataExpression.test(piece) ? '{Request Data}' : piece))
    .join('');
  return next === label ? label : next;
}

/**
 * The edge with Data as Request Data; the same object when there is nothing to convert. With
 * `labels` false, the label stays as it is (a stored model's labels were converted by migration
 * 012, and a `{Data}` typed since is an unknown name like any other).
 */
export function convertedData(edge: unknown, labels = true): unknown {
  if (!isPlainObject(edge)) return edge;
  let next = edge;
  const { metadata } = edge;
  if (
    isPlainObject(metadata) &&
    Object.hasOwn(metadata, retiredDataKey) &&
    !Object.hasOwn(metadata, requestDataKey)
  ) {
    next = {
      ...next,
      metadata: Object.fromEntries(
        Object.entries(metadata).map(([key, value]) =>
          key === retiredDataKey ? [requestDataKey, value] : [key, value],
        ),
      ),
    };
  }
  if (labels && typeof edge.label === 'string') {
    const label = withRequestDataInLabel(edge.label);
    if (label !== edge.label) next = { ...next, label };
  }
  return next;
}

/** The edge in today's types and properties; the same object when there is nothing to convert. */
export function convertedEdge(edge: unknown, labels = true): unknown {
  return convertedData(convertedEdgeType(edge), labels);
}

/** The edge with the older types and Information flow converted (to Data, as migration 009 does). */
export function convertedEdgeType(edge: unknown): unknown {
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
 * The document with its older edge types, Information flow and Data converted, and how many edges
 * were: `converted` for the types and Information flow, `dataConverted` for Data and `{Data}` on
 * the others.
 * Never throws, whatever the input's shape, and leaves anything but those edges alone (and the
 * input unchanged). With `labels` false, labels stay as they are (see `convertedData`).
 */
export function convertOlderTypes(
  input: unknown,
  { labels = true }: { labels?: boolean } = {},
): { document: unknown; converted: number; dataConverted: number } {
  const graph = isPlainObject(input) ? input.graph : undefined;
  if (!isPlainObject(graph) || !Array.isArray(graph.edges)) {
    return { document: input, converted: 0, dataConverted: 0 };
  }
  let converted = 0;
  let dataConverted = 0;
  const edges = (graph.edges as unknown[]).map((edge) => {
    const typed = convertedEdgeType(edge);
    const next = convertedData(typed, labels);
    // An edge counts once: an older type or Information flow says it all.
    if (typed !== edge) converted += 1;
    else if (next !== typed) dataConverted += 1;
    return next;
  });
  if (converted === 0 && dataConverted === 0) return { document: input, converted, dataConverted };
  return {
    document: { ...(input as object), graph: { ...graph, edges } },
    converted,
    dataConverted,
  };
}

/**
 * What an import is checked as: converted first, with a note in the report's warnings when any edge
 * was. `document` is what to store: as checked, with an id on every relationship that had none.
 */
export function validateImported(input: unknown): {
  document: unknown;
  validation: JgfValidationResult;
} {
  const { document: checked, converted, dataConverted } = convertOlderTypes(input);
  const validation = validateJgf(checked);
  const { document } = withRelationshipIds(checked);
  const relationships = (count: number) =>
    `${count} ${count === 1 ? 'relationship' : 'relationships'}`;
  const notes: ValidationIssue[] = [];
  if (converted > 0) {
    notes.push({
      severity: 'warning',
      code: 'older-relationship-types',
      message: `Document: ${relationships(converted)} with the older type Information flow or Integration, or with Information flow, converted to a Relation. A labelled Information flow keeps its label as Request Data.`,
      field: '',
    });
  }
  if (dataConverted > 0) {
    notes.push({
      severity: 'warning',
      code: 'older-data-property',
      message: `Document: ${relationships(dataConverted)} with Data, or with {Data} in the label, converted: Data is now Request Data.`,
      field: '',
    });
  }
  if (notes.length === 0) return { document, validation };
  return {
    document,
    validation: {
      ...validation,
      warningCount: validation.warningCount + notes.length,
      warnings: [...notes, ...validation.warnings],
    },
  };
}

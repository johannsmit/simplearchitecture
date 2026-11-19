import {
  olderDataKeys,
  relationDataProperties,
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
 * Later again, Request Data and Response Data became lists of texts: a single text in either, on
 * any edge, becomes a list of that one text, and a blank one is removed (it held no value). Any other
 * shape stays as it is, for the validation to warn about. Migration 013 does the same in SQL.
 *
 * Then the two lists were named by direction: Request Data (`"requestData"`) became Source to
 * target data (`"sourceToTargetData"`) and Response Data (`"responseData"`) Target to source data
 * (`"targetToSourceData"`), on any edge, each with its value as it is, unless the edge has the new
 * key already (then both stay as they are). Every `{Request Data}` and `{Response Data}` in a label
 * becomes `{Source to Target Data}` and `{Target to Source Data}`, ignoring case and white space
 * inside the braces (`{{Request Data}}` is literal text and stays). Migration 018 does the same in
 * SQL. The conversions run in order, so Data ends as Source to target data, and a single text in an
 * older key as a list under the new one.
 *
 * Older files and imports convert, so a model never fails or reads as damaged for this.
 */

/** The retired property's key: never custom metadata, as reading a model removes it. */
export const retiredInformationFlowKey = 'informationFlow';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Request Data: where Data goes, before the direction step renames it. */
const requestDataKey = 'requestData';
/** Source to target data: where Request Data goes. Data stays put when it is there. */
const forwardDataKey = olderDataKeys.requestData.key;

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
    !Object.hasOwn(metadata, requestDataKey) &&
    !Object.hasOwn(metadata, forwardDataKey)
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

/**
 * A label's pieces, as `fillLabel` reads them: `{{` and `}}` (literal braces), `{Request Data}` and
 * `{Response Data}` with any case and white space inside the braces (one run or more between the
 * words, as names compare), text without braces, and a lone brace. `\s` is JavaScript's white
 * space, the same set as migration 018's.
 */
const directionPieces =
  /\{\{|\}\}|\{\s*[Rr][Ee][Qq][Uu][Ee][Ss][Tt]\s+[Dd][Aa][Tt][Aa]\s*\}|\{\s*[Rr][Ee][Ss][Pp][Oo][Nn][Ss][Ee]\s+[Dd][Aa][Tt][Aa]\s*\}|[^{}]+|[{}]/g;
const requestExpression = /^\{\s*[Rr][Ee][Qq][Uu][Ee][Ss][Tt]\s+[Dd][Aa][Tt][Aa]\s*\}$/;
const responseExpression = /^\{\s*[Rr][Ee][Ss][Pp][Oo][Nn][Ss][Ee]\s+[Dd][Aa][Tt][Aa]\s*\}$/;
const anyOlderName =
  /\{\s*(?:[Rr][Ee][Qq][Uu][Ee][Ss][Tt]|[Rr][Ee][Ss][Pp][Oo][Nn][Ss][Ee])\s+[Dd][Aa][Tt][Aa]\s*\}/;

/**
 * The label with every `{Request Data}` as `{Source to Target Data}` and every `{Response Data}` as
 * `{Target to Source Data}`; the same string when it has none.
 */
export function withDirectionNamesInLabel(label: string): string {
  if (!anyOlderName.test(label)) return label;
  const pieces = label.match(directionPieces) ?? [];
  const next = pieces
    .map((piece) =>
      requestExpression.test(piece)
        ? '{Source to Target Data}'
        : responseExpression.test(piece)
          ? '{Target to Source Data}'
          : piece,
    )
    .join('');
  return next === label ? label : next;
}

/**
 * The edge with Request Data and Response Data under their keys named by direction, and their names
 * in the label too; the same object when there is nothing to convert. An edge that has a new key
 * already keeps the older one beside it, as it is. With `labels` false, the label stays as it is (a
 * stored model's labels were converted by migration 018).
 */
export function convertedDirections(edge: unknown, labels = true): unknown {
  if (!isPlainObject(edge)) return edge;
  let next = edge;
  const { metadata } = edge;
  if (isPlainObject(metadata)) {
    const moves = new Map<string, string>(
      Object.entries(olderDataKeys).flatMap(([older, { key }]): [string, string][] =>
        Object.hasOwn(metadata, older) && !Object.hasOwn(metadata, key) ? [[older, key]] : [],
      ),
    );
    if (moves.size > 0) {
      next = {
        ...next,
        metadata: Object.fromEntries(
          Object.entries(metadata).map(([key, value]) => [moves.get(key) ?? key, value]),
        ),
      };
    }
  }
  if (labels && typeof edge.label === 'string') {
    const label = withDirectionNamesInLabel(edge.label);
    if (label !== edge.label) next = { ...next, label };
  }
  return next;
}

/** The keys of the lists of data, today's and older (kept beside a new one, or read on its own). */
const listKeys: readonly string[] = [...relationDataProperties, ...Object.keys(olderDataKeys)];

/**
 * The edge with a single text in either list of data (under its key today or an older one) as a
 * list of that text, and a blank
 * one removed; the same object when there is nothing to convert. The text is kept exactly, as
 * migration 013 keeps it.
 */
export function convertedDataLists(edge: unknown): unknown {
  if (!isPlainObject(edge)) return edge;
  const { metadata } = edge;
  if (!isPlainObject(metadata)) return edge;
  if (!listKeys.some((key) => typeof metadata[key] === 'string')) return edge;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (listKeys.includes(key) && typeof value === 'string') {
      if (value.trim() !== '') next[key] = [value];
    } else {
      next[key] = value;
    }
  }
  return { ...edge, metadata: next };
}

/** The edge in today's types and properties; the same object when there is nothing to convert. */
export function convertedEdge(edge: unknown, labels = true): unknown {
  return convertedDataLists(
    convertedDirections(convertedData(convertedEdgeType(edge), labels), labels),
  );
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
 * The document with its older edge types, Information flow, Data, Request Data and Response Data
 * and single-text lists converted, and how many edges were: `converted` for the types and
 * Information flow, `dataConverted` for Data and `{Data}` on the others, `directionConverted` for
 * Request Data, Response Data and their names in labels on the rest. A single text read as a list
 * isn't counted: it is the same value.
 * Never throws, whatever the input's shape, and leaves anything but those edges alone (and the
 * input unchanged). With `labels` false, labels stay as they are (see `convertedData`).
 */
export function convertOlderTypes(
  input: unknown,
  { labels = true }: { labels?: boolean } = {},
): { document: unknown; converted: number; dataConverted: number; directionConverted: number } {
  const graph = isPlainObject(input) ? input.graph : undefined;
  if (!isPlainObject(graph) || !Array.isArray(graph.edges)) {
    return { document: input, converted: 0, dataConverted: 0, directionConverted: 0 };
  }
  let converted = 0;
  let dataConverted = 0;
  let directionConverted = 0;
  let listed = 0;
  const edges = (graph.edges as unknown[]).map((edge) => {
    const typed = convertedEdgeType(edge);
    const withData = convertedData(typed, labels);
    const directed = convertedDirections(withData, labels);
    const next = convertedDataLists(directed);
    // An edge counts once, for its oldest conversion: an older type or Information flow says it all.
    if (typed !== edge) converted += 1;
    else if (withData !== typed) dataConverted += 1;
    else if (directed !== withData) directionConverted += 1;
    if (next !== directed) listed += 1;
    return next;
  });
  if (converted === 0 && dataConverted === 0 && directionConverted === 0 && listed === 0) {
    return { document: input, converted, dataConverted, directionConverted };
  }
  return {
    document: { ...(input as object), graph: { ...graph, edges } },
    converted,
    dataConverted,
    directionConverted,
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
  const {
    document: checked,
    converted,
    dataConverted,
    directionConverted,
  } = convertOlderTypes(input);
  const validation = validateJgf(checked);
  const { document } = withRelationshipIds(checked);
  const relationships = (count: number) =>
    `${count} ${count === 1 ? 'relationship' : 'relationships'}`;
  const notes: ValidationIssue[] = [];
  if (converted > 0) {
    notes.push({
      severity: 'warning',
      code: 'older-relationship-types',
      message: `Document: ${relationships(converted)} with the older type Information flow or Integration, or with Information flow, converted to a Relation. A labelled Information flow keeps its label as Source to target data.`,
      field: '',
    });
  }
  if (dataConverted > 0) {
    notes.push({
      severity: 'warning',
      code: 'older-data-property',
      message: `Document: ${relationships(dataConverted)} with Data, or with {Data} in the label, converted: Data is now Source to target data.`,
      field: '',
    });
  }
  if (directionConverted > 0) {
    notes.push({
      severity: 'warning',
      code: 'older-data-direction',
      message: `Document: ${relationships(directionConverted)} with Request Data or Response Data, or with them in the label, converted: Request Data is now Source to target data, Response Data is now Target to source data.`,
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

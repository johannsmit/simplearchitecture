import {
  compareElements,
  compareNames,
  elementDescription,
  metadataText,
  type ModelElement,
} from './graph.js';
import {
  isNodeType,
  nodeTypeDefinitions,
  nodeTypes,
  standardProperties,
  type NodeType,
  type PropertyKind,
  type StandardPropertyKey,
} from './metamodel.js';

/**
 * The catalog: the elements that match the element list's search and filters as a
 * table. One tab per node type, with that type's standard properties as columns, and All with
 * name, type and description. Pure functions, so the web app and a future MCP server agree.
 */

export type CatalogTab = NodeType | 'all';

/** The tabs in display order: All first, then the node types in metamodel order. */
export const catalogTabs: readonly CatalogTab[] = ['all', ...nodeTypes];

export function isCatalogTab(value: unknown): value is CatalogTab {
  return value === 'all' || isNodeType(value);
}

export type CatalogColumnKey = 'name' | 'type' | StandardPropertyKey;

export interface CatalogColumn {
  key: CatalogColumnKey;
  label: string;
}

export interface CatalogCell {
  /** The value as stored (the name for `name`, the type for `type`); undefined when not set. */
  value: unknown;
  /** The value as plain text, as the details panel reads it; '' when not set. */
  text: string;
}

export interface CatalogRow {
  element: ModelElement;
  /** One cell per column, in the columns' order. */
  cells: CatalogCell[];
}

export type CatalogSortDirection = 'asc' | 'desc';

export interface CatalogSort {
  column: CatalogColumnKey;
  direction: CatalogSortDirection;
}

export const defaultCatalogSort: CatalogSort = { column: 'name', direction: 'asc' };

export interface CatalogTable {
  columns: CatalogColumn[];
  /** The tab's matching elements, sorted. */
  rows: CatalogRow[];
  /** Matches per tab (`all`: every match), whichever tab is shown. */
  counts: Record<CatalogTab, number>;
}

const nameColumn: CatalogColumn = { key: 'name', label: 'Name' };
const allColumns: readonly CatalogColumn[] = [
  nameColumn,
  { key: 'type', label: 'Type' },
  { key: 'description', label: standardProperties.description.label },
];

/**
 * Name, then the type's standard properties in metamodel order with Functions last, as the details
 * panel shows them. All: name, type, description.
 */
export function catalogColumns(tab: CatalogTab): CatalogColumn[] {
  if (tab === 'all') return [...allColumns];
  const keys = nodeTypeDefinitions[tab].properties;
  return [
    nameColumn,
    ...[
      ...keys.filter((key) => key !== 'functions'),
      ...keys.filter((key) => key === 'functions'),
    ].map((key) => ({ key, label: standardProperties[key].label })),
  ];
}

/** Whether the tab has the column, e.g. for a sort read from the address. */
export function hasCatalogColumn(tab: CatalogTab, column: string): column is CatalogColumnKey {
  return catalogColumns(tab).some((c) => c.key === column);
}

/**
 * One cell. Description reads as the details panel shows it (line breaks normalised, trimmed);
 * other properties as the stored value in text (a list joined with ", "). Only own keys count.
 */
export function catalogCell(element: ModelElement, key: CatalogColumnKey): CatalogCell {
  if (key === 'name') return { value: element.name, text: element.name.trim() };
  if (key === 'type') return { value: element.type, text: element.type };
  const value = Object.hasOwn(element.metadata, key) ? element.metadata[key] : undefined;
  if (key === 'description') return { value, text: elementDescription(element) ?? '' };
  const text = value === undefined || value === null ? '' : metadataText(value).trim();
  return { value, text };
}

/** Matches per tab: each type's, and `all` for every match. */
export function catalogCounts(matches: Iterable<ModelElement>): Record<CatalogTab, number> {
  const counts = Object.fromEntries(catalogTabs.map((tab) => [tab, 0])) as Record<
    CatalogTab,
    number
  >;
  for (const element of matches) {
    counts.all += 1;
    counts[element.type] += 1;
  }
  return counts;
}

/** Orders two non-empty texts of a column: types and choices in metamodel order. */
function compareText(key: CatalogColumnKey, a: string, b: string): number {
  const rule: PropertyKind | undefined =
    key === 'name' || key === 'type' ? undefined : standardProperties[key].value;
  const order: readonly string[] | undefined =
    key === 'type' ? nodeTypes : rule?.kind === 'choice' ? rule.options : undefined;
  if (order !== undefined) {
    const ai = order.indexOf(a);
    const bi = order.indexOf(b);
    // Values outside the metamodel come after the known ones.
    if (ai !== -1 || bi !== -1) return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
  }
  return compareNames(a, b);
}

/** By name with unnamed elements last, then by id (`compareElements`). */
function byName(a: ModelElement, b: ModelElement): number {
  const unnamedA = a.name.trim() === '';
  if (unnamedA !== (b.name.trim() === '')) return unnamedA ? 1 : -1;
  return compareElements(a, b);
}

/**
 * The rows sorted by a column, as a new array. Empty cells go last in both directions; equal
 * cells by name (ascending), then id, so the order is stable. A column the rows don't have sorts
 * by name.
 */
export function sortCatalogRows(
  rows: readonly CatalogRow[],
  columns: readonly CatalogColumn[],
  sort: CatalogSort,
): CatalogRow[] {
  const index = columns.findIndex((column) => column.key === sort.column);
  const at = index === -1 ? columns.findIndex((column) => column.key === 'name') : index;
  const key = columns[at]?.key ?? 'name';
  const sign = index !== -1 && sort.direction === 'desc' ? -1 : 1;
  const textOf = (row: CatalogRow) => row.cells[at]?.text ?? '';
  return [...rows].sort((a, b) => {
    const ta = textOf(a);
    const tb = textOf(b);
    if (ta === '' || tb === '') {
      if (ta !== tb) return ta === '' ? 1 : -1;
    } else {
      const order = compareText(key, ta, tb);
      if (order !== 0) return sign * order;
    }
    return byName(a.element, b.element);
  });
}

/**
 * The catalog for a tab: its columns, its rows (the matches of its type, or all of them) sorted,
 * and the matches per tab. `matches` are the elements that match the search and filters
 * (`findElements`).
 */
export function catalogTable(
  matches: readonly ModelElement[],
  tab: CatalogTab,
  sort: CatalogSort = defaultCatalogSort,
): CatalogTable {
  const columns = catalogColumns(tab);
  const rows = matches
    .filter((element) => tab === 'all' || element.type === tab)
    .map((element) => ({
      element,
      cells: columns.map((column) => catalogCell(element, column.key)),
    }));
  return { columns, rows: sortCatalogRows(rows, columns, sort), counts: catalogCounts(matches) };
}

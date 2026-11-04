import { catalogTabs, type CatalogTab } from '@simplearchitecture/shared';

/** What the older Information Flow viewpoint shows today: a Relation's Data. */
const olderFlowKey = 'data';

/**
 * URLs of the explorer, in Viewing (read-only) and Modelling (editing). Both spaces use the same
 * sub-paths, so a deep link works in either by swapping the first segment. Ids are URL-encoded:
 * OEF identifiers can hold any character.
 */

export type ExplorerSpace = 'viewing' | 'modelling';

export const viewingHome = '/viewing';
export const modellingHome = '/modelling';

export function spaceHome(space: ExplorerSpace): string {
  return space === 'modelling' ? modellingHome : viewingHome;
}

export function modelPath(modelId: string, space: ExplorerSpace = 'viewing'): string {
  return `${spaceHome(space)}/models/${encodeURIComponent(modelId)}`;
}

export function elementPath(
  modelId: string,
  elementId: string,
  depth?: number,
  space: ExplorerSpace = 'viewing',
  shown: readonly string[] = [],
): string {
  const path = `${modelPath(modelId, space)}/elements/${encodeURIComponent(elementId)}`;
  const query = [
    ...(depth === undefined ? [] : [`depth=${depth}`]),
    ...shown.map((key) => `show=${encodeURIComponent(key)}`),
  ].join('&');
  return query === '' ? path : `${path}?${query}`;
}

/**
 * An address from an older version named a fixed viewpoint. `viewpoint=information-flow` reads as
 * Data selected (where Information flow went), and any other value as nothing more selected. The
 * search to rewrite the address with (without it), or undefined when it has none. "?" unless empty.
 */
export function withoutOldViewpoint(params: URLSearchParams): string | undefined {
  const old = params.get('viewpoint');
  if (old === null) return undefined;
  const next = new URLSearchParams(params);
  next.delete('viewpoint');
  if (old.toLowerCase() === 'information-flow' && !next.getAll('show').includes(olderFlowKey)) {
    next.append('show', olderFlowKey);
  }
  const text = next.toString();
  return text === '' ? '' : `?${text}`;
}

/** Most properties a viewpoint can select, and the longest name read from an address. */
export const maxShownProperties = 20;
export const maxShownKeyLength = 100;

/**
 * The relationship properties a viewpoint shows, from the address (`show=protocol&show=auth`). Only
 * the address holds them, so a viewpoint can be shared as a link: a property name is model content,
 * so it never goes in the browser's storage.
 */
export function readShownProperties(params: URLSearchParams): string[] {
  const keys = params.getAll('show').filter((key) => key !== '' && key.length <= maxShownKeyLength);
  return [...new Set(keys)].slice(0, maxShownProperties);
}

/** The address's search with these properties shown; other parameters stay. "?" unless empty. */
export function shownPropertiesSearch(params: URLSearchParams, keys: readonly string[]): string {
  const next = new URLSearchParams(params);
  next.delete('show');
  for (const key of keys) next.append('show', key);
  const text = next.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * The explorer's middle view, in the address next to `depth`:
 * nothing for the canvas, `view=catalog` for the catalog, with `type=Application` for its tab
 * (none for All). An older `tab=` is still read. The sort is kept per model and tab instead.
 */
export type ExplorerView = 'canvas' | 'catalog';

const viewKeys = ['view', 'type', 'tab'] as const;

/** The view and the catalog's tab read from the address. Anything unknown reads as its default. */
export function readExplorerView(params: URLSearchParams): {
  view: ExplorerView;
  tab: CatalogTab;
} {
  const view: ExplorerView = params.get('view') === 'catalog' ? 'catalog' : 'canvas';
  const asked = (params.get('type') ?? params.get('tab'))?.toLowerCase();
  const tab = catalogTabs.find((t) => t.toLowerCase() === asked) ?? 'all';
  return { view, tab };
}

/**
 * The address's search with the view (and for the catalog its tab) set; other parameters, such as
 * `depth`, stay. All is left out. Starts with "?" unless empty.
 */
export function explorerSearch(
  params: URLSearchParams,
  view: ExplorerView,
  tab: CatalogTab = 'all',
): string {
  const next = new URLSearchParams(params);
  for (const key of viewKeys) next.delete(key);
  if (view === 'catalog') {
    next.set('view', 'catalog');
    if (tab !== 'all') next.set('type', tab);
  }
  const text = next.toString();
  return text === '' ? '' : `?${text}`;
}

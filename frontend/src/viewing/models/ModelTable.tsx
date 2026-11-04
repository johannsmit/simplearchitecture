import { compareNames, type ModelSummary } from '@simplearchitecture/shared';
import { Link } from 'react-router';
import { Icon } from '../../icons';
import { formatNumber } from '../../words';
import { modelPath, type ExplorerSpace } from '../paths';

export const sortKeys = ['name', 'elements', 'relationships', 'created'] as const;
export type SortKey = (typeof sortKeys)[number];
export type SortDirection = 'asc' | 'desc';
export interface Sort {
  key: SortKey;
  dir: SortDirection;
}

/** Created on, newest first: the API's order. */
export const defaultSort: Sort = { key: 'created', dir: 'desc' };

/** Names sort A to Z on the first click; counts and dates largest or newest first. */
export const firstDirection: Record<SortKey, SortDirection> = {
  name: 'asc',
  elements: 'desc',
  relationships: 'desc',
  created: 'desc',
};

export function parseSort(key: string | null, dir: string | null): Sort {
  const sortKey = sortKeys.find((candidate) => candidate === key);
  if (!sortKey) return defaultSort;
  return { key: sortKey, dir: dir === 'asc' || dir === 'desc' ? dir : firstDirection[sortKey] };
}

export function sortModels(models: readonly ModelSummary[], sort: Sort): ModelSummary[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const compare = (a: ModelSummary, b: ModelSummary): number => {
    switch (sort.key) {
      case 'name':
        return compareNames(a.name, b.name);
      case 'elements':
        return a.nodeCount - b.nodeCount;
      case 'relationships':
        return a.edgeCount - b.edgeCount;
      case 'created':
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    }
  };
  return [...models].sort((a, b) => sign * compare(a, b) || compareNames(a.name, b.name));
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

const columnLabels: Record<SortKey, string> = {
  name: 'Name',
  elements: 'Elements',
  relationships: 'Relationships',
  created: 'Created on',
};

interface ModelTableProps {
  /** Undefined while loading: skeleton rows are shown. */
  models: ModelSummary[] | undefined;
  sort: Sort;
  onSort: (key: SortKey) => void;
  canDelete: boolean;
  newId: string | null;
  onDelete: (model: ModelSummary, button: HTMLButtonElement) => void;
  /** Adds an Export button to each row. */
  onExport?: (model: ModelSummary) => void;
  /** The models being exported: their buttons wait, keeping focus (a disabled button loses it). */
  exporting?: ReadonlySet<string>;
  /** Keeps a reference to each name link, so focus can move to a row after a delete. */
  nameLink: (id: string, element: HTMLAnchorElement | null) => void;
  /** Where a model opens (Viewing unless given). */
  space?: ExplorerSpace;
}

/** The stored models as a sortable table. */
export function ModelTable(props: ModelTableProps) {
  const { models, sort, canDelete } = props;

  const header = (key: SortKey) => {
    const active = sort.key === key;
    const numeric = key === 'elements' || key === 'relationships';
    return (
      <th
        scope="col"
        className={numeric ? 'n' : key === 'created' ? 'col-date' : undefined}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      >
        <button
          className="sort"
          type="button"
          onClick={() => {
            props.onSort(key);
          }}
        >
          {columnLabels[key]}
          {active && <Icon name={sort.dir === 'asc' ? 'arrow-up' : 'arrow-down'} size="sm" />}
        </button>
      </th>
    );
  };

  return (
    <div className="table-card">
      <table className="models-table" aria-busy={models === undefined ? true : undefined}>
        <caption className="vh">Stored models</caption>
        <thead>
          <tr>
            {header('name')}
            {header('elements')}
            {header('relationships')}
            <th scope="col" className="col-by">
              Created by
            </th>
            {header('created')}
            <th scope="col">
              <span className="vh">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {models === undefined
            ? [0, 1, 2].map((row) => (
                <tr key={row} className="skeleton-row">
                  <td>
                    <span className="skeleton wide" />
                  </td>
                  <td className="n">
                    <span className="skeleton" />
                  </td>
                  <td className="n">
                    <span className="skeleton" />
                  </td>
                  <td className="col-by">
                    <span className="skeleton" />
                  </td>
                  <td>
                    <span className="skeleton" />
                  </td>
                  <td className="act" />
                </tr>
              ))
            : models.map((model) => (
                <tr key={model.id} className={model.id === props.newId ? 'is-new' : undefined}>
                  <td className="name-cell">
                    <Link
                      to={modelPath(model.id, props.space)}
                      ref={(element) => {
                        props.nameLink(model.id, element);
                      }}
                    >
                      {model.name}
                    </Link>
                    <span className="by-line">{model.createdBy.name}</span>
                  </td>
                  <td className="n">{formatNumber(model.nodeCount)}</td>
                  <td className="n">{formatNumber(model.edgeCount)}</td>
                  <td className="col-by">{model.createdBy.name}</td>
                  <td className="col-date" title={model.createdAt}>
                    {formatDate(model.createdAt)}
                  </td>
                  <td className="act">
                    <Link
                      className="btn"
                      to={modelPath(model.id, props.space)}
                      aria-label={`Open ${model.name} in the explorer`}
                    >
                      <Icon name="eye" size="sm" />
                      Open
                    </Link>
                    {props.onExport && (
                      <button
                        className="icon-btn"
                        type="button"
                        aria-label={`Export ${model.name}`}
                        aria-disabled={props.exporting?.has(model.id) ? true : undefined}
                        title="Export"
                        onClick={() => {
                          props.onExport?.(model);
                        }}
                      >
                        <Icon name="download" />
                      </button>
                    )}
                    {canDelete && (
                      <button
                        className="icon-btn"
                        type="button"
                        aria-label={`Delete ${model.name}`}
                        title="Delete"
                        onClick={(event) => {
                          props.onDelete(model, event.currentTarget);
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}

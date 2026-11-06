import { compareNames, normaliseForSearch, type ViewSummary } from '@simplearchitecture/shared';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { Link } from 'react-router';
import { ApiRequestError, listViews } from '../../api';
import { Icon } from '../../icons';
import { counted } from '../../words';
import { viewPath, type ExplorerSpace } from '../paths';

/** With this many views or more, the list has a filter. */
export const viewFilterFrom = 9;

type ListLoad =
  | { status: 'loading' }
  | { status: 'ready'; views: ViewSummary[] }
  | { status: 'failed'; message: string };

/**
 * The model's views by name, read again each time it becomes active or `refresh` changes (views
 * saved by others show up). Until that read arrives it says loading, never the list from last
 * time, so a view just saved, renamed or deleted is never shown as it was.
 */
export function useViewList(modelId: string, active: boolean, refresh = 0): [ListLoad, () => void] {
  const [load, setLoad] = useState<{ key: string; value: ListLoad }>({
    key: '',
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);
  // A new read, with a new key, on every activation.
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setAttempt((n) => n + 1);
  }
  const key = `${modelId}\n${attempt}\n${refresh}`;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    listViews(modelId, controller.signal)
      .then((views) => {
        const sorted = [...views].sort((a, b) => compareNames(a.name, b.name));
        setLoad({ key, value: { status: 'ready', views: sorted } });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Without a database the server says views need one; anything else is a plain failure.
        const message =
          error instanceof ApiRequestError && error.status === 501 ? error.message : '';
        setLoad({ key, value: { status: 'failed', message } });
      });
    return () => {
      controller.abort();
    };
  }, [active, key, modelId]);
  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);
  return [active && load.key === key ? load.value : { status: 'loading' }, retry];
}

interface ViewsSectionProps {
  modelId: string;
  space: ExplorerSpace;
  /** The relationship properties shown: a view's link keeps them. */
  shown: readonly string[];
  /** The open view, marked in the list. */
  currentViewId: string | undefined;
  /** What the list says without views. */
  emptyText: string;
  /** Save as view, under the list: only on a focus canvas in Modelling with editing on. */
  onSaveAsView?: (() => void) | undefined;
  /** Open or closed (remembered per browser by the page). */
  open: boolean;
  onToggle: () => void;
  /** Goes up by one after this person saves, renames or deletes a view: the list is read again. */
  refresh: number;
  headerRef: RefObject<HTMLButtonElement | null>;
  saveRef: RefObject<HTMLButtonElement | null>;
  /** A view picked in the list, just before its address opens. */
  onOpenView: (viewId: string) => void;
}

/**
 * The Views section of the left panel: a disclosure header and, when open, the model's views as
 * links (with a filter from 9 views) and Save as view. Nothing is read while it is closed.
 */
export function ViewsSection({ headerRef, saveRef, ...props }: ViewsSectionProps) {
  const box = useRef<HTMLDivElement>(null);
  const bodyId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!props.open) return;
    const all = [...(box.current?.querySelectorAll<HTMLAnchorElement>('.vp-list a') ?? [])];
    if (all.length === 0) return;
    const filter = box.current?.querySelector<HTMLInputElement>('.vp-filter input') ?? null;
    const target = event.target;
    const at = all.indexOf(target as HTMLAnchorElement);
    const fromTop = target === headerRef.current || target === filter;
    let next: HTMLElement | null | undefined;
    if (event.key === 'ArrowDown') {
      if (fromTop) next = all[0];
      else if (at >= 0) next = all[Math.min(all.length - 1, at + 1)];
    } else if (event.key === 'ArrowUp' && at >= 0) {
      next = at === 0 ? (filter ?? headerRef.current) : all[at - 1];
    } else if (at >= 0 && event.key === 'Home') next = all[0];
    else if (at >= 0 && event.key === 'End') next = all.at(-1);
    if (next === undefined || next === null) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div ref={box} className="psec views-sec" onKeyDown={onKeyDown}>
      <button
        ref={headerRef}
        type="button"
        className="psec-head"
        aria-expanded={props.open}
        aria-controls={props.open ? bodyId : undefined}
        onClick={props.onToggle}
      >
        <Icon name="chev-right" size="sm" />
        Views
      </button>
      {props.open && <ViewsBody {...props} saveRef={saveRef} id={bodyId} />}
    </div>
  );
}

/** The open section: mounted on each opening, so the list is read again and the filter is empty. */
function ViewsBody({ saveRef, ...props }: Omit<ViewsSectionProps, 'headerRef'> & { id: string }) {
  const [query, setQuery] = useState('');
  const [load, retry] = useViewList(props.modelId, true, props.refresh);
  const views = load.status === 'ready' ? load.views : [];
  const filtered = views.length >= viewFilterFrom;
  const needle = normaliseForSearch(query.trim());
  const matching = filtered
    ? views.filter((view) => needle === '' || normaliseForSearch(view.name).includes(needle))
    : views;

  return (
    <div id={props.id} className="psec-body">
      {load.status === 'loading' ? (
        <p className="vp-empty" role="status">
          <span className="spinner sm" aria-hidden="true" /> Loading views…
        </p>
      ) : load.status === 'failed' ? (
        <p className="vp-empty" role="alert">
          {load.message || "The views couldn't be loaded."}{' '}
          {load.message === '' && (
            <button type="button" className="linkbtn" onClick={retry}>
              Try again
            </button>
          )}
        </p>
      ) : views.length === 0 ? (
        <p className="vp-empty">{props.emptyText}</p>
      ) : (
        <>
          {filtered && (
            <div className="vp-filter">
              <Icon name="search" size="sm" />
              <input
                type="search"
                aria-label="Filter views"
                placeholder="Filter views…"
                autoComplete="off"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
            </div>
          )}
          {matching.length === 0 ? (
            <p className="vp-empty">No views match “{query.trim()}”.</p>
          ) : (
            <ul
              className="vp-list"
              aria-label="Views in this model"
              style={{ '--vp-rows': matching.length } as CSSProperties}
            >
              {matching.map((view) => {
                const current = view.id === props.currentViewId;
                return (
                  <li key={view.id}>
                    <Link
                      to={viewPath(props.modelId, view.id, props.space, props.shown)}
                      title={view.name}
                      {...(current ? { 'aria-current': 'page' as const } : {})}
                      onClick={() => {
                        props.onOpenView(view.id);
                      }}
                    >
                      <span className="chk" aria-hidden="true">
                        {current && <Icon name="check" size="sm" />}
                      </span>
                      <span className="n">{view.name || '(unnamed)'}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {filtered && (
            <p className="vh" role="status">
              {counted(matching.length, 'view')}
            </p>
          )}
        </>
      )}
      {props.onSaveAsView && (
        <button ref={saveRef} type="button" className="btn save-view" onClick={props.onSaveAsView}>
          <Icon name="bookmark-plus" />
          Save as view…
        </button>
      )}
    </div>
  );
}

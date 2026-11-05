import { compareNames, normaliseForSearch, type ViewSummary } from '@simplearchitecture/shared';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
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
 * The model's views by name, read again each time it becomes active (views saved by others show
 * up). Until that read arrives it says loading, never the list from last time, so a view just
 * saved, renamed or deleted is never shown as it was.
 */
export function useViewList(modelId: string, active: boolean): [ListLoad, () => void] {
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
  const key = `${modelId}\n${attempt}`;
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

interface ViewsMenuProps {
  modelId: string;
  space: ExplorerSpace;
  /** The relationship properties shown: a view's link keeps them. */
  shown: readonly string[];
  /** The open view, marked in the list. */
  currentViewId: string | undefined;
  /** What the list says without views. */
  emptyText: string;
  /** Save as view, the last row: only on a focus canvas in Modelling with editing on. */
  onSaveAsView?: (() => void) | undefined;
  /** Goes up by one to open the list from elsewhere (All views on the start page). */
  openRequest: number;
  buttonRef: RefObject<HTMLButtonElement | null>;
  /** A view picked in the list, just before its address opens. */
  onOpenView: (viewId: string) => void;
}

/**
 * The Views button and its list, in the Show Viewpoints pattern: a disclosure button and a small
 * panel, closed by Esc, a click outside or tabbing out. Each view is a link to its address.
 */
export function ViewsMenu({ buttonRef, ...props }: ViewsMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const popId = useId();
  const titleId = useId();
  const [load, retry] = useViewList(props.modelId, open);

  const openRequest = useRef(props.openRequest);
  useEffect(() => {
    if (openRequest.current === props.openRequest) return;
    openRequest.current = props.openRequest;
    setOpen(true);
    setQuery('');
    buttonRef.current?.focus();
    // Only on a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.openRequest]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => {
      document.removeEventListener('mousedown', outside);
    };
  }, [open]);

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  };

  const views = load.status === 'ready' ? load.views : [];
  const filtered = views.length >= viewFilterFrom;
  const needle = normaliseForSearch(query.trim());
  const matching = filtered
    ? views.filter((view) => needle === '' || normaliseForSearch(view.name).includes(needle))
    : views;

  const rows = () => [...(list.current?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    // The explorer's own keys (N, the canvas) wait while the list is open.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    const all = rows();
    if (all.length === 0) return;
    const at = all.indexOf(document.activeElement as HTMLAnchorElement);
    let next: HTMLElement | null | undefined;
    if (event.key === 'ArrowDown') next = at < 0 ? all[0] : all[Math.min(all.length - 1, at + 1)];
    else if (event.key === 'ArrowUp' && at >= 0)
      next = at === 0 ? (filter.current ?? all[0]) : all[at - 1];
    else if (at >= 0 && event.key === 'Home') next = all[0];
    else if (at >= 0 && event.key === 'End') next = all.at(-1);
    if (next === undefined || next === null) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div
      ref={box}
      className="views-menu"
      onBlur={(event) => {
        const to = event.relatedTarget;
        if (to !== null && !box.current?.contains(to)) setOpen(false);
      }}
      onKeyDown={onKeyDown}
    >
      <button
        ref={buttonRef}
        type="button"
        className="btn tidy views-btn"
        aria-label="Views"
        title="Views"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={() => {
          setOpen(!open);
          setQuery('');
        }}
      >
        <Icon name="bookmark" />
        <span className="tidy-label">
          Views
          <Icon name="chev-down" size="sm" />
        </span>
      </button>
      {open && (
        <div id={popId} className="views-pop" role="group" aria-labelledby={titleId}>
          <p className="vp-title" id={titleId}>
            Views in this model
          </p>
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
                    ref={filter}
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
                <ul ref={list} className="vp-list">
                  {matching.map((view) => {
                    const current = view.id === props.currentViewId;
                    return (
                      <li key={view.id}>
                        <Link
                          to={viewPath(props.modelId, view.id, props.space, props.shown)}
                          title={view.name}
                          {...(current ? { 'aria-current': 'page' as const } : {})}
                          onClick={() => {
                            setOpen(false);
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
            <div className="vp-foot">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setOpen(false);
                  props.onSaveAsView?.();
                }}
              >
                <Icon name="bookmark-plus" />
                Save as view…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

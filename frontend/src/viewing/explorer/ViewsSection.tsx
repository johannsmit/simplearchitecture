import { normaliseForSearch, viewFolderKey, type ViewSummary } from '@simplearchitecture/shared';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { ApiRequestError, moveView } from '../../api';
import { Icon } from '../../icons';
import { counted } from '../../words';
import { viewPath, type ExplorerSpace } from '../paths';
import { useViewList } from './useViewList';
import { NewFolderDialog, RenameFolderDialog } from './ViewDialogs';
import { filterGroups, groupViews, useClosedFolders, type ViewFolder } from './viewFolders';

export { useViewList } from './useViewList';

/** With this many views or more, the list has a filter. */
export const viewFilterFrom = 9;

/** How far the pointer moves with the button down before a row is dragged, in pixels. */
const dragThreshold = 4;
/** Within this distance of the list's top or bottom edge, a drag scrolls the list. */
const scrollEdge = 24;

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
  /**
   * Views can be dragged to folders, and folders renamed (Modelling with editing on). The server
   * checks the role whatever this says.
   */
  editable: boolean;
  /** Open or closed (remembered per browser by the page). */
  open: boolean;
  onToggle: () => void;
  /** Goes up by one after this person saves, renames or deletes a view: the list is read again. */
  refresh: number;
  headerRef: RefObject<HTMLButtonElement | null>;
  saveRef: RefObject<HTMLButtonElement | null>;
  /** A view picked in the list, just before its address opens. */
  onOpenView: (viewId: string) => void;
  /** Says what a move or a folder's rename did. */
  onAnnounce: (text: string) => void;
  /** Views whose folder changed here, as saved (the open view's bar shows its folder). */
  onFolderChanged: (views: ViewSummary[]) => void;
}

/**
 * The Views section of the left panel: a disclosure header and, when open, the model's views as
 * links, grouped in folders (with a filter from 9 views), and Save as view. Nothing is read while
 * it is closed.
 */
export function ViewsSection({ headerRef, saveRef, ...props }: ViewsSectionProps) {
  const box = useRef<HTMLDivElement>(null);
  const bodyId = useId();

  // ↑ ↓ Home End go through the folder headers and the views shown; the body handles → ← F2.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!props.open || event.defaultPrevented) return;
    const all = [
      ...(box.current?.querySelectorAll<HTMLElement>('.vp-list .vf-toggle, .vp-list a') ?? []),
    ];
    if (all.length === 0) return;
    const filter = box.current?.querySelector<HTMLInputElement>('.vp-filter input') ?? null;
    const target = event.target;
    const at = all.indexOf(target as HTMLElement);
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

/** Where a view is: `f:<folder key>`, or `none` without a folder. A drop target has the same. */
const placeOf = (view: ViewSummary): string =>
  view.folder === null ? 'none' : `f:${viewFolderKey(view.folder)}`;

/** A view put in a folder here: on its way (`settled` false) or saved, until the list shows it. */
interface Override {
  folder: string | null;
  settled: boolean;
}

interface Drag {
  view: ViewSummary;
  x: number;
  y: number;
  /** The drop target under the pointer (never the view's own place), or null. */
  over: string | null;
}

interface Press {
  view: ViewSummary;
  x: number;
  y: number;
  dragging: boolean;
  /** `Esc` ended the drag: the button is still down, and its click must not open the view. */
  cancelled: boolean;
}

const offline = (error: unknown) =>
  !(error instanceof ApiRequestError) || error.status === 0 || error.status >= 500;

/** The open section: mounted on each opening, so the list is read again and the filter is empty. */
function ViewsBody({ saveRef, ...props }: Omit<ViewsSectionProps, 'headerRef'> & { id: string }) {
  const body = useRef<HTMLDivElement>(null);
  const groupId = useId();
  const [query, setQuery] = useState('');
  const [load, retry, reread] = useViewList(props.modelId, true, props.refresh);
  const closed = useClosedFolders(props.modelId);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(new Map());
  const [alert, setAlert] = useState<string | null>(null);
  const [newFolderFor, setNewFolderFor] = useState<ViewSummary | null>(null);
  const [renaming, setRenaming] = useState<ViewFolder | null>(null);
  const [focusOn, setFocusOn] = useState<{ folder: string } | { view: string } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pressing, setPressing] = useState(false);
  const press = useRef<Press | null>(null);
  // A click that ends a drag neither opens a view nor opens or closes a folder.
  const suppressClick = useRef(false);

  // A new list shows the moves saved before it was read: their overrides go.
  const listed = load.status === 'ready' ? load.views : null;
  const [seen, setSeen] = useState(listed);
  if (listed !== seen) {
    setSeen(listed);
    if (listed !== null && [...overrides.values()].some((each) => each.settled)) {
      setOverrides(new Map([...overrides].filter(([, each]) => !each.settled)));
    }
  }

  const views = (listed ?? []).map((view) => {
    const override = overrides.get(view.id);
    return override === undefined ? view : { ...view, folder: override.folder };
  });
  const groups = groupViews(views);
  const filtered = views.length >= viewFilterFrom;
  const needle = filtered ? normaliseForSearch(query.trim()) : '';
  const filtering = needle !== '';
  const shown = filterGroups(groups, needle);
  const shownCount =
    shown.loose.length + shown.folders.reduce((sum, folder) => sum + folder.views.length, 0);
  const sizes = new Map(groups.folders.map((folder) => [folder.key, folder.views.length]));
  // Renaming acts on the whole folder, not just the views the filter shows.
  const rename = (folder: ViewFolder) => {
    setRenaming(groups.folders.find((each) => each.key === folder.key) ?? folder);
  };

  // While filtering, matching folders show open; closing one then lasts until the filter changes.
  const [filterClosed, setFilterClosed] = useState({ needle: '', keys: new Set<string>() });
  const closedWhileFiltering =
    filterClosed.needle === needle ? filterClosed.keys : new Set<string>();
  const isOpen = (folder: ViewFolder) =>
    filtering ? !closedWhileFiltering.has(folder.key) : !closed.isClosed(folder.name);
  const toggle = (folder: ViewFolder) => {
    if (!filtering) {
      closed.toggle(folder.name);
      return;
    }
    const keys = new Set(closedWhileFiltering);
    if (keys.has(folder.key)) keys.delete(folder.key);
    else keys.add(folder.key);
    setFilterClosed({ needle, keys });
  };

  // Folders that no longer exist are forgotten.
  const folderList = groups.folders.map((folder) => folder.name).join('\n');
  const keepOnly = closed.keepOnly;
  useEffect(() => {
    if (listed !== null) keepOnly(folderList === '' ? [] : folderList.split('\n'));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the names, once per list read
  }, [listed, folderList]);

  // Focus after a dialog: on a folder's header or a view's link, once it is drawn.
  useEffect(() => {
    if (focusOn === null) return;
    const header = (key: string) =>
      [...(body.current?.querySelectorAll<HTMLElement>('.vf-toggle') ?? [])].find(
        (element) => element.dataset.folder === key,
      );
    let target: HTMLElement | undefined;
    if ('folder' in focusOn) {
      target = header(focusOn.folder);
    } else {
      target = [...(body.current?.querySelectorAll<HTMLElement>('.vp-list a') ?? [])].find(
        (element) => element.dataset.viewId === focusOn.view,
      );
      // In a closed folder: its header.
      const folder = (listed ?? []).find((view) => view.id === focusOn.view)?.folder;
      if (target === undefined && folder != null) target = header(viewFolderKey(folder));
    }
    if (target === undefined) return;
    target.focus();
    setFocusOn(null);
  }, [focusOn, listed, overrides]);

  const setOverride = (viewId: string, override: Override | undefined) => {
    setOverrides((previous) => {
      const next = new Map(previous);
      if (override === undefined) next.delete(viewId);
      else next.set(viewId, override);
      return next;
    });
  };

  /** Saved: the list shows it until it is read again, and the page hears of it. */
  const settled = (saved: ViewSummary[]) => {
    setOverrides((previous) => {
      const next = new Map(previous);
      for (const view of saved) next.set(view.id, { folder: view.folder, settled: true });
      return next;
    });
    props.onFolderChanged(saved);
    reread();
  };

  const move = (view: ViewSummary, folder: string | null) => {
    setAlert(null);
    setOverride(view.id, { folder, settled: false });
    moveView(props.modelId, view.id, { folder })
      .then((saved) => {
        settled([saved]);
        const name = view.name.trim();
        props.onAnnounce(
          saved.folder === null
            ? `Took “${name}” out of its folder.`
            : `Moved “${name}” to “${saved.folder}”.`,
        );
      })
      .catch((error: unknown) => {
        setOverride(view.id, undefined);
        if (error instanceof ApiRequestError && error.status === 404) {
          setAlert('Someone else deleted this view.');
          reread();
        } else if (offline(error)) {
          setAlert("The view wasn't moved. Check your connection and try again.");
        } else {
          setAlert(`The view wasn't moved. ${error instanceof Error ? error.message : ''}`.trim());
        }
      });
  };

  const dropOn = (view: ViewSummary, target: string) => {
    if (target === 'new') {
      setNewFolderFor(view);
    } else if (target === 'none') {
      move(view, null);
    } else {
      const folder = groups.folders.find((each) => `f:${each.key}` === target);
      if (folder !== undefined) move(view, folder.name);
    }
  };
  // The listeners below live while the button is down; they call the latest drop.
  const dropRef = useRef(dropOn);
  useEffect(() => {
    dropRef.current = dropOn;
  });

  useEffect(() => {
    if (!pressing) return;
    let scrollStep = 0;
    let frame: number | null = null;
    const list = () => body.current?.querySelector<HTMLElement>('.vp-list') ?? null;
    const scroll = () => {
      const element = list();
      if (scrollStep === 0 || element === null) {
        frame = null;
        return;
      }
      element.scrollTop += scrollStep;
      frame = requestAnimationFrame(scroll);
    };
    const edgeScroll = (y: number) => {
      const rect = list()?.getBoundingClientRect();
      if (rect === undefined || rect.height === 0) return;
      scrollStep = y < rect.top + scrollEdge ? -6 : y > rect.bottom - scrollEdge ? 6 : 0;
      if (scrollStep !== 0 && frame === null) frame = requestAnimationFrame(scroll);
    };
    const targetOf = (event: Event): string | null => {
      const element = event.target instanceof Element ? event.target.closest('[data-drop]') : null;
      if (element === null || body.current?.contains(element) !== true) return null;
      return element.getAttribute('data-drop');
    };
    const stopDragging = () => {
      scrollStep = 0;
      setDrag(null);
      document.body.style.removeProperty('cursor');
    };
    const end = () => {
      press.current = null;
      setPressing(false);
      stopDragging();
    };
    const onMove = (event: PointerEvent) => {
      const current = press.current;
      if (current === null || current.cancelled) return;
      if (!current.dragging) {
        const distance = Math.hypot(event.clientX - current.x, event.clientY - current.y);
        if (distance < dragThreshold) return;
        current.dragging = true;
      }
      const target = targetOf(event);
      const over = target === placeOf(current.view) ? null : target;
      setDrag({ view: current.view, x: event.clientX, y: event.clientY, over });
      document.body.style.cursor = over === null ? 'not-allowed' : 'grabbing';
      edgeScroll(event.clientY);
    };
    const onUp = (event: PointerEvent) => {
      const current = press.current;
      if (current !== null && (current.dragging || current.cancelled)) {
        suppressClick.current = true;
        setTimeout(() => {
          suppressClick.current = false;
        }, 0);
        const target = current.cancelled ? null : targetOf(event);
        if (target !== null && target !== placeOf(current.view)) {
          dropRef.current(current.view, target);
        }
      }
      end();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      const current = press.current;
      if (event.key !== 'Escape' || current === null || !current.dragging) return;
      event.preventDefault();
      event.stopPropagation();
      current.dragging = false;
      current.cancelled = true;
      stopDragging();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', end);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', end);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', end);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', end);
      if (frame !== null) cancelAnimationFrame(frame);
      document.body.style.removeProperty('cursor');
    };
  }, [pressing]);

  const startPress = (event: ReactPointerEvent<HTMLElement>, view: ViewSummary) => {
    if (event.button !== 0) return;
    press.current = { view, x: event.clientX, y: event.clientY, dragging: false, cancelled: false };
    setPressing(true);
  };

  // → and ← on folders, F2 to rename one (the section handles ↑ ↓ Home End).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const header = target.classList.contains('vf-toggle') ? target : null;
    const folder =
      header === null
        ? undefined
        : shown.folders.find((each) => each.key === header.dataset.folder);
    if (header !== null && folder !== undefined) {
      const expanded = header.getAttribute('aria-expanded') === 'true';
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (!expanded) toggle(folder);
        else header.closest('li')?.querySelector<HTMLElement>('ul a')?.focus();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (expanded) toggle(folder);
      } else if (event.key === 'F2' && props.editable) {
        event.preventDefault();
        rename(folder);
      }
    } else if (event.key === 'ArrowLeft' && target.matches('.vf > ul a')) {
      event.preventDefault();
      target.closest('.vf')?.querySelector<HTMLElement>('.vf-toggle')?.focus();
    }
  };

  const lit = drag?.over ?? null;
  const row = (view: ViewSummary) => {
    const current = view.id === props.currentViewId;
    return (
      <Link
        to={viewPath(props.modelId, view.id, props.space, props.shown)}
        title={view.name}
        draggable={false}
        data-view-id={view.id}
        className={drag?.view.id === view.id ? 'is-dragged' : undefined}
        {...(current ? { 'aria-current': 'page' as const } : {})}
        {...(props.editable
          ? {
              onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
                startPress(event, view);
              },
            }
          : {})}
        onClick={(event) => {
          if (suppressClick.current) {
            event.preventDefault();
            return;
          }
          props.onOpenView(view.id);
        }}
      >
        <span className="chk" aria-hidden="true">
          {current && <Icon name="check" size="sm" />}
        </span>
        <span className="n">{view.name || '(unnamed)'}</span>
      </Link>
    );
  };

  const looseLit = lit === 'none';
  // Folder headers count as rows, and the views of open folders.
  const rowCount =
    shown.loose.length +
    shown.folders.reduce((sum, folder) => sum + 1 + (isOpen(folder) ? folder.views.length : 0), 0);
  const showNoFolderRow =
    drag !== null && drag.view.folder !== null && shown.loose.length === 0 && props.editable;

  return (
    <div
      ref={body}
      id={props.id}
      className={`psec-body${drag === null ? '' : ' is-dragging'}${props.editable ? ' can-move' : ''}`}
      onKeyDown={onKeyDown}
    >
      {alert !== null && (
        <p className="alert vf-alert" role="alert">
          <span>{alert}</span>
          <button
            type="button"
            className="vf-dismiss"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={() => {
              setAlert(null);
            }}
          >
            <Icon name="x" size="sm" />
          </button>
        </p>
      )}
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
          {shownCount === 0 ? (
            <p className="vp-empty">No views match “{query.trim()}”.</p>
          ) : (
            <ul
              className="vp-list"
              aria-label="Views in this model"
              style={{ '--vp-rows': rowCount } as CSSProperties}
            >
              {shown.folders.map((folder, index) => {
                const open = isOpen(folder);
                const holdsOpenView =
                  !open && folder.views.some((view) => view.id === props.currentViewId);
                const listId = `${groupId}-${index}`;
                const drop = `f:${folder.key}`;
                const size = sizes.get(folder.key) ?? folder.views.length;
                return (
                  <li
                    key={folder.key}
                    className={`vf${lit === drop ? ' is-drop' : ''}`}
                    {...(props.editable ? { 'data-drop': drop } : {})}
                  >
                    <div className="vf-head">
                      <button
                        type="button"
                        className="vf-toggle"
                        data-folder={folder.key}
                        aria-expanded={open}
                        aria-controls={open ? listId : undefined}
                        title={folder.name}
                        onClick={() => {
                          if (!suppressClick.current) toggle(folder);
                        }}
                      >
                        <Icon name="chev-right" size="sm" />
                        <Icon name="folder" size="sm" />
                        <span className="n">{folder.name}</span>
                        <span className="vh">
                          , folder, {counted(size, 'view')}
                          {holdsOpenView ? ', has the open view' : ''}
                        </span>
                        {holdsOpenView && (
                          <span className="chk" aria-hidden="true">
                            <Icon name="check" size="sm" />
                          </span>
                        )}
                      </button>
                      {props.editable && (
                        <button
                          type="button"
                          className="vf-rename"
                          aria-label={`Rename folder ${folder.name}`}
                          title="Rename the folder"
                          onClick={() => {
                            rename(folder);
                          }}
                        >
                          <Icon name="pencil" size="sm" />
                        </button>
                      )}
                      <span className="vf-count" aria-hidden="true">
                        {size}
                      </span>
                    </div>
                    {open && (
                      <ul id={listId} aria-label={folder.name}>
                        {folder.views.map((view) => (
                          <li key={view.id}>{row(view)}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
              {shown.loose.map((view, index) => (
                <li
                  key={view.id}
                  className={
                    looseLit
                      ? `is-drop-loose${index === 0 ? ' first' : ''}${index === shown.loose.length - 1 ? ' last' : ''}`
                      : undefined
                  }
                  {...(props.editable ? { 'data-drop': 'none' } : {})}
                >
                  {row(view)}
                </li>
              ))}
              {showNoFolderRow && (
                <li
                  className={`vf-target vf-none${looseLit ? ' is-drop' : ''}`}
                  data-drop="none"
                  aria-hidden="true"
                >
                  No folder
                </li>
              )}
            </ul>
          )}
          {props.editable && (
            <div
              className={`vf-target vf-new${lit === 'new' ? ' is-drop' : ''}`}
              data-drop="new"
              aria-hidden="true"
              title="Drag a view here to put it in a new folder"
            >
              <Icon name="folder-plus" size="sm" />
              New folder…
            </div>
          )}
          {filtered && (
            <p className="vh" role="status">
              {counted(shownCount, 'view')}
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
      {drag !== null &&
        createPortal(
          <div
            className="vf-chip"
            style={{ left: drag.x + 12, top: drag.y + 8 }}
            aria-hidden="true"
          >
            {drag.view.name || '(unnamed)'}
          </div>,
          document.body,
        )}
      {newFolderFor !== null && (
        <NewFolderDialog
          modelId={props.modelId}
          view={newFolderFor}
          folders={groups.folders}
          onCancel={() => {
            setNewFolderFor(null);
            setFocusOn({ view: newFolderFor.id });
          }}
          onMade={(saved) => {
            setNewFolderFor(null);
            settled([saved]);
            if (saved.folder !== null) {
              setFocusOn({ folder: viewFolderKey(saved.folder) });
              props.onAnnounce(
                `Made the folder “${saved.folder}” with “${newFolderFor.name.trim()}”.`,
              );
            }
          }}
          onGone={reread}
        />
      )}
      {renaming !== null && (
        <RenameFolderDialog
          modelId={props.modelId}
          folder={renaming}
          folders={groups.folders}
          onCancel={() => {
            setRenaming(null);
            setFocusOn({ folder: renaming.key });
          }}
          onRenamed={(folder, saved) => {
            closed.carry(renaming.name, folder);
            setRenaming(null);
            settled(saved);
            setFocusOn({ folder: viewFolderKey(folder) });
            props.onAnnounce(
              `Renamed the folder to “${folder}” on ${counted(saved.length, 'view')}.`,
            );
          }}
          onGone={reread}
        />
      )}
    </div>
  );
}

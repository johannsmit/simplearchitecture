import {
  buildModelGraph,
  type CatalogTab,
  canRemoveFromCanvas,
  containerOf,
  degree,
  findElements,
  maxDepth,
  mostConnected,
  neighbourhood,
  withAddedElements,
  withContainers,
  withoutElements,
  type DeletedRelationshipResult,
  relationshipOfEdge,
  relationshipViewFields,
  type ElementChangeResult,
  type JgfDocument,
  type NestingChange,
  type NodeType,
  type RelationshipChangeResult,
} from '@simplearchitecture/shared';
import { ReactFlowProvider } from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiRequestError, getElement, getModel } from '../api';
import { useMe } from '../auth';
import { UnsavedDialog } from '../modelling/dialogs';
import { withEdge, withNode, withoutEdge, withoutElement } from '../modelling/document';
import { RelationshipEditor } from '../modelling/RelationshipEditor';
import { AddRelationshipBox, relationshipSentence } from '../modelling/relationships';
import { ElementEditor, type EditorHandle, type EditorState } from '../modelling/ElementEditor';
import { NewElement } from '../modelling/NewElement';
import { ErrorBoundary } from '../ErrorBoundary';
import { Icon } from '../icons';
import { TypeMark } from '../metamodel-ui';
import { useModels } from '../models';
import { counted } from '../words';
import { ExplorerCanvas } from './explorer/canvas/ExplorerCanvas';
import {
  hasMovedCards,
  noMovedPositions,
  withMovedCard,
  type MovedPositions,
  type Point,
} from './explorer/canvas/positions';
import { DetailsPanel, type RelationshipTools } from './explorer/DetailsPanel';
import { ElementTree } from './explorer/ElementTree';
import { RelationshipDetails } from './explorer/RelationshipDetails';
import {
  dropOldViewpoint,
  panels,
  parseDepth,
  readDepth,
  readPanelOpen,
  readPanelWidth,
  readNestContained,
  writeDepth,
  writePanelOpen,
  writePanelWidth,
  writeNestContained,
  type PanelName,
} from './explorer/prefs';
import { Catalog, catalogTabOnEntry } from './explorer/catalog/Catalog';
import { ResizeHandle } from './explorer/ResizeHandle';
import { useElementSearch } from './explorer/search';
import {
  elementPath,
  explorerSearch,
  modelPath,
  readExplorerView,
  spaceHome,
  readShownProperties,
  shownPropertiesSearch,
  withoutOldViewpoint,
  type ExplorerSpace,
  type ExplorerView,
} from './paths';

/** A stable empty list, so memos don't see a new one on every render. */
const noIds: readonly string[] = [];

/** The most elements the breadcrumb trail keeps; the oldest drops off. */
export const trailLength = 5;
const suggestions = 5;

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/**
 * Reads `/viewing|modelling/models/:modelId[/elements/:elementId]` from the raw (still encoded)
 * path, so element ids may hold any character, including "/".
 */
export function parseExplorerPath(
  pathname: string,
): { space: ExplorerSpace; modelId: string; elementId: string | undefined } | undefined {
  const match = /^\/(viewing|modelling)\/models\/([^/]+)(?:\/elements\/([^/]+))?\/?$/.exec(
    pathname,
  );
  const modelId = match?.[2] === undefined ? undefined : decode(match[2]);
  if (modelId === undefined) return undefined;
  const space: ExplorerSpace = match?.[1] === 'modelling' ? 'modelling' : 'viewing';
  const element = match?.[3];
  // An element segment that can't be decoded can't be in the model: show "not in this model".
  return {
    space,
    modelId,
    elementId: element === undefined ? undefined : (decode(element) ?? element),
  };
}

/** Shown when a model arrives but can't be read: never the browser's own error text. */
export const unreadableModelMessage =
  "The model's data isn't in a form the explorer can read. It may be damaged.";

type Load =
  | { status: 'loading' }
  | { status: 'ready'; document: JgfDocument }
  | { status: 'missing' }
  | { status: 'failed'; message: string };

/** The model, its retry, and an update for changes the server accepted (Modelling). */
function useModelDocument(
  modelId: string,
): [Load, () => void, (change: (document: JgfDocument) => JgfDocument) => void] {
  const [load, setLoad] = useState<{ modelId: string; value: Load }>({
    modelId,
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    getModel(modelId, controller.signal)
      .then((document) => {
        setLoad({ modelId, value: { status: 'ready', document } });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // The API's messages are written for people; anything else (a model the client can't
        // read) gets a plain message, and the details go to the console only.
        if (!(error instanceof ApiRequestError)) console.error(error);
        const status = error instanceof ApiRequestError ? error.status : 0;
        setLoad({
          modelId,
          value:
            status === 404 || status === 400
              ? { status: 'missing' }
              : {
                  status: 'failed',
                  message:
                    error instanceof ApiRequestError ? error.message : unreadableModelMessage,
                },
        });
      });
    return () => {
      controller.abort();
    };
  }, [modelId, attempt]);

  const retry = useCallback(() => {
    setLoad({ modelId, value: { status: 'loading' } });
    setAttempt((n) => n + 1);
  }, [modelId]);
  const update = useCallback((change: (document: JgfDocument) => JgfDocument) => {
    setLoad((current) =>
      current.value.status === 'ready'
        ? { ...current, value: { status: 'ready', document: change(current.value.document) } }
        : current,
    );
  }, []);
  return [load.modelId === modelId ? load.value : { status: 'loading' }, retry, update];
}

/**
 * The trail after focusing an element: back to it when it is in the trail already (a crumb click
 * or Back), otherwise added at the end, keeping the last `trailLength` elements.
 */
export function nextTrail(trail: readonly string[], elementId: string): string[] {
  const at = trail.lastIndexOf(elementId);
  return at >= 0 ? trail.slice(0, at + 1) : [...trail, elementId].slice(-trailLength);
}

/** The last elements focused in this tab, per model (reset when the model changes). */
function useTrail(modelId: string, elementId: string | undefined): string[] {
  const [trail, setTrail] = useState<{ modelId: string; elementId?: string; ids: string[] }>({
    modelId,
    ...(elementId === undefined ? {} : { elementId }),
    ids: elementId === undefined ? [] : [elementId],
  });
  // Updated while rendering (not in an effect), so the trail never lags the URL.
  if (trail.modelId !== modelId || trail.elementId !== elementId) {
    let ids: string[];
    if (trail.modelId !== modelId) ids = elementId === undefined ? [] : [elementId];
    else if (elementId === undefined) ids = trail.ids;
    else ids = nextTrail(trail.ids, elementId);
    setTrail({ modelId, ...(elementId === undefined ? {} : { elementId }), ids });
    return ids;
  }
  return trail.ids;
}

function usePanel(panel: PanelName) {
  const [open, setOpen] = useState(() => readPanelOpen(panel));
  const [width, setWidth] = useState(() => readPanelWidth(panel));
  return {
    open,
    width,
    toggle: () => {
      setOpen(!open);
      writePanelOpen(panel, !open);
    },
    resize: (next: number, done: boolean) => {
      setWidth(next);
      if (done) writePanelWidth(panel, next);
    },
    reset: () => {
      setWidth(panels[panel].fallback);
      writePanelWidth(panel, null);
    },
  };
}

/**
 * The explorer for one stored model: element tree, canvas and details. Read-only in Viewing; in
 * Modelling (with a database) the details panel is the editing form.
 */
export function ExplorerPage() {
  const { pathname, search } = useLocation();
  const parsed = parseExplorerPath(pathname);
  const home = pathname.startsWith('/modelling') ? spaceHome('modelling') : spaceHome('viewing');
  if (!parsed) {
    return (
      <ExplorerMessage
        title="This model doesn't exist."
        text="Check the address, or choose a model from the list."
        action={
          <Link className="btn primary" to={home}>
            Go to models
          </Link>
        }
      />
    );
  }
  return (
    // A model the explorer can't show must never blank the app: the header stays.
    <ErrorBoundary
      resetKey={`${pathname}${search}`}
      title="This model couldn't be shown."
      backTo={home}
      backLabel="Back to models"
    >
      <UnsavedGuard space={parsed.space} modelId={parsed.modelId} elementId={parsed.elementId} />
    </ErrorBoundary>
  );
}

/** Asks before unsaved changes are dropped; runs `proceed` when they may be. */
type Ask = (proceed: () => void, keep?: () => void) => void;

interface Shown {
  modelId: string;
  elementId: string | undefined;
  url: string;
  view: ExplorerView;
}

/**
 * Holds unsaved changes in the editing form. The explorer shows the
 * element the guard lets through: when the address moves on (a card, a crumb, browser Back)
 * while the form has changes, the explorer stays where it is and asks first; Keep editing puts
 * the address back. Links out of the explorer and closing the tab ask too.
 */
function UnsavedGuard(props: {
  space: ExplorerSpace;
  modelId: string;
  elementId: string | undefined;
}) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const url = `${pathname}${search}`;
  const view = readExplorerView(new URLSearchParams(search)).view;
  const [shown, setShown] = useState<Shown>({
    modelId: props.modelId,
    elementId: props.elementId,
    url,
    view,
  });
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const dirty = editorState?.dirty === true;
  // Read by `ask` at once, so a click replayed right after a catalog cell saved isn't asked
  // about changes that are already saved.
  const dirtyNow = useRef(false);
  const reportState = useCallback((state: EditorState | null) => {
    dirtyNow.current = state?.dirty === true;
    setEditorState(state);
  }, []);
  const setClean = () => {
    dirtyNow.current = false;
    setEditorState((current) => current && { ...current, dirty: false });
  };
  const [dialog, setDialog] = useState<{ proceed: () => void; keep?: () => void } | null>(null);
  const [saving, setSaving] = useState(false);
  const editor = useRef<EditorHandle | null>(null);

  const ask = useCallback<Ask>((proceed, keep) => {
    if (dirtyNow.current) setDialog({ proceed, ...(keep ? { keep } : {}) });
    else proceed();
  }, []);

  // The address the user chose to stay away from (Keep editing), until the address is put back.
  const [held, setHeld] = useState<string | null>(null);
  if (held !== null && url !== held) setHeld(null);

  // The address moved: follow it, or (with changes) hold it and ask. Adjusted while rendering.
  if (shown.url !== url && dialog === null && url !== held) {
    // An open catalog cell is dropped by a view change too; the details form stays with it.
    const moved =
      shown.modelId !== props.modelId ||
      shown.elementId !== props.elementId ||
      (editorState?.cell === true && shown.view !== view);
    const next = { modelId: props.modelId, elementId: props.elementId, url, view };
    if (!moved || !dirty) setShown(next);
    else {
      setDialog({
        proceed: () => {
          setShown(next);
        },
        keep: () => {
          setHeld(url);
          void navigate(shown.url, { replace: true });
        },
      });
    }
  }

  // Links out of the explorer (space switcher, model picker, any page) while there are changes.
  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest('a[href]');
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.download) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin) return;
      const path = `${target.pathname}${target.search}`;
      if (path === `${window.location.pathname}${window.location.search}`) return;
      event.preventDefault();
      event.stopPropagation();
      setDialog({
        proceed: () => {
          void navigate(path);
        },
      });
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty, navigate]);

  const close = () => {
    setDialog(null);
  };

  return (
    <>
      <Explorer
        url={shown.url}
        space={props.space}
        modelId={shown.modelId}
        elementId={shown.elementId}
        ask={ask}
        editor={editor}
        onEditorState={reportState}
      />
      {dialog && (
        <UnsavedDialog
          kind="leave"
          name={editorState?.name ?? ''}
          subject={editorState?.subject ?? 'element'}
          saving={saving}
          canSave={editorState?.canSave ?? false}
          onKeep={() => {
            close();
            dialog.keep?.();
          }}
          onDiscard={() => {
            editor.current?.discard();
            setClean();
            close();
            dialog.proceed();
          }}
          onSave={() => {
            setSaving(true);
            void (editor.current?.save() ?? Promise.resolve(true)).then((ok) => {
              setSaving(false);
              close();
              if (ok) {
                setClean();
                dialog.proceed();
              } else {
                dialog.keep?.();
              }
            });
          }}
        />
      )}
    </>
  );
}

function ExplorerMessage(props: { title: string; text: string; action: ReactNode }) {
  return (
    <main id="canvas" tabIndex={-1} className="page-scroll">
      <div className="empty explorer-message">
        <Icon name="layers" />
        <h1>{props.title}</h1>
        <p>{props.text}</p>
        {props.action}
      </div>
    </main>
  );
}

interface ExplorerProps {
  url: string;
  space: ExplorerSpace;
  modelId: string;
  elementId: string | undefined;
  ask: Ask;
  editor: RefObject<EditorHandle | null>;
  onEditorState: (state: EditorState | null) => void;
}

function Explorer({ url, space, modelId, elementId, ask, editor, onEditorState }: ExplorerProps) {
  // Two places can hold unsaved changes: the details panel's form and an open catalog cell. The
  // guard sees the cell while it has changes, else the form.
  // Passed on at once (not in an effect), so the guard never asks about changes just saved.
  const panelEditor = useRef<EditorHandle | null>(null);
  const cellEditor = useRef<EditorHandle | null>(null);
  const panelStateNow = useRef<EditorState | null>(null);
  const cellStateNow = useRef<EditorState | null>(null);
  const cellActive = () => cellStateNow.current?.dirty === true;
  const setPanelState = useCallback(
    (state: EditorState | null) => {
      panelStateNow.current = state;
      onEditorState(cellStateNow.current?.dirty === true ? cellStateNow.current : state);
    },
    [onEditorState],
  );
  const setCellState = useCallback(
    (state: EditorState | null) => {
      cellStateNow.current = state;
      onEditorState(state?.dirty === true ? state : panelStateNow.current);
    },
    [onEditorState],
  );
  useImperativeHandle(editor, () => {
    const active = () => (cellActive() ? cellEditor : panelEditor).current;
    const state = () => (cellActive() ? cellStateNow : panelStateNow).current;
    return {
      save: () => active()?.save() ?? Promise.resolve(true),
      discard: () => {
        active()?.discard();
      },
      get name() {
        return state()?.name ?? '';
      },
      get canSave() {
        return state()?.canSave ?? false;
      },
    };
  }, []);
  const navigate = useNavigate();
  const location = useLocation();
  const me = useMe();
  // The address the guard lets through (it stays while the unsaved changes dialog asks).
  const [shownPath = '', shownSearch = ''] = url.split('?');
  const params = useMemo(() => new URLSearchParams(shownSearch), [shownSearch]);
  const [load, retry, updateDocument] = useModelDocument(modelId);
  const { list, editable: canEdit, reload: reloadModels } = useModels();
  const editable = space === 'modelling' && canEdit === true;
  const readOnlyModelling = space === 'modelling' && canEdit === false;
  const home = spaceHome(space);
  const allTrail = useTrail(modelId, elementId);
  const tree = usePanel('tree');
  const details = usePanel('details');
  const [rememberedDepth, setRememberedDepth] = useState(readDepth);
  const depth = parseDepth(params.get('depth')) ?? rememberedDepth;
  // An address or a preference from an older version: its fixed viewpoint is read once and goes.
  useEffect(dropOldViewpoint, []);
  useEffect(() => {
    const search = withoutOldViewpoint(params);
    if (search !== undefined) void navigate(`${shownPath}${search}`, { replace: true });
  }, [navigate, params, shownPath]);
  // The relationship properties the lines show. Only the address holds them.
  const shownAsked = useMemo(() => readShownProperties(params), [params]);
  const [nest, setNest] = useState(readNestContained);
  // The canvas or the catalog (in the address), and the search and filters they share
  // with the element list.
  const { view, tab } = readExplorerView(params);
  const search = useElementSearch(modelId);
  /** The address with this view (and tab): a new history entry, or in place for a tab change. */
  const viewUrl = (next: ExplorerView, nextTab: CatalogTab = tab) =>
    `${shownPath}${explorerSearch(params, next, nextTab)}`;
  const setTab = (next: CatalogTab) => {
    void navigate(viewUrl('catalog', next), { replace: true });
  };

  const summaryName =
    list.status === 'ready' ? list.models.find((m) => m.id === modelId)?.name : undefined;
  const document_ = load.status === 'ready' ? load.document : undefined;
  const graph = useMemo(() => (document_ ? buildModelGraph(document_) : undefined), [document_]);
  const lineFields = useMemo(() => (graph ? relationshipViewFields(graph) : []), [graph]);
  // What the address asks for and this model has, in the list's order: others are ignored.
  const shownProperties = useMemo(
    () => lineFields.map(({ key }) => key).filter((key) => shownAsked.includes(key)),
    [lineFields, shownAsked],
  );
  const element = graph && elementId !== undefined ? graph.elements.get(elementId) : undefined;
  const matches = useMemo(
    () => (graph ? findElements(graph, { query: search.query, filters: search.filters }) : []),
    [graph, search.query, search.filters],
  );
  // A deleted element leaves the trail's names (it is no longer in the model).
  const trail = graph ? allTrail.filter((id) => graph.elements.has(id)) : allTrail;

  // Elements added from a card's related elements. Kept here, not in the URL, and dropped when
  // the focused element changes. They stay on a depth change: the depth decides how far down
  // their contents reach.
  const addedKey = elementId ?? '';
  const [added, setAdded] = useState<{ key: string; ids: string[] }>({ key: addedKey, ids: [] });
  // Forget them as soon as the focus changes (even if it later changes back).
  if (added.key !== addedKey) setAdded({ key: addedKey, ids: [] });
  const addedIds = added.key === addedKey ? added.ids : noIds;
  // Cards taken off the canvas: visual only, never saved. Like the added ones, they are forgotten
  // when the focus changes, and stay off through a depth change or Tidy up.
  const [removed, setRemoved] = useState<{ key: string; ids: string[] }>({
    key: addedKey,
    ids: [],
  });
  if (removed.key !== addedKey) setRemoved({ key: addedKey, ids: [] });
  const removedIds = removed.key === addedKey ? removed.ids : noIds;
  const addElement = useCallback(
    (id: string) => {
      setAdded((current) => ({
        key: addedKey,
        ids: [...(current.key === addedKey ? current.ids : []), id],
      }));
      // Back on the canvas, with the containers it is drawn inside.
      setRemoved((current) => {
        if (current.key !== addedKey || current.ids.length === 0) return current;
        const back = new Set([id]);
        if (graph) {
          for (let up = containerOf(graph, id); up !== undefined && !back.has(up);) {
            back.add(up);
            up = containerOf(graph, up);
          }
        }
        return { key: addedKey, ids: current.ids.filter((removedId) => !back.has(removedId)) };
      });
    },
    [addedKey, graph],
  );

  // Cards moved on the canvas: visual only (never in the model or the URL), and dropped on a focus
  // or depth change, or by Tidy up.
  const movedKey = `${elementId ?? ''}|${depth}`;
  const [moved, setMoved] = useState<{ key: string; positions: MovedPositions }>({
    key: movedKey,
    positions: noMovedPositions,
  });
  if (moved.key !== movedKey) setMoved({ key: movedKey, positions: noMovedPositions });
  const movedPositions = moved.key === movedKey ? moved.positions : noMovedPositions;
  const moveCard = useCallback(
    (id: string, position: Point | undefined) => {
      setMoved((current) => ({
        key: movedKey,
        positions: withMovedCard(
          current.key === movedKey ? current.positions : noMovedPositions,
          id,
          position,
        ),
      }));
    },
    [movedKey],
  );
  const [tidyCount, setTidyCount] = useState(0);

  const hood = useMemo(() => {
    if (!graph || !element) return undefined;
    const shown = withAddedElements(graph, neighbourhood(graph, element.id, { depth }), addedIds, {
      depth,
    });
    // A nested element's containers are always brought onto the canvas, so nesting shows; they
    // count towards the cap.
    return withoutElements(graph, nest ? withContainers(graph, shown) : shown, removedIds, {
      nest,
    });
  }, [graph, element, depth, addedIds, removedIds, nest]);

  // "Nest contained elements" lays the canvas out again, like Tidy up.
  const toggleNest = useCallback(() => {
    setNest((current) => {
      writeNestContained(!current);
      return !current;
    });
    setMoved({ key: movedKey, positions: noMovedPositions });
  }, [movedKey]);

  const focusElement = useCallback(
    (id: string) => {
      void navigate(elementPath(modelId, id, depth, space, shownAsked));
    },
    [navigate, modelId, depth, space, shownAsked],
  );

  const setDepth = useCallback(
    (next: number) => {
      if (next < 1 || next > maxDepth) return;
      setRememberedDepth(next);
      writeDepth(next);
      if (elementId !== undefined) {
        void navigate(elementPath(modelId, elementId, next, space, shownAsked), {
          replace: true,
        });
      }
    },
    [navigate, modelId, elementId, space, shownAsked],
  );

  // After following a relationship in the details panel, focus goes to the new element's name.
  const [headingFocusFor, setHeadingFocusFor] = useState<string | null>(null);
  const clearHeadingFocus = useCallback(() => {
    setHeadingFocusFor(null);
  }, []);

  // The selected element (single click), shown in the details panel, apart from the
  // focus element (double click: the canvas, the breadcrumbs and the URL). It is the focus element
  // until another is picked, and goes back to it when the focus changes.
  const selectionKey = elementId ?? '';
  const [picked, setPicked] = useState<{ key: string; id: string } | null>(null);
  const pickedId =
    picked !== null && picked.key === selectionKey && graph?.elements.has(picked.id) === true
      ? picked.id
      : undefined;
  const selectedId = pickedId ?? elementId;
  const selected = graph && selectedId !== undefined ? graph.elements.get(selectedId) : undefined;

  // Modelling: the selected element's version, read from the server for the next save or delete.
  const [stored, setStored] = useState<{ id: string; version: number } | null>(null);
  const version = stored !== null && stored.id === selectedId ? stored.version : undefined;
  const [nameFocusFor, setNameFocusFor] = useState<string | null>(null);
  const clearNameFocus = useCallback(() => {
    setNameFocusFor(null);
  }, []);
  const [announcement, setAnnouncement] = useState('');
  const selectedKnown = selected !== undefined;
  useEffect(() => {
    if (!editable || selectedId === undefined || !selectedKnown) return;
    const controller = new AbortController();
    getElement(modelId, selectedId, controller.signal)
      .then((result) => {
        setStored({ id: result.element.id, version: result.element.version });
        // The server's copy wins (it may be newer); an open form with changes keeps them.
        updateDocument((current) => withNode(current, result.element.id, result.element.node));
      })
      .catch(() => {
        // The form reads it again when it saves, and reports what went wrong there.
      });
    return () => {
      controller.abort();
    };
  }, [editable, modelId, selectedId, selectedKnown, updateDocument]);

  const onStored = useCallback(
    (result: ElementChangeResult) => {
      setStored({ id: result.element.id, version: result.element.version });
      updateDocument((current) => withNode(current, result.element.id, result.element.node));
    },
    [updateDocument],
  );

  /** A catalog cell found the element deleted by someone else: it leaves the model. */
  const onGone = (id: string) => {
    updateDocument((current) => withoutElement(current, id));
    reloadModels();
    setPicked(null);
    if (id === elementId) {
      void navigate(`${modelPath(modelId, space)}${explorerSearch(params, 'catalog', tab)}`);
    }
  };

  const onCreated = (result: ElementChangeResult) => {
    onStored(result);
    reloadModels();
    setNameFocusFor(result.element.id);
    const name = result.element.node.label ?? '';
    setAnnouncement(`Created “${name}”. Add details, then Save.`);
    // The catalog stays and selects the new row (it moves to its type's tab itself).
    if (view === 'catalog') setPicked({ key: selectionKey, id: result.element.id });
    else void navigate(elementPath(modelId, result.element.id, depth, space, shownAsked));
  };

  const onRemoved = (id: string) => {
    setPanelState(null);
    updateDocument((current) => withoutElement(current, id));
    reloadModels();
    setPicked(null);
    // The catalog stays; it selects the next row itself.
    if (view === 'catalog') {
      if (id === elementId)
        void navigate(`${modelPath(modelId, space)}${explorerSearch(params, 'catalog', tab)}`);
      return;
    }
    // A selected element that wasn't the focus: the panel goes back to the focus element.
    if (id !== elementId && elementId !== undefined) {
      setHeadingFocusFor(elementId);
      return;
    }
    // Back to the previous element in the trail.
    const previous = trail.filter((other) => other !== id).at(-1);
    if (previous !== undefined) {
      setHeadingFocusFor(previous);
      void navigate(elementPath(modelId, previous, depth, space, shownAsked));
    } else {
      void navigate(`${modelPath(modelId, space)}${explorerSearch(params, 'canvas')}`);
      requestAnimationFrame(() => {
        const row = window.document.querySelector<HTMLElement>(
          '.tree-panel [role="treeitem"][tabindex="0"], .tree-panel .new-btn',
        );
        row?.focus();
      });
    }
  };

  // The relationship open in the details panel (dropped when the focus changes), the
  // one just added (lit for 3s), the Add relationship box, and "+ Element" requests.
  const [selection, setSelection] = useState<{ key: string; id: string } | null>(null);
  const selectedRelationshipId =
    selection !== null && selection.key === selectionKey ? selection.id : undefined;
  const selectedRelationship =
    graph && selectedRelationshipId !== undefined
      ? graph.relationships.find((r) => r.id === selectedRelationshipId)
      : undefined;
  const [relHeadingFocus, setRelHeadingFocus] = useState(false);
  const clearRelHeadingFocus = useCallback(() => {
    setRelHeadingFocus(false);
  }, []);
  const [litId, setLitId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (litId === undefined) return;
    const timer = setTimeout(() => {
      setLitId(undefined);
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  }, [litId]);
  const [addBoxFor, setAddBoxFor] = useState<string | null>(null);
  const addBoxOpen = addBoxFor !== null && addBoxFor === selectedId;
  const [newElementRequest, setNewElementRequest] = useState(0);
  const onCanvas = useMemo(() => new Set(hood?.hops.keys() ?? []), [hood]);

  const openRelationship = (id: string) => {
    ask(() => {
      setSelection({ key: selectionKey, id });
      setRelHeadingFocus(true);
      if (!details.open) details.toggle();
    });
  };
  const deselect = () => {
    if (selectedRelationshipId === undefined) return;
    ask(() => {
      setSelection(null);
      if (selectedId !== undefined) setHeadingFocusFor(selectedId);
    });
  };
  /** A single click on a card or list row: the details panel shows it; the canvas stays. */
  const selectElement = (id: string, then?: () => void) => {
    if (id === selectedId && selectedRelationshipId === undefined) {
      if (then) ask(then);
      return;
    }
    ask(() => {
      setPicked({ key: selectionKey, id });
      setSelection(null);
      setAddBoxFor(null);
      then?.();
    });
  };
  /** The switch: entering the catalog opens the selected element's tab; the canvas, with no
   * focused element, focuses the selected one. */
  const showView = (next: ExplorerView) => {
    if (next === 'catalog') {
      void navigate(viewUrl('catalog', catalogTabOnEntry(modelId, selected?.type)));
    } else if (elementId === undefined && selectedId !== undefined) {
      void navigate(elementPath(modelId, selectedId, depth, space, shownAsked));
    } else {
      void navigate(viewUrl('canvas'));
    }
  };
  /** A link to an element in the details panel: back to it when selected, else it is focused. */
  const followElement = (id: string) => {
    if (id === selectedId) {
      deselect();
    } else if (id === elementId) {
      ask(() => {
        setPicked(null);
        setSelection(null);
        setHeadingFocusFor(id);
      });
    } else {
      setHeadingFocusFor(id);
      focusElement(id);
    }
  };

  // "Open in Modelling" on a relationship in Viewing: the relationship (and the element it was
  // opened from) come along in the history entry's state, not in the URL. Once per entry; adjusted
  // while rendering.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const opened = location.state as { relationship?: unknown; element?: unknown } | null;
  if (typeof opened?.relationship === 'string' && openedFor !== location.key) {
    setOpenedFor(location.key);
    if (typeof opened.element === 'string') setPicked({ key: selectionKey, id: opened.element });
    setSelection({ key: selectionKey, id: opened.relationship });
    setRelHeadingFocus(true);
  }
  /** A Contains change moved a nesting: the canvas tidies up. */
  const tidyAfter = (changes: readonly NestingChange[]): boolean => {
    if (changes.length === 0 || !nest) return false;
    setMoved({ key: movedKey, positions: noMovedPositions });
    setTidyCount((n) => n + 1);
    return true;
  };
  const tidied = (yes: boolean) => (yes ? ' The canvas was tidied up.' : '');
  const sentenceOf = (result: RelationshipChangeResult) => {
    const relationship = relationshipOfEdge(result.relationship.edge);
    return graph && relationship ? relationshipSentence(graph, relationship) : '';
  };
  const onRelationshipAdded = (result: RelationshipChangeResult) => {
    updateDocument((current) => withEdge(current, result.relationship.edge));
    setLitId(result.relationship.id);
    setAnnouncement(`Added: ${sentenceOf(result)}.${tidied(tidyAfter(result.nestingChanges))}`);
    reloadModels();
  };
  const onRelationshipStored = (result: RelationshipChangeResult, saved: boolean) => {
    updateDocument((current) => withEdge(current, result.relationship.edge));
    if (!saved) return;
    setAnnouncement(`Saved.${tidied(tidyAfter(result.nestingChanges))}`);
    reloadModels();
  };
  const onRelationshipRemoved = (
    id: string,
    result: DeletedRelationshipResult | undefined,
    words: string,
  ) => {
    setPanelState(null);
    updateDocument((current) => withoutEdge(current, id));
    const tidy = tidyAfter(result?.nestingChanges ?? []);
    setSelection(null);
    if (elementId !== undefined) setHeadingFocusFor(elementId);
    if (words !== '') setAnnouncement(`${words}${tidied(tidy)}`);
    reloadModels();
  };
  // New element's "Add to canvas": nothing is created; the focus stays the same.
  const [reveal, setReveal] = useState<{ id: string; n: number } | undefined>(undefined);
  // Also a row dropped on the canvas, or Shift+Enter on it.
  const bringElement = (id: string, position: Point | undefined) => {
    const name = graph?.elements.get(id)?.name || '(unnamed)';
    if (element === undefined) {
      focusElement(id);
      return;
    }
    if (onCanvas.has(id)) {
      selectElement(id);
      setReveal((current) => ({ id, n: (current?.n ?? 0) + 1 }));
      setAnnouncement(`${name} is on the canvas.`);
      return;
    }
    addElement(id);
    if (position) {
      // Its container chain comes along: the outermost new container takes the point,
      // so the element lands there. Inside a container already on the canvas, the layout places it.
      let top = id;
      let inside = false;
      if (nest && graph) {
        const seen = new Set([id]);
        for (let up = containerOf(graph, top); up !== undefined; up = containerOf(graph, up)) {
          if (onCanvas.has(up)) {
            inside = true;
            break;
          }
          if (seen.has(up)) break;
          seen.add(up);
          top = up;
        }
      }
      if (!inside) moveCard(top, position);
    }
    setAnnouncement(`Added “${name}” to the canvas.`);
  };

  const onCanvasElementCreated = (result: ElementChangeResult, position: Point) => {
    onStored(result);
    reloadModels();
    addElement(result.element.id);
    moveCard(result.element.id, position);
    setAnnouncement(`Created “${result.element.node.label ?? ''}”.`);
  };
  const addRelationshipFrom = (id: string) => {
    ask(() => {
      setSelection(null);
      // The element is selected (the canvas stays), not focused.
      setPicked({ key: selectionKey, id });
      setAddBoxFor(id);
      if (!details.open) details.toggle();
    });
  };

  // `N`: a new element at the centre of the view, like "+ Element" (Modelling with editing on,
  // not while typing, and not over an open dialog or popover).
  const canPlaceElement = editable && element !== undefined && view === 'canvas';
  useEffect(() => {
    if (!canPlaceElement) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'n' && event.key !== 'N') return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement &&
          (target.isContentEditable || target.closest('.rel-pop, .new-pop, .add-rel') !== null))
      ) {
        return;
      }
      if (window.document.querySelector('dialog[open]')) return;
      event.preventDefault();
      setNewElementRequest((n) => n + 1);
    };
    window.document.addEventListener('keydown', onKey);
    return () => {
      window.document.removeEventListener('keydown', onKey);
    };
  }, [canPlaceElement]);

  useEffect(() => {
    const name = element?.name || graph?.name || summaryName;
    document.title = name ? `${name} · SimpleArchitecture` : 'SimpleArchitecture';
    return () => {
      document.title = 'SimpleArchitecture';
    };
  }, [element, graph, summaryName]);

  if (load.status === 'missing') {
    return (
      <ExplorerMessage
        title="This model doesn't exist."
        text="It may have been deleted."
        action={
          <Link className="btn primary" to={home}>
            Go to models
          </Link>
        }
      />
    );
  }
  if (load.status === 'failed') {
    return (
      <ExplorerMessage
        title="The model couldn't be loaded."
        text={load.message}
        action={
          <button type="button" className="btn primary" onClick={retry}>
            Try again
          </button>
        }
      />
    );
  }
  const canTidy = hood !== undefined && hasMovedCards(movedPositions, hood.hops);
  const removable =
    graph !== undefined &&
    hood !== undefined &&
    selectedId !== undefined &&
    canRemoveFromCanvas(graph, hood, selectedId, { nest });
  // Takes the selected card off the canvas; the element stays in the model and the list.
  const removeFromCanvas = () => {
    if (!removable) return;
    const id = selectedId;
    const name = graph.elements.get(id)?.name || '(unnamed)';
    ask(() => {
      setRemoved((current) => ({
        key: addedKey,
        ids: [...(current.key === addedKey ? current.ids : []), id],
      }));
      setPicked(null);
      setSelection(null);
      setAddBoxFor(null);
      setAnnouncement(`Removed “${name}” from the canvas. It stays in the model.`);
      // The button is disabled now: keep keyboard focus on the canvas, never on <body>.
      document.getElementById('canvas')?.focus();
    });
  };
  const tidyUp = () => {
    setMoved({ key: movedKey, positions: noMovedPositions });
    setTidyCount((n) => n + 1);
    // The button is disabled now: keep keyboard focus on the canvas, never on <body>.
    document.getElementById('canvas')?.focus();
  };

  const relationshipTools = (focused: NonNullable<typeof element>): RelationshipTools => ({
    action: (
      <button
        type="button"
        className="linkbtn add-rel-btn"
        aria-expanded={addBoxOpen}
        aria-controls="add-rel-box"
        onClick={() => {
          setAddBoxFor(addBoxOpen ? null : focused.id);
        }}
      >
        <Icon name="plus" size="sm" />
        Add relationship
      </button>
    ),
    box:
      addBoxOpen && graph ? (
        <div id="add-rel-box">
          <AddRelationshipBox
            modelId={modelId}
            graph={graph}
            element={focused}
            onCanvas={onCanvas}
            nest={nest}
            onAdded={onRelationshipAdded}
            onClose={() => {
              setAddBoxFor(null);
              requestAnimationFrame(() => {
                window.document.querySelector<HTMLElement>('.add-rel-btn')?.focus();
              });
            }}
            onShow={openRelationship}
          />
        </div>
      ) : null,
    onOpen: openRelationship,
    ...(litId === undefined ? {} : { highlightId: litId }),
  });

  /** The pointer's way from a catalog row to the canvas. */
  const showOnCanvas = (id: string): ReactNode =>
    view === 'catalog' ? (
      <button
        type="button"
        className="btn"
        onClick={() => {
          focusElement(id);
        }}
      >
        Show on canvas
      </button>
    ) : null;

  const detailsVisible = details.open && selected !== undefined;
  const style = {
    '--tree-w': `${tree.width}px`,
    '--details-w': `${details.width}px`,
  } as CSSProperties;
  const fitKey = `${tree.open}-${detailsVisible}-${tree.width}-${details.width}`;

  const defaultType: NodeType | undefined = element?.type;
  const treeTop = editable ? (
    <NewElement
      modelId={modelId}
      graph={graph ?? buildModelGraph({ graph: {} })}
      defaultType={defaultType}
      onOpenRequest={(open) => {
        ask(open);
      }}
      onCreated={onCreated}
      onExisting={(existing) => {
        if (view === 'catalog') selectElement(existing.id);
        else bringElement(existing.id, undefined);
      }}
      isOnCanvas={(id) => onCanvas.has(id)}
      {...(view === 'catalog' ? { existingLabel: 'Show in catalog' } : {})}
    />
  ) : readOnlyModelling ? (
    <p className="editing-off">Editing is off: it needs a database.</p>
  ) : undefined;

  return (
    <div
      className="explorer"
      style={style}
      {...(space === 'modelling'
        ? {
            role: 'region',
            'aria-label': editable ? 'Explorer, editing' : 'Explorer, read-only',
          }
        : {})}
    >
      <p className="vh" role="status">
        {announcement}
      </p>
      {tree.open && (
        <>
          <aside className="tree-panel" aria-label="Elements">
            {graph ? (
              <ElementTree
                key={modelId}
                modelId={modelId}
                graph={graph}
                selectedId={selectedId}
                onFocusElement={focusElement}
                onSelectElement={selectElement}
                onAddToCanvas={(id) => {
                  bringElement(id, undefined);
                }}
                search={search}
                searchElsewhere={view === 'catalog'}
                top={treeTop}
                emptyText={
                  editable
                    ? 'No elements yet. Add the first one with New element.'
                    : 'No elements yet.'
                }
              />
            ) : (
              <>
                <div className="search">
                  <Icon name="search" />
                  <input
                    type="search"
                    aria-label="Search elements"
                    placeholder="Search elements…"
                    disabled
                  />
                </div>
                <ul className="tree-skeleton" aria-hidden="true">
                  {Array.from({ length: 8 }, (_, index) => (
                    <li key={index}>
                      <span
                        className="skeleton"
                        style={{ width: `${55 + ((index * 17) % 40)}%` }}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </aside>
        </>
      )}

      <main className="main">
        <h1 className="vh">{graph?.name || summaryName || 'Model'}</h1>
        {/* The resize handles sit on the main area's edges, inside its landmark. */}
        {tree.open && (
          <ResizeHandle
            panel="tree"
            width={tree.width}
            onWidth={tree.resize}
            onReset={tree.reset}
          />
        )}
        {detailsVisible && (
          <ResizeHandle
            panel="details"
            width={details.width}
            onWidth={details.resize}
            onReset={details.reset}
          />
        )}
        <div className="toolbar">
          {/* Modelling is editing mode: only Read-only gets a pill. */}
          {readOnlyModelling && (
            <span className="mode-pill is-readonly">
              <Icon name="lock" size="sm" />
              Read-only
            </span>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-pressed={tree.open}
            aria-label={tree.open ? 'Hide the element list' : 'Show the element list'}
            title={tree.open ? 'Hide the element list' : 'Show the element list'}
            onClick={tree.toggle}
          >
            <Icon name="panel-left" />
          </button>
          <div className="segmented view-switch" role="group" aria-label="View">
            {(['canvas', 'catalog'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={value === view}
                onClick={() => {
                  if (value !== view) showView(value);
                }}
              >
                {value === 'canvas' ? 'Canvas' : 'Catalog'}
              </button>
            ))}
          </div>
          {view === 'catalog' ? (
            <span className="toolbar-gap" />
          ) : (
            <>
              <button
                type="button"
                className="icon-btn"
                aria-label="Back"
                title="Back"
                disabled={trail.length <= 1}
                onClick={() => {
                  void navigate(-1);
                }}
              >
                <Icon name="back" />
              </button>
              <nav className="crumbs" aria-label="Visited elements">
                <ol>
                  {trail.map((id, index) => {
                    const name = graph?.elements.get(id)?.name || '(unnamed)';
                    return index === trail.length - 1 ? (
                      <li key={`${id}-${index}`}>
                        <span aria-current="page">{name}</span>
                      </li>
                    ) : (
                      <li key={`${id}-${index}`}>
                        <Link to={elementPath(modelId, id, depth, space, shownAsked)}>{name}</Link>
                      </li>
                    );
                  })}
                </ol>
              </nav>
            </>
          )}
          {view === 'canvas' && editable && element !== undefined && (
            <button
              id="canvas-new-element"
              type="button"
              className="btn tidy"
              aria-label="New element on the canvas"
              aria-keyshortcuts="N"
              title="Add an element on the canvas (N, or double-click the canvas)"
              onClick={() => {
                setNewElementRequest((n) => n + 1);
              }}
            >
              <Icon name="plus" />
              <span className="tidy-label">Element</span>
            </button>
          )}
          {view === 'canvas' && element !== undefined && (
            <button
              type="button"
              className="btn tidy"
              aria-label="Remove from canvas"
              title="Take the selected card off the canvas. The element stays in the model."
              disabled={!removable}
              onClick={removeFromCanvas}
            >
              <Icon name="minus" />
              <span className="tidy-label">Remove</span>
            </button>
          )}
          {view === 'canvas' && (
            <button
              type="button"
              className="btn tidy"
              aria-label="Tidy up"
              title="Put every card back in the automatic layout"
              disabled={!canTidy}
              onClick={tidyUp}
            >
              <Icon name="wand-sparkles" />
              <span className="tidy-label">Tidy up</span>
            </button>
          )}
          {view === 'canvas' && (
            <div className="segmented" role="group" aria-label="Relationship depth">
              <span className="seg-label" aria-hidden="true">
                Depth
              </span>
              {Array.from({ length: maxDepth }, (_, index) => index + 1).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={value === depth}
                  title={`Show elements up to ${counted(value, 'relationship')} away`}
                  onClick={() => {
                    setDepth(value);
                  }}
                >
                  {value}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="icon-btn"
            aria-pressed={details.open}
            aria-label={details.open ? 'Hide the details' : 'Show the details'}
            title={details.open ? 'Hide the details' : 'Show the details'}
            onClick={details.toggle}
          >
            <Icon name="panel-right" />
          </button>
          {space === 'viewing' && me.spaces.includes('modelling') && (
            <Link
              className="btn open-modelling"
              aria-label="Open in Modelling"
              title="Open in Modelling"
              to={
                view === 'catalog'
                  ? `${
                      elementId !== undefined
                        ? elementPath(modelId, elementId, undefined, 'modelling')
                        : modelPath(modelId, 'modelling')
                    }${explorerSearch(params, 'catalog', tab)}`
                  : elementId !== undefined
                    ? elementPath(modelId, elementId, depth, 'modelling', shownAsked)
                    : modelPath(modelId, 'modelling')
              }
            >
              <Icon name="pencil" size="sm" />
              <span className="open-label">Open in Modelling</span>
            </Link>
          )}
        </div>

        {!graph ? (
          <div id="canvas" tabIndex={-1} className="canvas canvas-state" role="status">
            <span className="spinner" aria-hidden="true" />
            <p>Loading {summaryName ?? 'the model'}…</p>
          </div>
        ) : view === 'catalog' ? (
          <Catalog
            key={modelId}
            modelId={modelId}
            graph={graph}
            matches={matches}
            search={search}
            tab={tab}
            onTab={setTab}
            selectedId={selectedId}
            onSelect={selectElement}
            onFocusElement={focusElement}
            hint={
              editable
                ? 'Double-click a cell or press Enter to edit it.'
                : 'Double-click a row to show it on the canvas.'
            }
            emptyText={
              !editable
                ? 'Elements added in Modelling show here.'
                : tree.open
                  ? 'Add the first one with New element.'
                  : 'Show the element list, then use New element.'
            }
            {...(editable
              ? {
                  editing: {
                    versionOf: (id: string) =>
                      stored !== null && stored.id === id ? stored.version : undefined,
                    onStored,
                    onGone,
                    onAnnounce: setAnnouncement,
                    handle: cellEditor,
                    onState: setCellState,
                  },
                }
              : {})}
          />
        ) : elementId === undefined ? (
          <div id="canvas" tabIndex={-1} className="canvas canvas-state">
            <div className="empty">
              <Icon name="layers" />
              {graph.elements.size === 0 ? (
                <>
                  <h2>This model has no elements yet</h2>
                  <p>
                    {!editable
                      ? 'Elements added in Modelling show here.'
                      : tree.open
                        ? 'Add the first one with New element.'
                        : 'Show the element list, then use New element.'}
                  </p>
                </>
              ) : (
                <>
                  <h2>Choose an element to explore</h2>
                  <p>Pick one in the list, or start with one of the most connected:</p>
                </>
              )}
              {graph.elements.size > 0 && (
                <ul className="suggestions">
                  {mostConnected(graph, suggestions).map((suggestion) => (
                    <li key={suggestion.id}>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          focusElement(suggestion.id);
                        }}
                      >
                        <TypeMark type={suggestion.type} />
                        {suggestion.name || '(unnamed)'}
                        <span className="count">{degree(graph, suggestion.id)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : !element || !hood ? (
          <div id="canvas" tabIndex={-1} className="canvas canvas-state">
            <div className="empty">
              <Icon name="alert" />
              <h2>This element isn&apos;t in this model.</h2>
              <p>It may have been removed by a newer import.</p>
              <Link className="btn" to={modelPath(modelId, space)}>
                Clear
              </Link>
            </div>
          </div>
        ) : (
          <ErrorBoundary
            resetKey={`${modelId}|${element.id}|${depth}`}
            title="This part of the model couldn't be drawn."
            backTo={home}
            backLabel="Back to models"
          >
            <ReactFlowProvider>
              <ExplorerCanvas
                graph={graph}
                hood={hood}
                refused={hood.refused.length}
                onAddElement={addElement}
                focusId={element.id}
                depth={depth}
                lineFields={lineFields}
                shownProperties={shownProperties}
                onShownProperties={(keys) => {
                  void navigate(`${shownPath}${shownPropertiesSearch(params, keys)}`, {
                    replace: true,
                  });
                }}
                onFocusElement={focusElement}
                selectedId={selectedId}
                onSelectElement={selectElement}
                onDepth={setDepth}
                fitKey={fitKey}
                moved={movedPositions}
                onMove={moveCard}
                tidyCount={tidyCount}
                nest={nest}
                onToggleNest={toggleNest}
                editable={editable}
                modelId={modelId}
                selectedRelationshipId={selectedRelationship?.id}
                litRelationshipId={litId}
                onOpenRelationship={openRelationship}
                onDeselect={deselect}
                onRelationshipAdded={onRelationshipAdded}
                onElementCreated={onCanvasElementCreated}
                onAddRelationshipFrom={addRelationshipFrom}
                newElementRequest={newElementRequest}
                onBringElement={bringElement}
                reveal={reveal}
              />
            </ReactFlowProvider>
          </ErrorBoundary>
        )}
      </main>

      {detailsVisible && graph && (
        <>
          <aside className="details" aria-label="Details">
            <button
              type="button"
              className="icon-btn details-close"
              aria-label="Close the details"
              title="Close the details"
              onClick={details.toggle}
            >
              <Icon name="x" />
            </button>
            {editable && selectedRelationship ? (
              <RelationshipEditor
                key={selectedRelationship.id}
                modelId={modelId}
                graph={graph}
                relationship={selectedRelationship}
                focusId={selected.id}
                nest={nest}
                onBack={deselect}
                onFocusElement={followElement}
                onShow={openRelationship}
                handle={panelEditor}
                onState={setPanelState}
                onStored={onRelationshipStored}
                onRemoved={onRelationshipRemoved}
                onAnnounce={setAnnouncement}
                focusHeading={relHeadingFocus}
                onHeadingFocused={clearRelHeadingFocus}
              />
            ) : selectedRelationship ? (
              <RelationshipDetails
                key={selectedRelationship.id}
                graph={graph}
                relationship={selectedRelationship}
                backId={selected.id}
                onBack={deselect}
                onFocusElement={followElement}
                openInModelling={
                  space === 'viewing' &&
                  canEdit === true &&
                  me.spaces.includes('modelling') &&
                  elementId !== undefined
                    ? {
                        to: elementPath(modelId, elementId, depth, 'modelling', shownAsked),
                        state: { relationship: selectedRelationship.id, element: selected.id },
                      }
                    : undefined
                }
                focusHeading={relHeadingFocus}
                onHeadingFocused={clearRelHeadingFocus}
              />
            ) : editable ? (
              <ElementEditor
                key={selected.id}
                modelId={modelId}
                graph={graph}
                element={selected}
                version={version}
                link={elementPath(modelId, selected.id, depth, space, shownAsked)}
                onFocusElement={(id) => {
                  setHeadingFocusFor(id);
                  focusElement(id);
                }}
                focusHeading={headingFocusFor === selected.id}
                onHeadingFocused={clearHeadingFocus}
                focusName={nameFocusFor === selected.id}
                onNameFocused={clearNameFocus}
                handle={panelEditor}
                onState={setPanelState}
                onStored={onStored}
                onRemoved={onRemoved}
                onAnnounce={setAnnouncement}
                relationships={relationshipTools(selected)}
                headExtra={showOnCanvas(selected.id)}
              />
            ) : (
              <DetailsPanel
                key={selected.id}
                graph={graph}
                element={selected}
                link={elementPath(modelId, selected.id, depth, space, shownAsked)}
                onFocusElement={(id) => {
                  setHeadingFocusFor(id);
                  focusElement(id);
                }}
                focusHeading={headingFocusFor === selected.id}
                onHeadingFocused={clearHeadingFocus}
                relationships={{ action: null, box: null, onOpen: openRelationship }}
                headExtra={showOnCanvas(selected.id)}
              />
            )}
          </aside>
        </>
      )}
    </div>
  );
}

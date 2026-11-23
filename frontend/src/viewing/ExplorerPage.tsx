import {
  buildModelGraph,
  type CatalogTab,
  findElements,
  groupByChoices,
  relationshipViewFields,
  dataViewKey,
  type NodeType,
} from '@simplearchitecture/shared';
import { ReactFlowProvider } from '@xyflow/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useMe } from '../auth';
import { type EditorHandle, type EditorState } from '../modelling/ElementEditor';
import { NewElement } from '../modelling/NewElement';
import { ErrorBoundary } from '../ErrorBoundary';
import { Icon } from '../icons';
import { useModels } from '../models';
import { ExplorerCanvas } from './explorer/canvas/ExplorerCanvas';
import { CanvasMessage } from './explorer/CanvasMessage';
import { ExplorerDetails } from './explorer/ExplorerDetails';
import { ExplorerMessage } from './explorer/ExplorerMessage';
import { ExplorerToolbar } from './explorer/ExplorerToolbar';
import { ExplorerViewDialogs } from './explorer/ExplorerViewDialogs';
import { parseExplorerPath } from './explorer/parseExplorerPath';
import { Legend } from './explorer/Legend';
import { readShowLines, writeShowLines } from './explorer/prefs';
import { Catalog, catalogTabOnEntry } from './explorer/catalog/Catalog';
import { useRelationshipChanges } from './explorer/useRelationshipChanges';
import { ResizeHandle } from './explorer/ResizeHandle';
import { useElementSearch } from './explorer/search';
import { useElementChanges } from './explorer/useElementChanges';
import { StartPage } from './explorer/StartPage';
import { useTrail } from './explorer/trail';
import { TreePanel } from './explorer/TreePanel';
import { UnsavedGuard, type Ask } from './explorer/UnsavedGuard';
import { useCanvasCards } from './explorer/useCanvasCards';
import { useCanvasLayout } from './explorer/useCanvasLayout';
import { useEditorBridge } from './explorer/useEditorBridge';
import { useFocusAndDepth } from './explorer/useFocusAndDepth';
import { useLitRelationship } from './explorer/useLitRelationship';
import {
  noElementProperties,
  noProperties,
  useDefinedProperties,
  useModelDocument,
} from './explorer/useModelDocument';
import { useNewElementKey } from './explorer/useNewElementKey';
import { useOpenView } from './explorer/useOpenView';
import { usePanel } from './explorer/usePanel';
import { useSelection } from './explorer/useSelection';
import { useStoredVersion } from './explorer/useStoredVersion';
import { useViewPanel } from './explorer/useViewPanel';
import { ViewBar } from './explorer/ViewBar';
import { ViewNotice } from './explorer/ViewNotice';
import { noFocus } from './explorer/views';
import { useViewList } from './explorer/ViewsSection';
import {
  elementPath,
  explorerSearch,
  modelPath,
  modelStartPath,
  readExplorerView,
  viewSearchCleaned,
  spaceHome,
  groupBySearch,
  readGroupBy,
  readShownProperties,
  shownPropertiesSearch,
  type ExplorerSpace,
  type ExplorerView,
} from './paths';

export { nextTrail, trailLength } from './explorer/trail';
export { parseExplorerPath } from './explorer/parseExplorerPath';
export { unreadableModelMessage } from './explorer/useModelDocument';

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
      <UnsavedGuard modelId={parsed.modelId} elementId={parsed.elementId} viewId={parsed.viewId}>
        {(guarded) => <Explorer space={parsed.space} {...guarded} />}
      </UnsavedGuard>
    </ErrorBoundary>
  );
}

interface ExplorerProps {
  url: string;
  space: ExplorerSpace;
  modelId: string;
  elementId: string | undefined;
  /** An open view: its canvas in place of a focused element's. */
  viewId: string | undefined;
  ask: Ask;
  editor: RefObject<EditorHandle | null>;
  onEditorState: (state: EditorState | null) => void;
}

function Explorer({
  url,
  space,
  modelId,
  elementId,
  viewId,
  ask,
  editor,
  onEditorState,
}: ExplorerProps) {
  const { panelEditor, cellEditor, setPanelState, setCellState } = useEditorBridge(
    editor,
    onEditorState,
  );
  const navigate = useNavigate();
  const me = useMe();
  // The address the guard lets through (it stays while the unsaved changes dialog asks).
  const [shownPath = '', shownSearch = ''] = url.split('?');
  const params = useMemo(() => new URLSearchParams(shownSearch), [shownSearch]);
  const [load, retry, updateDocument] = useModelDocument(modelId);
  const [propertiesLoad, reloadProperties] = useDefinedProperties(modelId);
  const definitions =
    typeof propertiesLoad === 'string' ? noProperties : propertiesLoad.relationship;
  const elementDefinitions =
    typeof propertiesLoad === 'string' ? noElementProperties : propertiesLoad.element;
  const { list, reload: reloadModels } = useModels();
  const editable = space === 'modelling';
  const home = spaceHome(space);
  const allTrail = useTrail(modelId, elementId);
  const tree = usePanel('tree');
  const details = usePanel('details');
  // The relationship properties the lines show. Only the address holds them.
  const shownAsked = useMemo(() => readShownProperties(params), [params]);
  // Group by outside a view: only the address holds it (a view keeps its own).
  const groupAsked = viewId === undefined ? readGroupBy(params) : undefined;
  const { depth, focusElement, setDepth } = useFocusAndDepth({
    navigate,
    params,
    modelId,
    elementId,
    space,
    shownAsked,
    groupAsked,
  });
  const [lines, setLines] = useState(readShowLines);
  // An open view: its contents, saved at once on every change (Modelling with editing on).
  const inView = viewId !== undefined;
  const openView = useOpenView(modelId, viewId);
  const viewEditable = inView && editable;
  const viewBlocked = openView.problem === 'conflict' || openView.problem === 'deleted';
  // A view's address takes no depth and no Canvas | Catalog: they are dropped from it.
  useEffect(() => {
    if (!inView) return;
    const search = viewSearchCleaned(params);
    if (search !== undefined) void navigate(`${shownPath}${search}`, { replace: true });
  }, [inView, navigate, params, shownPath]);
  // The canvas or the catalog (in the address), and the search and filters they share
  // with the element list. A view is always on the canvas.
  const { view: askedView, tab } = readExplorerView(params);
  const view: ExplorerView = inView ? 'canvas' : askedView;
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
  const graph = useMemo(
    () => (document_ ? buildModelGraph(document_, definitions, elementDefinitions) : undefined),
    [document_, definitions, elementDefinitions],
  );
  const lineFields = useMemo(() => (graph ? relationshipViewFields(graph) : []), [graph]);
  // What the cards can be grouped by: Type and the element properties the model has.
  const groupChoices = useMemo(() => (graph ? groupByChoices(graph) : []), [graph]);
  // What the address asks for and this model has, in the list's order: others are ignored.
  const shownProperties = useMemo(
    () => lineFields.map(({ key }) => key).filter((key) => shownAsked.includes(key)),
    [lineFields, shownAsked],
  );
  const element = graph && elementId !== undefined ? graph.elements.get(elementId) : undefined;
  // Relationships with an id of their own: only those can be in a view.
  const ownIds = useMemo(
    () =>
      new Set(
        (document_?.graph.edges ?? []).flatMap((edge) =>
          typeof edge.id === 'string' && edge.id !== '' ? [edge.id] : [],
        ),
      ),
    [document_],
  );
  const hasOwnId = useCallback((id: string) => ownIds.has(id), [ownIds]);
  const matches = useMemo(
    () => (graph ? findElements(graph, { query: search.query, filters: search.filters }) : []),
    [graph, search.query, search.filters],
  );
  // A deleted element leaves the trail's names (it is no longer in the model).
  const trail = graph ? allTrail.filter((id) => graph.elements.has(id)) : allTrail;

  // The canvas: the cards added and taken off, moved and resized, nesting, Group by and tidying.
  const canvasKey = viewId !== undefined ? `view:${viewId}` : (elementId ?? '');
  const layout = useCanvasLayout({
    graph,
    element,
    elementId,
    canvasKey,
    inView,
    openView,
    viewEditable,
    viewBlocked,
    depth,
    groupAsked,
  });
  const { nest, toggleNest, addElement, groupBy, requestArrange, hood, onCanvas } = layout;
  const saveViewLayout = openView.saveLayout;
  const viewReady = openView.load.status === 'ready';

  // Group by lays the canvas out again, like the Nest switch: in a view in Modelling, the new
  // grouping and layout are saved, as after Tidy up; in Viewing, a view's is changed for the page.
  const changeGroupBy = (key: string | undefined) => {
    layout.resetMoved();
    if (inView) {
      layout.groupView(key);
      if (viewEditable && !viewBlocked) requestArrange();
      return;
    }
    void navigate(`${shownPath}${groupBySearch(params, key)}`, { replace: true });
  };

  // "Show relationships" only hides or shows the lines: unlike nesting, the cards stay where they are.
  const showLines = useCallback((on: boolean) => {
    setLines(on);
    writeShowLines(on);
  }, []);

  // The selected element and relationship, apart from the focus element. Dropped when the focus
  // changes.
  const selectionKey = canvasKey;
  const selection = useSelection({
    graph,
    selectionKey,
    elementId,
    inView,
    ask,
    details,
    focusElement,
    showLines,
  });
  const {
    setHeadingFocusFor,
    setPicked,
    selectedId,
    selected,
    setNameFocusFor,
    setSelection,
    selectedRelationship,
    setAddBoxFor,
    openRelationship,
    deselect,
    selectElement,
    addRelationshipFrom,
  } = selection;

  // Modelling: the selected element's version, read from the server for the next save or delete.
  const { version, versionOf, onStored } = useStoredVersion(
    editable,
    modelId,
    selectedId,
    selected !== undefined,
    updateDocument,
  );
  const [announcement, setAnnouncement] = useState('');

  // The relationship just added, lit for 3s.
  const [litId, setLitId] = useLitRelationship();

  const { reveal, viewFull, bringElement, addToView, addNewToView, removeCard } = useCanvasCards({
    graph,
    element,
    inView,
    viewEditable,
    viewBlocked,
    openView,
    hood,
    onCanvas,
    removableIds: layout.removableIds,
    nest,
    selectedId,
    hasOwnId,
    focusElement,
    selectElement,
    addElement,
    takeOffCanvas: layout.takeOffCanvas,
    requestArrange,
    ask,
    clearSelection: () => {
      setPicked(null);
      setSelection(null);
      setAddBoxFor(null);
    },
    announce: setAnnouncement,
  });

  const { onGone, onCreated, onRemoved, onCanvasElementCreated } = useElementChanges({
    modelId,
    space,
    graph,
    elementId,
    inView,
    view,
    params,
    tab,
    depth,
    shownAsked,
    groupAsked,
    trail,
    selectionKey,
    openView,
    navigate,
    updateDocument,
    reloadModels,
    onStored,
    setPanelState,
    setPicked,
    setSelection,
    setHeadingFocusFor,
    setNameFocusFor,
    addElement,
    addNewToView,
    announce: setAnnouncement,
  });

  /** The switch: entering the catalog opens the selected element's tab; the canvas, with no
   * focused element, focuses the selected one. */
  const showView = (next: ExplorerView) => {
    if (next === 'catalog' && inView) {
      // The catalog always shows the whole model: it leaves the view.
      void navigate(
        `${modelPath(modelId, space)}${explorerSearch(params, 'catalog', catalogTabOnEntry(modelId, selected?.type))}`,
      );
    } else if (next === 'catalog') {
      void navigate(viewUrl('catalog', catalogTabOnEntry(modelId, selected?.type)));
    } else if (elementId === undefined && selectedId !== undefined) {
      void navigate(elementPath(modelId, selectedId, depth, space, shownAsked, groupAsked));
    } else {
      void navigate(viewUrl('canvas'));
    }
  };

  const { onRelationshipAdded, onRelationshipStored, onRelationshipRemoved } =
    useRelationshipChanges({
      graph,
      document: document_,
      element,
      elementId,
      viewId,
      inView,
      viewEditable,
      depth,
      nest,
      openView,
      onCanvas,
      addElement,
      requestArrange,
      updateDocument,
      showLines,
      light: setLitId,
      announce: setAnnouncement,
      reloadModels,
      clearPanelState: () => {
        setPanelState(null);
      },
      closeRelationship: () => {
        setSelection(null);
      },
      focusHeadingOf: setHeadingFocusFor,
    });

  // `N`: a new element at the centre of the view (Modelling with editing on, not while typing,
  // and not over an open dialog or popover).
  const canPlaceElement =
    editable && view === 'canvas' && (inView ? viewReady && !viewBlocked : element !== undefined);
  const newElementRequest = useNewElementKey(canPlaceElement);

  const openViewName = inView ? openView.view?.name : undefined;
  useEffect(() => {
    const name = openViewName || element?.name || graph?.name || summaryName;
    document.title = name ? `${name} · SimpleArchitecture` : 'SimpleArchitecture';
    return () => {
      document.title = 'SimpleArchitecture';
    };
  }, [element, graph, summaryName, openViewName]);

  // Views in the left panel, and the view bar.
  const views = useViewPanel(url, tree, navigate);
  const { setViewHeadingFocus, setViewDialog, leaveViewFor } = views;
  // The start page offers up to 5 views.
  const startPage = !inView && elementId === undefined && view === 'canvas' && graph !== undefined;
  const [startViews] = useViewList(modelId, startPage);

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
  // The legend: only while a canvas is drawn (a focused element or an open view).
  const legendShown = view === 'canvas' && hood !== undefined;
  // Save as view: on a focus canvas in Modelling with editing on.
  const canSaveAsView = editable && view === 'canvas' && !inView && element !== undefined && !!hood;
  const canOpenModelling = space === 'viewing' && me.spaces.includes('modelling');
  const closeView = () => {
    leaveViewFor(modelStartPath(modelId, space, shownAsked));
  };
  const viewNotice =
    !inView || openView.problem === undefined ? undefined : (
      <ViewNotice
        problem={openView.problem}
        onReload={() => {
          setViewHeadingFocus(true);
          openView.reload();
        }}
        onClose={closeView}
        onDismiss={openView.dismiss}
      />
    );
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
        else bringElement(existing.id);
      }}
      isOnCanvas={(id) => onCanvas.has(id)}
      {...(view === 'catalog' ? { existingLabel: 'Show in catalog' } : {})}
    />
  ) : undefined;

  // What both canvases (an open view's and a focused element's) are given alike.
  const canvasProps = {
    lineFields,
    shownProperties,
    onShownProperties: (keys: string[]) => {
      void navigate(`${shownPath}${shownPropertiesSearch(params, keys)}`, {
        replace: true,
      });
    },
    groupChoices,
    groupBy,
    onGroupBy: changeGroupBy,
    onFocusElement: focusElement,
    selectedId,
    onSelectElement: selectElement,
    fitKey,
    moved: layout.movedPositions,
    onMove: layout.moveCard,
    widths: layout.cardWidths,
    onResize: layout.resizeCard,
    tidyCount: layout.tidyCount,
    layoutKey: layout.layoutKey,
    onKept: layout.setKeptFor,
    relationsTidyCount: layout.relationsTidyCount,
    onRelationsTidyable: layout.setCanTidyRelations,
    onTidyRelations: layout.tidyRelationsByKey,
    nest,
    onToggleNest: toggleNest,
    lines,
    onLines: showLines,
    modelId,
    selectedRelationshipId: selectedRelationship?.id,
    litRelationshipId: litId,
    onOpenRelationship: openRelationship,
    onDeselect: deselect,
    onRelationshipAdded,
    onElementCreated: onCanvasElementCreated,
    onAddRelationshipFrom: addRelationshipFrom,
    newElementRequest,
    reveal,
    removable: layout.removableIds,
    onRemoveCard: removeCard,
  };

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
        <TreePanel
          modelId={modelId}
          space={space}
          graph={graph}
          editable={editable}
          selectedId={selectedId}
          viewId={viewId}
          shownAsked={shownAsked}
          search={search}
          searchElsewhere={view === 'catalog'}
          top={treeTop}
          onFocusElement={focusElement}
          onSelectElement={selectElement}
          onAddToCanvas={(id) => {
            bringElement(id);
          }}
          views={views}
          canSaveAsView={canSaveAsView}
          onAnnounce={setAnnouncement}
          onFolderChanged={(changed) => {
            const open = changed.find((one) => one.id === viewId);
            if (open !== undefined) openView.refiled(open.folder);
          }}
          legend={
            legendShown && (
              <Legend
                types={layout.typesOnCanvas}
                nest={nest}
                onToggleNest={toggleNest}
                lines={lines}
                onToggleLines={() => {
                  showLines(!lines);
                }}
                dataShown={shownProperties.includes(dataViewKey)}
              />
            )
          }
        />
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
        <ExplorerToolbar
          modelId={modelId}
          space={space}
          graph={graph}
          elementId={elementId}
          viewId={viewId}
          view={view}
          tab={tab}
          params={params}
          depth={depth}
          shownAsked={shownAsked}
          groupAsked={groupAsked}
          trail={trail}
          tree={tree}
          details={details}
          canOpenModelling={canOpenModelling}
          onShowView={showView}
          onDepth={setDepth}
          canTidy={layout.canTidy}
          canTidyRelations={layout.canTidyRelations}
          onTidyUp={layout.tidyUp}
          onTidyRelations={layout.tidyRelations}
        />

        {inView && viewReady && openView.view && (
          <ViewBar
            name={openView.view.name}
            folder={openView.view.folder}
            editable={viewEditable}
            saving={openView.saving}
            savedCount={openView.savedCount}
            onRename={() => {
              setViewDialog('rename');
            }}
            onDelete={() => {
              setViewDialog('delete');
            }}
            onClose={closeView}
            focusHeading={views.viewHeadingFocus}
            onHeadingFocused={() => {
              setViewHeadingFocus(false);
            }}
            renameRef={views.renameButton}
          />
        )}
        {!graph || (inView && openView.load.status === 'loading') ? (
          <div id="canvas" tabIndex={-1} className="canvas canvas-state" role="status">
            <span className="spinner" aria-hidden="true" />
            <p>
              {graph && inView ? 'Loading the view…' : `Loading ${summaryName ?? 'the model'}…`}
            </p>
          </div>
        ) : inView && openView.load.status === 'missing' ? (
          <CanvasMessage
            icon="alert"
            title="This view doesn't exist."
            text="It may have been deleted, or the link is wrong."
            action={
              <button type="button" className="btn" onClick={closeView}>
                Close view
              </button>
            }
          />
        ) : inView && openView.load.status === 'failed' ? (
          <CanvasMessage
            icon="alert"
            title="The view couldn't be loaded."
            text={openView.load.message}
            action={
              <button type="button" className="btn" onClick={openView.reload}>
                Try again
              </button>
            }
          />
        ) : inView && hood ? (
          <ErrorBoundary
            resetKey={`${modelId}|${canvasKey}`}
            title="This view couldn't be drawn."
            backTo={home}
            backLabel="Back to models"
          >
            <ReactFlowProvider>
              <ExplorerCanvas
                {...canvasProps}
                graph={graph}
                hood={hood}
                refused={0}
                onAddElement={(id) => {
                  addToView(id);
                }}
                focusId={noFocus}
                depth={depth}
                viewName={openView.view?.name ?? ''}
                related={viewEditable}
                notice={viewNotice}
                fullText={viewFull ?? undefined}
                emptyText={
                  <>
                    <Icon name="layers" />
                    <h2>This view is empty.</h2>
                    <p>
                      {viewEditable
                        ? 'Drag elements here from the list, or use Add to canvas.'
                        : 'Its elements were removed from the model or from the view.'}
                    </p>
                  </>
                }
                onDepth={() => undefined}
                editable={viewEditable && !viewBlocked}
                {...(viewEditable ? { onBringElement: bringElement } : {})}
                storedLayout={layout.storedLayout}
                storedRoutes={layout.storedRoutes}
                storedGroupBy={openView.view?.groupBy ?? undefined}
                arrangeRequest={layout.arrangeRequest}
                {...(viewEditable && !viewBlocked ? { onArranged: saveViewLayout } : {})}
              />
            </ReactFlowProvider>
          </ErrorBoundary>
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
            {...(space === 'modelling'
              ? { download: { modelName: graph.name || summaryName || '' } }
              : {})}
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
                    versionOf,
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
          <StartPage
            modelId={modelId}
            space={space}
            graph={graph}
            editable={editable}
            treeOpen={tree.open}
            shownAsked={shownAsked}
            startViews={startViews}
            onFocusElement={focusElement}
            onOpenView={() => {
              setViewHeadingFocus(true);
            }}
            onAllViews={views.showAllViews}
          />
        ) : !element || !hood ? (
          <CanvasMessage
            icon="alert"
            title="This element isn't in this model."
            text="It may have been removed by a newer import."
            action={
              <Link className="btn" to={modelPath(modelId, space)}>
                Clear
              </Link>
            }
          />
        ) : (
          <ErrorBoundary
            resetKey={`${modelId}|${element.id}|${depth}`}
            title="This part of the model couldn't be drawn."
            backTo={home}
            backLabel="Back to models"
          >
            <ReactFlowProvider>
              <ExplorerCanvas
                {...canvasProps}
                graph={graph}
                hood={hood}
                refused={hood.refused.length}
                onAddElement={addElement}
                focusId={element.id}
                depth={depth}
                onDepth={setDepth}
                editable={editable}
                onBringElement={bringElement}
              />
            </ReactFlowProvider>
          </ErrorBoundary>
        )}
      </main>

      {detailsVisible && graph && (
        <ExplorerDetails
          modelId={modelId}
          space={space}
          graph={graph}
          editable={editable}
          view={view}
          elementId={elementId}
          viewId={viewId}
          depth={depth}
          shownAsked={shownAsked}
          groupAsked={groupAsked}
          canOpenModelling={canOpenModelling}
          selected={selected}
          selectedRelationship={selectedRelationship}
          version={version}
          selection={selection}
          views={views}
          viewSavedCount={openView.savedCount}
          nest={nest}
          onCanvas={onCanvas}
          litId={litId}
          panelEditor={panelEditor}
          onPanelState={setPanelState}
          onFocusElement={focusElement}
          onShowLines={showLines}
          onStored={onStored}
          onRemoved={onRemoved}
          onRelationshipAdded={onRelationshipAdded}
          onRelationshipStored={onRelationshipStored}
          onRelationshipRemoved={onRelationshipRemoved}
          onAnnounce={setAnnouncement}
          propertiesFailed={propertiesLoad === 'failed'}
          onPropertiesStale={reloadProperties}
          onClose={details.toggle}
        />
      )}
      <ExplorerViewDialogs
        modelId={modelId}
        space={space}
        shownAsked={shownAsked}
        views={views}
        openView={openView}
        hood={hood}
        element={element}
        hasOwnId={hasOwnId}
        groupBy={groupBy}
        groupChoices={groupChoices}
        onAnnounce={setAnnouncement}
      />
    </div>
  );
}

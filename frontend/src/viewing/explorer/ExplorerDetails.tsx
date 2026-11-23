import type { ModelElement, ModelGraph, ModelRelationship } from '@simplearchitecture/shared';
import type { ComponentProps, ReactNode, RefObject } from 'react';
import { Icon } from '../../icons';
import { ElementEditor, type EditorHandle, type EditorState } from '../../modelling/ElementEditor';
import { RelationshipEditor } from '../../modelling/RelationshipEditor';
import { AddRelationshipBox } from '../../modelling/relationships';
import { elementPath, type ExplorerSpace, type ExplorerView } from '../paths';
import { DetailsPanel, type RelationshipTools } from './DetailsPanel';
import { RelationshipDetails } from './RelationshipDetails';
import { UsedInViews } from './UsedInViews';
import type { useSelection } from './useSelection';
import type { ViewPanel } from './useViewPanel';

interface ExplorerDetailsProps {
  modelId: string;
  space: ExplorerSpace;
  graph: ModelGraph;
  editable: boolean;
  view: ExplorerView;
  elementId: string | undefined;
  viewId: string | undefined;
  depth: number;
  shownAsked: readonly string[];
  groupAsked: string | undefined;
  /** Open in Modelling: in Viewing, for a person who may model. */
  canOpenModelling: boolean;
  selected: ModelElement;
  selectedRelationship: ModelRelationship | undefined;
  /** Modelling: the selected element's version, for its next save. */
  version: number | undefined;
  selection: ReturnType<typeof useSelection>;
  views: ViewPanel;
  /** Goes up after each save of the open view. */
  viewSavedCount: number;
  nest: boolean;
  onCanvas: ReadonlySet<string>;
  /** The relationship just added, lit for a moment. */
  litId: string | undefined;
  panelEditor: RefObject<EditorHandle | null>;
  onPanelState: (state: EditorState | null) => void;
  onFocusElement: (id: string) => void;
  onShowLines: (on: boolean) => void;
  onStored: ComponentProps<typeof ElementEditor>['onStored'];
  onRemoved: ComponentProps<typeof ElementEditor>['onRemoved'];
  onRelationshipAdded: ComponentProps<typeof AddRelationshipBox>['onAdded'];
  onRelationshipStored: ComponentProps<typeof RelationshipEditor>['onStored'];
  onRelationshipRemoved: ComponentProps<typeof RelationshipEditor>['onRemoved'];
  onAnnounce: (text: string) => void;
  propertiesFailed: boolean;
  onPropertiesStale: () => void;
  onClose: () => void;
}

/**
 * The right panel: the selected element, or the relationship open in it. Read-only in Viewing; in
 * Modelling, the editing form.
 */
export function ExplorerDetails({
  modelId,
  space,
  graph,
  editable,
  view,
  elementId,
  viewId,
  depth,
  shownAsked,
  groupAsked,
  canOpenModelling,
  selected,
  selectedRelationship,
  version,
  selection,
  views,
  viewSavedCount,
  nest,
  onCanvas,
  litId,
  panelEditor,
  onPanelState,
  onFocusElement,
  onShowLines,
  onStored,
  onRemoved,
  onRelationshipAdded,
  onRelationshipStored,
  onRelationshipRemoved,
  onAnnounce,
  propertiesFailed,
  onPropertiesStale,
  onClose,
}: ExplorerDetailsProps) {
  const {
    addBoxOpen,
    setAddBoxFor,
    openRelationship,
    deselect,
    followElement,
    headingFocusFor,
    setHeadingFocusFor,
    clearHeadingFocus,
    nameFocusFor,
    clearNameFocus,
    relHeadingFocus,
    clearRelHeadingFocus,
  } = selection;

  const relationshipTools = (focused: ModelElement): RelationshipTools => ({
    action: (
      <button
        type="button"
        className="linkbtn add-rel-btn"
        aria-expanded={addBoxOpen}
        aria-controls="add-rel-box"
        onClick={() => {
          setAddBoxFor(addBoxOpen ? null : focused.id);
          if (!addBoxOpen) onShowLines(true);
        }}
      >
        <Icon name="plus" size="sm" />
        Add relationship
      </button>
    ),
    box: addBoxOpen ? (
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
          onFocusElement(id);
        }}
      >
        Show on canvas
      </button>
    ) : null;

  /**
   * The views holding the element, read again after this person saves, renames or deletes a view,
   * and after each save of the open view (its contents may have gained or lost the element).
   */
  const usedInViews = (id: string): ReactNode => (
    <UsedInViews
      modelId={modelId}
      elementId={id}
      space={space}
      shown={shownAsked}
      currentViewId={viewId}
      refresh={`${views.viewsRefresh}\n${viewId ?? ''}\n${viewSavedCount}`}
      onOpenView={() => {
        views.setViewHeadingFocus(true);
      }}
    />
  );

  return (
    <aside className="details" aria-label="Details">
      <button
        type="button"
        className="icon-btn details-close"
        aria-label="Close the details"
        title="Close the details"
        onClick={onClose}
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
          onState={onPanelState}
          onStored={onRelationshipStored}
          onRemoved={onRelationshipRemoved}
          onAnnounce={onAnnounce}
          focusHeading={relHeadingFocus}
          onHeadingFocused={clearRelHeadingFocus}
          propertiesFailed={propertiesFailed}
          onPropertiesStale={onPropertiesStale}
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
            canOpenModelling && elementId !== undefined
              ? {
                  to: elementPath(modelId, elementId, depth, 'modelling', shownAsked, groupAsked),
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
          link={elementPath(modelId, selected.id, depth, space, shownAsked, groupAsked)}
          onFocusElement={(id) => {
            setHeadingFocusFor(id);
            onFocusElement(id);
          }}
          focusHeading={headingFocusFor === selected.id}
          onHeadingFocused={clearHeadingFocus}
          focusName={nameFocusFor === selected.id}
          onNameFocused={clearNameFocus}
          handle={panelEditor}
          onState={onPanelState}
          onStored={onStored}
          onRemoved={onRemoved}
          onAnnounce={onAnnounce}
          propertiesFailed={propertiesFailed}
          onPropertiesStale={onPropertiesStale}
          relationships={relationshipTools(selected)}
          headExtra={showOnCanvas(selected.id)}
          usedIn={usedInViews(selected.id)}
        />
      ) : (
        <DetailsPanel
          key={selected.id}
          graph={graph}
          element={selected}
          link={elementPath(modelId, selected.id, depth, space, shownAsked, groupAsked)}
          onFocusElement={(id) => {
            setHeadingFocusFor(id);
            onFocusElement(id);
          }}
          focusHeading={headingFocusFor === selected.id}
          onHeadingFocused={clearHeadingFocus}
          relationships={{ action: null, box: null, onOpen: openRelationship }}
          headExtra={showOnCanvas(selected.id)}
          usedIn={usedInViews(selected.id)}
        />
      )}
    </aside>
  );
}

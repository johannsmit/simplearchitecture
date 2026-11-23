import type { ModelGraph, ViewSummary } from '@simplearchitecture/shared';
import type { ReactNode } from 'react';
import { Icon } from '../../icons';
import type { ExplorerSpace } from '../paths';
import { ElementTree } from './ElementTree';
import type { ElementSearch } from './search';
import type { ViewPanel } from './useViewPanel';
import { ViewsSection } from './ViewsSection';

interface TreePanelProps {
  modelId: string;
  space: ExplorerSpace;
  /** Undefined while the model loads: the list shows as a skeleton. */
  graph: ModelGraph | undefined;
  editable: boolean;
  selectedId: string | undefined;
  viewId: string | undefined;
  shownAsked: readonly string[];
  search: ElementSearch;
  /** The search also filters the catalog. */
  searchElsewhere: boolean;
  /** Above the list: New element, in Modelling. */
  top: ReactNode;
  onFocusElement: (id: string) => void;
  onSelectElement: (id: string) => void;
  onAddToCanvas: (id: string) => void;
  views: ViewPanel;
  /** Save as view is offered (a focus canvas in Modelling). */
  canSaveAsView: boolean;
  onAnnounce: (text: string) => void;
  onFolderChanged: (changed: ViewSummary[]) => void;
  /** The legend, under the views, while a canvas is drawn. */
  legend: ReactNode;
}

/** The left panel: the element list, the views, and the legend. */
export function TreePanel({
  modelId,
  space,
  graph,
  editable,
  selectedId,
  viewId,
  shownAsked,
  search,
  searchElsewhere,
  top,
  onFocusElement,
  onSelectElement,
  onAddToCanvas,
  views,
  canSaveAsView,
  onAnnounce,
  onFolderChanged,
  legend,
}: TreePanelProps) {
  const viewsEmptyText = !editable
    ? 'No views yet. Views are saved in Modelling.'
    : canSaveAsView
      ? 'No views yet.'
      : 'No views yet. Focus an element, then use Save as view here.';
  return (
    <aside className="tree-panel" aria-label="Elements and views">
      {graph ? (
        <ElementTree
          key={modelId}
          modelId={modelId}
          graph={graph}
          selectedId={selectedId}
          onFocusElement={onFocusElement}
          onSelectElement={onSelectElement}
          onAddToCanvas={onAddToCanvas}
          search={search}
          searchElsewhere={searchElsewhere}
          top={top}
          emptyText={
            editable ? 'No elements yet. Add the first one with New element.' : 'No elements yet.'
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
                <span className="skeleton" style={{ width: `${55 + ((index * 17) % 40)}%` }} />
              </li>
            ))}
          </ul>
        </>
      )}
      {/* Views and the legend share the space the element list leaves. */}
      <div className="psecs">
        <ViewsSection
          modelId={modelId}
          space={space}
          shown={shownAsked}
          currentViewId={viewId}
          emptyText={viewsEmptyText}
          onSaveAsView={
            canSaveAsView
              ? () => {
                  views.setViewDialog('save');
                }
              : undefined
          }
          open={views.viewsOpen}
          onToggle={views.toggleViews}
          refresh={views.viewsRefresh}
          headerRef={views.viewsHeader}
          saveRef={views.saveViewButton}
          onOpenView={() => {
            views.setViewHeadingFocus(true);
          }}
          editable={editable}
          onAnnounce={onAnnounce}
          onFolderChanged={onFolderChanged}
        />
        {legend}
      </div>
    </aside>
  );
}

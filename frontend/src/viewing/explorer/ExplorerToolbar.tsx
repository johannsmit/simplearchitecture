import { maxDepth, type CatalogTab, type ModelGraph } from '@simplearchitecture/shared';
import { Link, useNavigate } from 'react-router';
import { Icon, type IconName } from '../../icons';
import { Popover } from '../../shell/Popover';
import { counted } from '../../words';
import {
  elementPath,
  explorerSearch,
  modelPath,
  viewPath,
  type ExplorerSpace,
  type ExplorerView,
} from '../paths';
import type { Panel } from './usePanel';

/** What Tidy up does: its tooltip, and its line in the tidy menu. */
const tidyUpText = 'Put every card and line back in the automatic layout';

/**
 * One action in the tidy menu: its name, a line on what it does, and its key, if any. A disabled
 * one stays in the menu (the arrow keys reach it) and does nothing.
 */
function TidyItem(props: {
  id: string;
  icon: IconName;
  name: string;
  description: string;
  shortcut?: string;
  disabled: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="menu-item tidy-item"
      aria-labelledby={`${props.id}-name`}
      aria-describedby={`${props.id}-text`}
      aria-disabled={props.disabled}
      aria-keyshortcuts={props.shortcut}
      onClick={() => {
        if (!props.disabled) props.onChoose();
      }}
    >
      <Icon name={props.icon} />
      <span className="menu-item-text">
        <span id={`${props.id}-name`} className="menu-item-name">
          {props.name}
        </span>
        <span id={`${props.id}-text`} className="menu-item-description">
          {props.description}
        </span>
      </span>
      {props.shortcut !== undefined && <kbd aria-hidden="true">{props.shortcut}</kbd>}
    </button>
  );
}

interface ExplorerToolbarProps {
  modelId: string;
  space: ExplorerSpace;
  graph: ModelGraph | undefined;
  elementId: string | undefined;
  viewId: string | undefined;
  view: ExplorerView;
  tab: CatalogTab;
  params: URLSearchParams;
  depth: number;
  shownAsked: readonly string[];
  groupAsked: string | undefined;
  trail: readonly string[];
  tree: Panel;
  details: Panel;
  /** Open in Modelling: in Viewing, for a person who may model. */
  canOpenModelling: boolean;
  onShowView: (next: ExplorerView) => void;
  onDepth: (next: number) => void;
  canTidy: boolean;
  canTidyRelations: boolean;
  onTidyUp: () => void;
  onTidyRelations: (fromMenu: boolean) => void;
}

/**
 * Above the canvas or catalog: the panel switches, Canvas | Catalog, the trail of visited
 * elements, Tidy up, the depth, and Open in Modelling.
 */
export function ExplorerToolbar({
  modelId,
  space,
  graph,
  elementId,
  viewId,
  view,
  tab,
  params,
  depth,
  shownAsked,
  groupAsked,
  trail,
  tree,
  details,
  canOpenModelling,
  onShowView,
  onDepth,
  canTidy,
  canTidyRelations,
  onTidyUp,
  onTidyRelations,
}: ExplorerToolbarProps) {
  const navigate = useNavigate();
  const inView = viewId !== undefined;
  return (
    <div className="toolbar">
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
      <div className="segmented view-switch" role="group" aria-label="Show as">
        {(['canvas', 'catalog'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={value === view}
            onClick={() => {
              if (value !== view) onShowView(value);
            }}
          >
            {value === 'canvas' ? 'Canvas' : 'Catalog'}
          </button>
        ))}
      </div>
      {view === 'catalog' || inView ? (
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
                    <Link to={elementPath(modelId, id, depth, space, shownAsked, groupAsked)}>
                      {name}
                    </Link>
                  </li>
                );
              })}
            </ol>
          </nav>
        </>
      )}
      {view === 'canvas' && (
        <div className="split">
          <button
            type="button"
            className="btn tidy"
            aria-label="Tidy up"
            title={tidyUpText}
            disabled={!canTidy}
            onClick={onTidyUp}
          >
            <Icon name="wand-sparkles" />
            <span className="tidy-label">Tidy up</span>
          </button>
          <Popover
            id="tidy"
            role="menu"
            buttonClassName="btn tidy-more"
            buttonLabel="More ways to tidy"
            buttonTitle="More ways to tidy"
            buttonContent={<Icon name="chev-down" size="sm" />}
            buttonDisabled={!canTidy && !canTidyRelations}
            popoverClassName="tidy-pop"
          >
            {(_close, leave) => (
              <>
                <TidyItem
                  id="tidy-up"
                  icon="wand-sparkles"
                  name="Tidy up"
                  description={tidyUpText}
                  disabled={!canTidy}
                  onChoose={() => {
                    leave();
                    onTidyUp();
                  }}
                />
                <TidyItem
                  id="tidy-relations"
                  icon="spline"
                  name="Tidy relations"
                  description="Redraw every line, including lines moved by hand. No card moves."
                  shortcut="T"
                  disabled={!canTidyRelations}
                  onChoose={() => {
                    leave();
                    onTidyRelations(true);
                  }}
                />
              </>
            )}
          </Popover>
        </div>
      )}
      {view === 'canvas' && !inView && (
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
                onDepth(value);
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
      {canOpenModelling && (
        <Link
          className="btn open-modelling"
          aria-label="Open in Modelling"
          title="Open in Modelling"
          to={
            inView
              ? viewPath(modelId, viewId, 'modelling', shownAsked)
              : view === 'catalog'
                ? `${
                    elementId !== undefined
                      ? elementPath(modelId, elementId, undefined, 'modelling')
                      : modelPath(modelId, 'modelling')
                  }${explorerSearch(params, 'catalog', tab)}`
                : elementId !== undefined
                  ? elementPath(modelId, elementId, depth, 'modelling', shownAsked, groupAsked)
                  : modelPath(modelId, 'modelling')
          }
        >
          <Icon name="pencil" size="sm" />
          <span className="open-label">Open in Modelling</span>
        </Link>
      )}
    </div>
  );
}

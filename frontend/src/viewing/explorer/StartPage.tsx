import { degree, mostConnected, type ModelGraph } from '@simplearchitecture/shared';
import { Link } from 'react-router';
import { Icon } from '../../icons';
import { TypeMark } from '../../metamodel-ui';
import { formatNumber } from '../../words';
import { viewPath, type ExplorerSpace } from '../paths';
import type { ListLoad } from './useViewList';

/** How many elements, and views, the start page suggests. */
const suggestions = 5;

interface StartPageProps {
  modelId: string;
  space: ExplorerSpace;
  graph: ModelGraph;
  editable: boolean;
  /** The element list shows (where New element is). */
  treeOpen: boolean;
  shownAsked: readonly string[];
  startViews: ListLoad;
  onFocusElement: (id: string) => void;
  /** A view was opened from here: its heading takes the focus. */
  onOpenView: () => void;
  onAllViews: () => void;
}

/** The canvas area with no element focused: the most connected elements, and some views. */
export function StartPage({
  modelId,
  space,
  graph,
  editable,
  treeOpen,
  shownAsked,
  startViews,
  onFocusElement,
  onOpenView,
  onAllViews,
}: StartPageProps) {
  return (
    <div id="canvas" tabIndex={-1} className="canvas canvas-state">
      <div className="empty">
        <Icon name="layers" />
        {graph.elements.size === 0 ? (
          <>
            <h2>This model has no elements yet</h2>
            <p>
              {!editable
                ? 'Elements added in Modelling show here.'
                : treeOpen
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
                    onFocusElement(suggestion.id);
                  }}
                >
                  <TypeMark type={suggestion.type} metadata={suggestion.metadata} />
                  {suggestion.name || '(unnamed)'}
                  <span className="count">{degree(graph, suggestion.id)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {startViews.status === 'ready' && startViews.views.length > 0 && (
          <div className="start-views">
            <p>Or open a view:</p>
            <ul className="suggestions">
              {startViews.views.slice(0, suggestions).map((item) => (
                <li key={item.id}>
                  <Link
                    className="btn"
                    to={viewPath(modelId, item.id, space, shownAsked)}
                    title={item.name}
                    onClick={onOpenView}
                  >
                    <Icon name="bookmark" />
                    {item.name || '(unnamed)'}
                  </Link>
                </li>
              ))}
              {startViews.views.length > suggestions && (
                <li className="all-views">
                  <button type="button" className="linkbtn" onClick={onAllViews}>
                    All views ({formatNumber(startViews.views.length)})
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

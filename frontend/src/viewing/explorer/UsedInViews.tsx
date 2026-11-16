import { compareNames, type ViewSummary } from '@simplearchitecture/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ApiRequestError, listElementViews } from '../../api';
import { Icon } from '../../icons';
import { viewPath, type ExplorerSpace } from '../paths';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; views: ViewSummary[] }
  | { status: 'failed'; message: string };

interface UsedInViewsProps {
  modelId: string;
  elementId: string;
  space: ExplorerSpace;
  /** The relationship properties shown: a view's link keeps them. */
  shown: readonly string[];
  /** The open view, marked in the list. */
  currentViewId: string | undefined;
  /**
   * Changes whenever a view may have gained or lost the element (a view saved, renamed or
   * deleted, or the open view's contents saved): the list is read again.
   */
  refresh: string;
  /** A view picked in the list, just before its address opens. */
  onOpenView: (viewId: string) => void;
}

/**
 * "Used in views" in the element's details panel: the model's views that hold the element, by
 * name, each a link that opens it. Read from the server when the element is shown and again on
 * each `refresh`; while a new read runs, the list read last for this element stays.
 */
export function UsedInViews({
  modelId,
  elementId,
  space,
  shown,
  currentViewId,
  refresh,
  onOpenView,
}: UsedInViewsProps) {
  const target = `${modelId}\n${elementId}`;
  const [load, setLoad] = useState<{ target: string; value: Load }>({
    target,
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    listElementViews(modelId, elementId, controller.signal)
      .then((views) => {
        const sorted = [...views].sort((a, b) => compareNames(a.name, b.name));
        setLoad({ target, value: { status: 'ready', views: sorted } });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Without a database the server says views need one; anything else is a plain failure.
        const message =
          error instanceof ApiRequestError && error.status === 501 ? error.message : '';
        setLoad({ target, value: { status: 'failed', message } });
      });
    return () => {
      controller.abort();
    };
  }, [modelId, elementId, target, refresh, attempt]);

  const value: Load = load.target === target ? load.value : { status: 'loading' };

  return (
    <section className="used-in" aria-label="Used in views">
      <h3>
        Used in views{' '}
        {value.status === 'ready' && <span className="count">{value.views.length}</span>}
      </h3>
      {value.status === 'loading' ? (
        <p className="muted" role="status">
          <span className="spinner sm" aria-hidden="true" /> Loading views…
        </p>
      ) : value.status === 'failed' ? (
        <p className="muted" role="alert">
          {value.message || "The views couldn't be loaded."}{' '}
          {value.message === '' && (
            <button
              type="button"
              className="linkbtn"
              onClick={() => {
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          )}
        </p>
      ) : value.views.length === 0 ? (
        <p className="muted">In no views</p>
      ) : (
        <ul>
          {value.views.map((view) => {
            const current = view.id === currentViewId;
            return (
              <li key={view.id}>
                <Link
                  to={viewPath(modelId, view.id, space, shown)}
                  {...(current ? { 'aria-current': 'page' as const } : {})}
                  onClick={() => {
                    onOpenView(view.id);
                  }}
                >
                  <Icon name="bookmark" size="sm" />
                  <span className="n">{view.name || '(unnamed)'}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

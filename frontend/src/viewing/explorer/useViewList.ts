import { compareNames, type ViewSummary } from '@simplearchitecture/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, listViews } from '../../api';

export type ListLoad =
  | { status: 'loading' }
  | { status: 'ready'; views: ViewSummary[] }
  | { status: 'failed'; message: string };

/**
 * The model's views by name, read again each time it becomes active or `refresh` changes (views
 * saved by others show up). Until that read arrives it says loading, never the list from last
 * time, so a view just saved, renamed or deleted is never shown as it was. The third item reads
 * the list again quietly: the list shown stays until the new one arrives (after a folder change,
 * which the list already shows).
 */
export function useViewList(
  modelId: string,
  active: boolean,
  refresh = 0,
): [ListLoad, () => void, () => void] {
  const [load, setLoad] = useState<{ key: string; value: ListLoad }>({
    key: '',
    value: { status: 'loading' },
  });
  const [attempt, setAttempt] = useState(0);
  const [quiet, setQuiet] = useState({ count: 0, from: '', base: '' });
  // A new read, with a new key, on every activation.
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (active) setAttempt((n) => n + 1);
  }
  const base = `${modelId}\n${attempt}\n${refresh}`;
  const key = `${base}\n${quiet.count}`;
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
  // The list shown now stays shown until the next one arrives.
  const shownKey = load.value.status === 'ready' ? load.key : '';
  const reread = useCallback(() => {
    setQuiet((previous) => ({ count: previous.count + 1, from: shownKey, base }));
  }, [shownKey, base]);
  const current = load.key === key;
  // Only while nothing else asked for a new read meanwhile (another model, a retry, a refresh).
  const kept = !current && quiet.from !== '' && load.key === quiet.from && quiet.base === base;
  return [active && (current || kept) ? load.value : { status: 'loading' }, retry, reread];
}

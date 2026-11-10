import type { StoredView, ViewCardLayout, ViewSummary } from '@simplearchitecture/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, getView, replaceViewContents, replaceViewLayout } from '../../api';
import type { ViewContents } from './views';

/** Why the last change to the view wasn't saved. */
export type ViewProblem = 'conflict' | 'deleted' | 'failed' | 'rejected';

export type ViewLoad =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'missing' }
  | { status: 'failed'; message: string };

export interface OpenView {
  load: ViewLoad;
  /** The view as last read or saved (name and version). */
  view: StoredView | undefined;
  /** What the canvas shows: the saved contents with any change on its way. */
  contents: ViewContents;
  /** "Saving…" while a save runs; `savedCount` goes up after each one that worked. */
  saving: boolean;
  savedCount: number;
  problem: ViewProblem | undefined;
  /**
   * Applies a change at once and saves the view's whole new contents, one save at a time. A
   * change while one runs goes next. Refused (false) while the view isn't ready, or until it is
   * reloaded after someone else changed or deleted it.
   */
  change: (next: (current: ViewContents) => ViewContents | undefined) => boolean;
  /**
   * Saves where the view's cards are, after a change of contents on its way. Only for what the
   * person did on the canvas: a layout the canvas made on its own is never saved. Refused (false)
   * as `change` is. Cards no longer in the view are left out.
   */
  saveLayout: (cards: readonly ViewCardLayout[]) => boolean;
  /**
   * The server has changed the view already, with a change to the model: something deleted from
   * the model is out of every view, and a relationship's new end is in every view that holds it.
   * The view takes the change without saving. `version`: the view's version after the server's
   * change, taken only when it follows the one read (else someone else changed the view too, and
   * the next save reports the conflict).
   */
  adopt: (next: (current: ViewContents) => ViewContents, version?: number) => void;
  /** Reads the view again (Reload view) and drops a problem. */
  reload: () => void;
  /** A rename was saved: the new name and version. */
  renamed: (summary: ViewSummary) => void;
  dismiss: () => void;
}

const noContents: ViewContents = { elementIds: [], relationshipIds: [] };

interface Queue {
  running: boolean;
  /** The contents changed since the last save. */
  contents: boolean;
  /** The layout to save after the contents. */
  layout: readonly ViewCardLayout[] | undefined;
}

const idleQueue = (): Queue => ({ running: false, contents: false, layout: undefined });

const contentsOf = (view: StoredView | undefined): ViewContents =>
  view ? { elementIds: view.elementIds, relationshipIds: view.relationshipIds } : noContents;

interface State {
  key: string;
  load: ViewLoad;
  view: StoredView | undefined;
  contents: ViewContents;
  saving: boolean;
  savedCount: number;
  problem: ViewProblem | undefined;
}

const initial = (key: string): State => ({
  key,
  load: { status: 'loading' },
  view: undefined,
  contents: noContents,
  saving: false,
  savedCount: 0,
  problem: undefined,
});

/**
 * The open view: read from the server, changed on the canvas and saved at once. After a failed
 * save the canvas goes back to the last saved contents, so what is shown is always what is stored.
 * A layout that wasn't saved stays on the canvas: the next one saved holds every card again.
 */
export function useOpenView(modelId: string, viewId: string | undefined): OpenView {
  const [attempt, setAttempt] = useState(0);
  const key = viewId === undefined ? '' : `${modelId}\n${viewId}\n${attempt}`;
  const [state, setState] = useState<State>(() => initial(key));
  if (state.key !== key) setState(initial(key));
  const current = state.key === key ? state : initial(key);

  // Read by the save queue, which runs outside rendering.
  const live = useRef({ key, saved: undefined as StoredView | undefined, shown: noContents });
  // What waits to be saved: the contents, and the latest layout asked for.
  const queue = useRef(idleQueue());

  useEffect(() => {
    live.current = { key, saved: undefined, shown: noContents };
    queue.current = idleQueue();
    if (viewId === undefined) return;
    const controller = new AbortController();
    getView(modelId, viewId, controller.signal)
      .then((view) => {
        live.current = { key, saved: view, shown: contentsOf(view) };
        setState((previous) =>
          previous.key === key
            ? { ...previous, load: { status: 'ready' }, view, contents: contentsOf(view) }
            : previous,
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const status = error instanceof ApiRequestError ? error.status : 0;
        const load: ViewLoad =
          status === 404 || status === 400
            ? { status: 'missing' }
            : {
                status: 'failed',
                message:
                  error instanceof ApiRequestError ? error.message : "The view couldn't be read.",
              };
        setState((previous) => (previous.key === key ? { ...previous, load } : previous));
      });
    return () => {
      controller.abort();
    };
  }, [key, modelId, viewId]);

  const run = useCallback(() => {
    const q = queue.current;
    // Set by a change made while a save runs (outside this function).
    const pending = (): boolean => q.contents || q.layout !== undefined;
    // Saved next, with whatever the view holds by then.
    if (q.running || !pending()) return;
    if (live.current.saved === undefined || viewId === undefined) return;
    q.running = true;
    const runKey = live.current.key;
    const stale = () => live.current.key !== runKey;
    setState((previous) => (previous.key === runKey ? { ...previous, saving: true } : previous));
    void (async () => {
      try {
        let view: StoredView | undefined;
        while (pending()) {
          const { saved, shown } = live.current;
          if (saved === undefined) return;
          if (q.contents) {
            q.contents = false;
            view = await replaceViewContents(modelId, viewId, {
              version: saved.version,
              elementIds: [...shown.elementIds],
              relationshipIds: [...shown.relationshipIds],
            });
          } else {
            const inView = new Set(saved.elementIds);
            const cards = (q.layout ?? []).filter((card) => inView.has(card.elementId));
            q.layout = undefined;
            view = await replaceViewLayout(modelId, viewId, { version: saved.version, cards });
          }
          if (stale()) return;
          live.current.saved = view;
        }
        if (view === undefined) return;
        live.current.shown = contentsOf(view);
        const done = view;
        setState((previous) =>
          previous.key === runKey
            ? {
                ...previous,
                view: done,
                contents: contentsOf(done),
                saving: false,
                savedCount: previous.savedCount + 1,
              }
            : previous,
        );
      } catch (error: unknown) {
        if (stale()) return;
        const status = error instanceof ApiRequestError ? error.status : 0;
        const problem: ViewProblem =
          status === 409
            ? 'conflict'
            : status === 404
              ? 'deleted'
              : status === 422
                ? 'rejected'
                : 'failed';
        // Back to what is stored.
        const back = contentsOf(live.current.saved);
        live.current.shown = back;
        setState((previous) =>
          previous.key === runKey
            ? { ...previous, contents: back, saving: false, problem }
            : previous,
        );
      } finally {
        if (!stale()) Object.assign(q, idleQueue());
      }
    })();
  }, [modelId, viewId]);

  const blocked = current.problem === 'conflict' || current.problem === 'deleted';
  const change = useCallback(
    (next: (contents: ViewContents) => ViewContents | undefined): boolean => {
      if (live.current.saved === undefined || blocked) return false;
      const contents = next(live.current.shown);
      if (contents === undefined) return false;
      live.current.shown = contents;
      const changeKey = live.current.key;
      setState((previous) =>
        previous.key === changeKey ? { ...previous, contents, problem: undefined } : previous,
      );
      queue.current.contents = true;
      run();
      return true;
    },
    [blocked, run],
  );

  const saveLayout = useCallback(
    (cards: readonly ViewCardLayout[]): boolean => {
      if (live.current.saved === undefined || blocked) return false;
      queue.current.layout = cards;
      const layoutKey = live.current.key;
      setState((previous) =>
        previous.key === layoutKey && previous.problem !== undefined
          ? { ...previous, problem: undefined }
          : previous,
      );
      run();
      return true;
    },
    [blocked, run],
  );

  const adopt = useCallback((next: (contents: ViewContents) => ViewContents, version?: number) => {
    const { saved } = live.current;
    if (saved === undefined) return;
    const kept = next(contentsOf(saved));
    const follows = version !== undefined && version === saved.version + 1;
    const view = {
      ...saved,
      elementIds: [...kept.elementIds],
      relationshipIds: [...kept.relationshipIds],
      ...(follows ? { version } : {}),
    };
    live.current.saved = view;
    live.current.shown = next(live.current.shown);
    const shown = live.current.shown;
    const adoptKey = live.current.key;
    setState((previous) =>
      previous.key === adoptKey
        ? {
            ...previous,
            contents: shown,
            ...(follows && previous.view
              ? { view: { ...previous.view, version: view.version } }
              : {}),
          }
        : previous,
    );
  }, []);

  const reload = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  const renamed = useCallback((summary: ViewSummary) => {
    const { saved } = live.current;
    if (saved === undefined) return;
    const view = { ...saved, name: summary.name, version: summary.version };
    live.current.saved = view;
    const renameKey = live.current.key;
    setState((previous) => (previous.key === renameKey ? { ...previous, view } : previous));
  }, []);

  const dismiss = useCallback(() => {
    setState((previous) => ({ ...previous, problem: undefined }));
  }, []);

  return {
    load: viewId === undefined ? { status: 'loading' } : current.load,
    view: current.view,
    contents: current.contents,
    saving: current.saving,
    savedCount: current.savedCount,
    problem: current.problem,
    change,
    saveLayout,
    adopt,
    reload,
    renamed,
    dismiss,
  };
}

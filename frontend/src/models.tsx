import type { ModelSummary } from '@simplearchitecture/shared';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiRequestError, listModels } from './api';

export type ModelList =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; models: ModelSummary[] }
  | { status: 'error'; message: string };

interface ModelsValue {
  list: ModelList;
  /** Whether elements can be edited on this server (Modelling); undefined until the list loads. */
  editable: boolean | undefined;
  /** Loads the list if it hasn't been loaded yet. */
  ensureLoaded: () => void;
  reload: () => void;
  /** A model was imported: put it first, as the API would. */
  added: (model: ModelSummary) => void;
  /** A model was deleted (or turned out to be gone already). */
  removed: (id: string) => void;
}

const ModelsContext = createContext<ModelsValue | null>(null);

/**
 * The stored models, shared by the header's model picker and the Models page, so both update
 * together after an import or delete without a reload. Loaded on first use (Viewing only).
 */
export function ModelsProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<ModelList>({ status: 'idle' });
  const [editable, setEditable] = useState<boolean | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setList((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
    listModels(current.signal)
      .then(({ models, editable: canEdit }) => {
        if (current.signal.aborted) return;
        setList({ status: 'ready', models });
        setEditable(canEdit);
      })
      .catch((error: unknown) => {
        if (current.signal.aborted) return;
        setList({
          status: 'error',
          message: error instanceof ApiRequestError ? error.message : 'Unknown error',
        });
      });
  }, []);

  /** The list was asked for (by the first useModels), so later users don't ask again. */
  const loaded = useRef(false);

  // On unmount, stop the request and forget that it was asked for. React's StrictMode (in
  // development) unmounts and mounts again at once: the second mount must ask again, or the list
  // stays on "loading" for ever.
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
      loaded.current = false;
    },
    [],
  );

  const ensureLoaded = useCallback(() => {
    if (loaded.current) return;
    loaded.current = true;
    reload();
  }, [reload]);

  const added = useCallback((model: ModelSummary) => {
    setList((previous) =>
      previous.status === 'ready'
        ? { status: 'ready', models: [model, ...previous.models.filter((m) => m.id !== model.id)] }
        : previous,
    );
  }, []);

  const removed = useCallback((id: string) => {
    setList((previous) =>
      previous.status === 'ready'
        ? { status: 'ready', models: previous.models.filter((m) => m.id !== id) }
        : previous,
    );
  }, []);

  const value = useMemo(
    () => ({ list, editable, ensureLoaded, reload, added, removed }),
    [list, editable, ensureLoaded, reload, added, removed],
  );
  return <ModelsContext value={value}>{children}</ModelsContext>;
}

/** The stored models; loads them on first use. */
export function useModels(): ModelsValue {
  const value = use(ModelsContext);
  if (!value) throw new Error('useModels used outside ModelsProvider');
  const { ensureLoaded } = value;
  useEffect(() => {
    ensureLoaded();
  }, [ensureLoaded]);
  return value;
}

import type {
  ElementPropertyDefinition,
  JgfDocument,
  RelationshipPropertyDefinition,
} from '@simplearchitecture/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, getModel, listProperties, type DefinedPropertyLists } from '../../api';

/** Shown when a model arrives but can't be read: never the browser's own error text. */
export const unreadableModelMessage =
  "The model's data isn't in a form the explorer can read. It may be damaged.";

export type Load =
  | { status: 'loading' }
  | { status: 'ready'; document: JgfDocument }
  | { status: 'missing' }
  | { status: 'failed'; message: string };

/** The model, its retry, and an update for changes the server accepted (Modelling). */
export function useModelDocument(
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

export type PropertiesLoad = 'loading' | 'failed' | DefinedPropertyLists;

export const noProperties: readonly RelationshipPropertyDefinition[] = [];
export const noElementProperties: readonly ElementPropertyDefinition[] = [];

/**
 * The properties an Admin defined for relationships and for elements, read with the model (and
 * again on `reload`, after a save refused a property that is gone).
 */
export function useDefinedProperties(modelId: string): [PropertiesLoad, () => void] {
  const [load, setLoad] = useState<PropertiesLoad>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    listProperties(controller.signal)
      .then((properties) => {
        setLoad(properties);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad('failed');
      });
    return () => {
      controller.abort();
    };
  }, [modelId, attempt]);
  const reload = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);
  return [load, reload];
}

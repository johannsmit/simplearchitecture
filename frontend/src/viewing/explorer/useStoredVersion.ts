import type { ElementChangeResult, JgfDocument } from '@simplearchitecture/shared';
import { useCallback, useEffect, useState } from 'react';
import { getElement } from '../../api';
import { withNode } from '../../modelling/document';

/**
 * Modelling: the selected element's version, read from the server for the next save or delete,
 * and `onStored` for an element the server has saved.
 */
export function useStoredVersion(
  editable: boolean,
  modelId: string,
  selectedId: string | undefined,
  selectedKnown: boolean,
  updateDocument: (change: (document: JgfDocument) => JgfDocument) => void,
) {
  const [stored, setStored] = useState<{ id: string; version: number } | null>(null);
  const version = stored !== null && stored.id === selectedId ? stored.version : undefined;
  useEffect(() => {
    if (!editable || selectedId === undefined || !selectedKnown) return;
    const controller = new AbortController();
    getElement(modelId, selectedId, controller.signal)
      .then((result) => {
        setStored({ id: result.element.id, version: result.element.version });
        // The server's copy wins (it may be newer); an open form with changes keeps them.
        updateDocument((current) => withNode(current, result.element.id, result.element.node));
      })
      .catch(() => {
        // The form reads it again when it saves, and reports what went wrong there.
      });
    return () => {
      controller.abort();
    };
  }, [editable, modelId, selectedId, selectedKnown, updateDocument]);

  const onStored = useCallback(
    (result: ElementChangeResult) => {
      setStored({ id: result.element.id, version: result.element.version });
      updateDocument((current) => withNode(current, result.element.id, result.element.node));
    },
    [updateDocument],
  );
  /** The version read for an element, if it was the last one read or saved. */
  const versionOf = (id: string) =>
    stored !== null && stored.id === id ? stored.version : undefined;
  return { version, versionOf, onStored };
}

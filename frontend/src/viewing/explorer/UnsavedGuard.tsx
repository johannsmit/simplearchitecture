import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { UnsavedDialog } from '../../modelling/dialogs';
import type { EditorHandle, EditorState } from '../../modelling/ElementEditor';
import { readExplorerView, type ExplorerView } from '../paths';

/** Asks before unsaved changes are dropped; runs `proceed` when they may be. */
export type Ask = (proceed: () => void, keep?: () => void) => void;

interface Shown {
  modelId: string;
  elementId: string | undefined;
  viewId: string | undefined;
  url: string;
  view: ExplorerView;
}

/** What the guard lets the explorer show, and its hold on the explorer's unsaved changes. */
export interface Guarded {
  url: string;
  modelId: string;
  elementId: string | undefined;
  viewId: string | undefined;
  ask: Ask;
  editor: RefObject<EditorHandle | null>;
  onEditorState: (state: EditorState | null) => void;
}

/**
 * Holds unsaved changes in the editing form. The explorer shows the
 * element the guard lets through: when the address moves on (a card, a crumb, browser Back)
 * while the form has changes, the explorer stays where it is and asks first; Keep editing puts
 * the address back. Links out of the explorer and closing the tab ask too.
 */
export function UnsavedGuard(props: {
  modelId: string;
  elementId: string | undefined;
  viewId: string | undefined;
  /** The explorer, for what the guard lets through. */
  children: (guarded: Guarded) => ReactNode;
}) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const url = `${pathname}${search}`;
  const view = readExplorerView(new URLSearchParams(search)).view;
  const [shown, setShown] = useState<Shown>({
    modelId: props.modelId,
    elementId: props.elementId,
    viewId: props.viewId,
    url,
    view,
  });
  const [editorState, setEditorState] = useState<EditorState | null>(null);
  const dirty = editorState?.dirty === true;
  // Read by `ask` at once, so a click replayed right after a catalog cell saved isn't asked
  // about changes that are already saved.
  const dirtyNow = useRef(false);
  const reportState = useCallback((state: EditorState | null) => {
    dirtyNow.current = state?.dirty === true;
    setEditorState(state);
  }, []);
  const setClean = () => {
    dirtyNow.current = false;
    setEditorState((current) => current && { ...current, dirty: false });
  };
  const [dialog, setDialog] = useState<{ proceed: () => void; keep?: () => void } | null>(null);
  const [saving, setSaving] = useState(false);
  const editor = useRef<EditorHandle | null>(null);

  const ask = useCallback<Ask>((proceed, keep) => {
    if (dirtyNow.current) setDialog({ proceed, ...(keep ? { keep } : {}) });
    else proceed();
  }, []);

  // The address the user chose to stay away from (Keep editing), until the address is put back.
  const [held, setHeld] = useState<string | null>(null);
  if (held !== null && url !== held) setHeld(null);

  // The address moved: follow it, or (with changes) hold it and ask. Adjusted while rendering.
  if (shown.url !== url && dialog === null && url !== held) {
    // An open catalog cell is dropped by a view change too; the details form stays with it.
    const moved =
      shown.modelId !== props.modelId ||
      shown.elementId !== props.elementId ||
      shown.viewId !== props.viewId ||
      (editorState?.cell === true && shown.view !== view);
    const next = {
      modelId: props.modelId,
      elementId: props.elementId,
      viewId: props.viewId,
      url,
      view,
    };
    if (!moved || !dirty) setShown(next);
    else {
      setDialog({
        proceed: () => {
          setShown(next);
        },
        keep: () => {
          setHeld(url);
          void navigate(shown.url, { replace: true });
        },
      });
    }
  }

  // Links out of the explorer (space switcher, model picker, any page) while there are changes.
  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest('a[href]');
      if (!(link instanceof HTMLAnchorElement) || link.target === '_blank' || link.download) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin) return;
      const path = `${target.pathname}${target.search}`;
      if (path === `${window.location.pathname}${window.location.search}`) return;
      event.preventDefault();
      event.stopPropagation();
      setDialog({
        proceed: () => {
          void navigate(path);
        },
      });
    };
    const onUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [dirty, navigate]);

  const close = () => {
    setDialog(null);
  };

  return (
    <>
      {props.children({
        url: shown.url,
        modelId: shown.modelId,
        elementId: shown.elementId,
        viewId: shown.viewId,
        ask,
        editor,
        onEditorState: reportState,
      })}
      {dialog && (
        <UnsavedDialog
          kind="leave"
          name={editorState?.name ?? ''}
          subject={editorState?.subject ?? 'element'}
          saving={saving}
          canSave={editorState?.canSave ?? false}
          onKeep={() => {
            close();
            dialog.keep?.();
          }}
          onDiscard={() => {
            editor.current?.discard();
            setClean();
            close();
            dialog.proceed();
          }}
          onSave={() => {
            setSaving(true);
            void (editor.current?.save() ?? Promise.resolve(true)).then((ok) => {
              setSaving(false);
              close();
              if (ok) {
                setClean();
                dialog.proceed();
              } else {
                dialog.keep?.();
              }
            });
          }}
        />
      )}
    </>
  );
}

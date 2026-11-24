import { useCallback, useImperativeHandle, useRef, type RefObject } from 'react';
import type { EditorHandle, EditorState } from '../../modelling/ElementEditor';

/**
 * Two places can hold unsaved changes: the details panel's form and an open catalog cell. The
 * guard sees the cell while it has changes, else the form; `editor` saves or discards that one.
 */
export function useEditorBridge(
  editor: RefObject<EditorHandle | null>,
  onEditorState: (state: EditorState | null) => void,
) {
  // Passed on at once (not in an effect), so the guard never asks about changes just saved.
  const panelEditor = useRef<EditorHandle | null>(null);
  const cellEditor = useRef<EditorHandle | null>(null);
  const panelStateNow = useRef<EditorState | null>(null);
  const cellStateNow = useRef<EditorState | null>(null);
  const cellActive = () => cellStateNow.current?.dirty === true;
  const setPanelState = useCallback(
    (state: EditorState | null) => {
      panelStateNow.current = state;
      onEditorState(cellStateNow.current?.dirty === true ? cellStateNow.current : state);
    },
    [onEditorState],
  );
  const setCellState = useCallback(
    (state: EditorState | null) => {
      cellStateNow.current = state;
      onEditorState(state?.dirty === true ? state : panelStateNow.current);
    },
    [onEditorState],
  );
  useImperativeHandle(editor, () => {
    const active = () => (cellActive() ? cellEditor : panelEditor).current;
    const state = () => (cellActive() ? cellStateNow : panelStateNow).current;
    return {
      save: () => active()?.save() ?? Promise.resolve(true),
      discard: () => {
        active()?.discard();
      },
      get name() {
        return state()?.name ?? '';
      },
      get canSave() {
        return state()?.canSave ?? false;
      },
      get failed() {
        return active()?.failed;
      },
    };
  }, []);
  return { panelEditor, cellEditor, setPanelState, setCellState };
}

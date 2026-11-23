import {
  relationshipsOf,
  type CatalogTab,
  type ElementChangeResult,
  type JgfDocument,
  type ModelGraph,
} from '@simplearchitecture/shared';
import type { NavigateFunction } from 'react-router';
import { withoutElement } from '../../modelling/document';
import type { EditorState } from '../../modelling/ElementEditor';
import {
  elementPath,
  explorerSearch,
  modelPath,
  type ExplorerSpace,
  type ExplorerView,
} from '../paths';
import type { OpenView } from './useOpenView';
import { withoutDeleted } from './views';

interface ElementChangeOptions {
  modelId: string;
  space: ExplorerSpace;
  graph: ModelGraph | undefined;
  elementId: string | undefined;
  inView: boolean;
  view: ExplorerView;
  params: URLSearchParams;
  tab: CatalogTab;
  depth: number;
  shownAsked: readonly string[];
  groupAsked: string | undefined;
  /** The elements focused before, for going back after a delete. */
  trail: readonly string[];
  selectionKey: string;
  openView: OpenView;
  navigate: NavigateFunction;
  updateDocument: (change: (document: JgfDocument) => JgfDocument) => void;
  reloadModels: () => void;
  onStored: (result: ElementChangeResult) => void;
  setPanelState: (state: EditorState | null) => void;
  setPicked: (picked: { key: string; id: string } | null) => void;
  setSelection: (selection: null) => void;
  setHeadingFocusFor: (id: string) => void;
  setNameFocusFor: (id: string) => void;
  addElement: (id: string) => void;
  addNewToView: (id: string) => void;
  announce: (text: string) => void;
}

/**
 * What follows an element the server created or deleted (Modelling): the model, the open view,
 * the selection, where the explorer goes, and what is announced.
 */
export function useElementChanges({
  modelId,
  space,
  graph,
  elementId,
  inView,
  view,
  params,
  tab,
  depth,
  shownAsked,
  groupAsked,
  trail,
  selectionKey,
  openView,
  navigate,
  updateDocument,
  reloadModels,
  onStored,
  setPanelState,
  setPicked,
  setSelection,
  setHeadingFocusFor,
  setNameFocusFor,
  addElement,
  addNewToView,
  announce,
}: ElementChangeOptions) {
  /** A catalog cell found the element deleted by someone else: it leaves the model. */
  /** An element deleted from the model: the server took it out of every view already. */
  const pruneElement = (id: string) => {
    if (!inView || !graph) return;
    const relationshipIds = relationshipsOf(graph, id).map((r) => r.id);
    openView.adopt((current) => withoutDeleted(current, { elementIds: [id], relationshipIds }));
  };
  const onGone = (id: string) => {
    pruneElement(id);
    updateDocument((current) => withoutElement(current, id));
    reloadModels();
    setPicked(null);
    if (id === elementId) {
      void navigate(`${modelPath(modelId, space)}${explorerSearch(params, 'catalog', tab)}`);
    }
  };

  const onCreated = (result: ElementChangeResult) => {
    onStored(result);
    reloadModels();
    setNameFocusFor(result.element.id);
    const name = result.element.node.label ?? '';
    announce(`Created “${name}”. Add details, then Save.`);
    // The catalog stays and selects the new row (it moves to its type's tab itself). An open
    // view stays too, with the new element added to it.
    if (view === 'catalog') setPicked({ key: selectionKey, id: result.element.id });
    else if (inView) {
      addNewToView(result.element.id);
      setPicked({ key: selectionKey, id: result.element.id });
    } else
      void navigate(elementPath(modelId, result.element.id, depth, space, shownAsked, groupAsked));
  };

  const onRemoved = (id: string) => {
    setPanelState(null);
    pruneElement(id);
    updateDocument((current) => withoutElement(current, id));
    reloadModels();
    setPicked(null);
    // An open view stays open, without the element.
    if (inView) {
      setSelection(null);
      document.getElementById('canvas')?.focus();
      return;
    }
    // The catalog stays; it selects the next row itself.
    if (view === 'catalog') {
      if (id === elementId)
        void navigate(`${modelPath(modelId, space)}${explorerSearch(params, 'catalog', tab)}`);
      return;
    }
    // A selected element that wasn't the focus: the panel goes back to the focus element.
    if (id !== elementId && elementId !== undefined) {
      setHeadingFocusFor(elementId);
      return;
    }
    // Back to the previous element in the trail.
    const previous = trail.filter((other) => other !== id).at(-1);
    if (previous !== undefined) {
      setHeadingFocusFor(previous);
      void navigate(elementPath(modelId, previous, depth, space, shownAsked, groupAsked));
    } else {
      void navigate(`${modelPath(modelId, space)}${explorerSearch(params, 'canvas')}`);
      requestAnimationFrame(() => {
        const row = window.document.querySelector<HTMLElement>(
          '.tree-panel [role="treeitem"][tabindex="0"], .tree-panel .new-btn',
        );
        row?.focus();
      });
    }
  };

  /** An element made on the canvas: it joins the canvas, or the open view. */
  const onCanvasElementCreated = (result: ElementChangeResult) => {
    onStored(result);
    reloadModels();
    if (inView) addNewToView(result.element.id);
    else addElement(result.element.id);
    announce(`Created “${result.element.node.label ?? ''}”.`);
  };

  return { onGone, onCreated, onRemoved, onCanvasElementCreated };
}

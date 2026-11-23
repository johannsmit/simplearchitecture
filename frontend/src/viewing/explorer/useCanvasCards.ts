import {
  withoutElements,
  type AddedNeighbourhood,
  type ModelElement,
  type ModelGraph,
} from '@simplearchitecture/shared';
import { useState } from 'react';
import { counted, formatNumber } from '../../words';
import type { OpenView } from './useOpenView';
import type { Ask } from './UnsavedGuard';
import {
  viewCap,
  viewHood,
  withElementInView,
  withoutElementInView,
  type ViewContents,
} from './views';

interface CanvasCardsOptions {
  graph: ModelGraph | undefined;
  /** The focused element, when it is in the model. */
  element: ModelElement | undefined;
  inView: boolean;
  viewEditable: boolean;
  viewBlocked: boolean;
  openView: OpenView;
  /** What the canvas shows, and the cards with a remove button. */
  hood: AddedNeighbourhood | undefined;
  onCanvas: ReadonlySet<string>;
  removableIds: ReadonlySet<string>;
  nest: boolean;
  selectedId: string | undefined;
  hasOwnId: (relationshipId: string) => boolean;
  focusElement: (id: string) => void;
  selectElement: (id: string) => void;
  addElement: (id: string) => void;
  takeOffCanvas: (id: string) => void;
  requestArrange: () => void;
  ask: Ask;
  /** The selection goes (with the Add relationship box) when its card leaves. */
  clearSelection: () => void;
  announce: (text: string) => void;
}

/**
 * Adding cards (New element's Add to canvas, a row dropped on the canvas, or Shift+Enter on it)
 * and taking them off: on a focus canvas the card joins it or leaves it; in an open view the
 * element is added to the view or taken out of it, and the view saved at once.
 */
export function useCanvasCards({
  graph,
  element,
  inView,
  viewEditable,
  viewBlocked,
  openView,
  hood,
  onCanvas,
  removableIds,
  nest,
  selectedId,
  hasOwnId,
  focusElement,
  selectElement,
  addElement,
  takeOffCanvas,
  requestArrange,
  ask,
  clearSelection,
  announce,
}: CanvasCardsOptions) {
  // New element's "Add to canvas": nothing is created; the focus stays the same.
  const [reveal, setReveal] = useState<{ id: string; n: number } | undefined>(undefined);
  // Also a row dropped on the canvas, or Shift+Enter on it.
  const bringElement = (id: string) => {
    const name = graph?.elements.get(id)?.name || '(unnamed)';
    if (inView) {
      addToView(id);
      return;
    }
    if (element === undefined) {
      focusElement(id);
      return;
    }
    if (onCanvas.has(id)) {
      selectElement(id);
      setReveal((current) => ({ id, n: (current?.n ?? 0) + 1 }));
      announce(`${name} is on the canvas.`);
      return;
    }
    // The canvas places the card (with its container chain) where it was dropped or asked for.
    addElement(id);
    announce(`Added “${name}” to the canvas.`);
  };

  // Changing an open view (Modelling): each change is saved at once.
  const [viewFull, setViewFull] = useState<string | null>(null);
  const viewFullText = `The view is full (${formatNumber(viewCap)} elements). Remove a card to make room.`;
  /** Add to canvas in a view: the element, with its relationships to elements in the view. */
  function addToView(id: string) {
    if (!graph) return;
    const name = graph.elements.get(id)?.name || '(unnamed)';
    if (!viewEditable) {
      announce('Views can be changed in Modelling.');
      return;
    }
    if (onCanvas.has(id)) {
      selectElement(id);
      setReveal((current) => ({ id, n: (current?.n ?? 0) + 1 }));
      announce(`${name} is on the canvas.`);
      return;
    }
    if (viewBlocked) {
      announce('Reload the view first.');
      return;
    }
    if (onCanvas.size >= viewCap) {
      setViewFull(viewFullText);
      announce(viewFullText);
      return;
    }
    let added: { contents: ViewContents; relationships: number } | undefined;
    const changed = openView.change((current) => {
      added = withElementInView(graph, current, id, hasOwnId);
      return added?.contents;
    });
    if (!changed || added === undefined) return;
    requestArrange();
    setViewFull(null);
    const count = added.relationships;
    announce(
      `Added “${name}” to the view${count > 0 ? `, with ${counted(count, 'relationship')}` : ''}.`,
    );
  }
  /** A new element made in a view: added to it (it has no relationships yet). */
  function addNewToView(id: string) {
    if (onCanvas.size >= viewCap) {
      setViewFull(viewFullText);
      return;
    }
    const changed = openView.change((current) =>
      current.elementIds.includes(id)
        ? undefined
        : { ...current, elementIds: [...current.elementIds, id] },
    );
    if (changed) requestArrange();
  }

  /**
   * The remove button on a card: takes it off the canvas (visual only), or out of the open view
   * (saved at once), with the cards drawn inside it. The element stays in the model. The
   * selection only goes when it was on a card that leaves, and only then are unsaved changes asked
   * about.
   */
  const removeCard = (id: string) => {
    if (!graph || !hood || !removableIds.has(id)) return;
    const name = graph.elements.get(id)?.name || '(unnamed)';
    const after = inView
      ? viewHood(graph, withoutElementInView(graph, openView.contents, id, nest))
      : withoutElements(graph, hood, [id], { nest });
    const takesSelection = selectedId !== undefined && !after.hops.has(selectedId);
    const apply = () => {
      if (inView) {
        if (openView.change((current) => withoutElementInView(graph, current, id, nest))) {
          requestArrange();
        }
        setViewFull(null);
      } else {
        takeOffCanvas(id);
      }
      if (takesSelection) clearSelection();
      announce(`Removed “${name}” from the ${inView ? 'view' : 'canvas'}. It stays in the model.`);
      // The button goes with its card: keep keyboard focus on the canvas, never on <body>.
      document.getElementById('canvas')?.focus();
    };
    if (takesSelection) ask(apply);
    else apply();
  };

  return { reveal, viewFull, bringElement, addToView, addNewToView, removeCard };
}

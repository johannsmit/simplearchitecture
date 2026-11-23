import type { ModelGraph } from '@simplearchitecture/shared';
import { useCallback, useState } from 'react';
import { useLocation } from 'react-router';
import type { Panel } from './usePanel';
import type { Ask } from './UnsavedGuard';

interface SelectionOptions {
  graph: ModelGraph | undefined;
  /** Changes when the focus changes, or another view opens: the selection goes with it. */
  selectionKey: string;
  elementId: string | undefined;
  inView: boolean;
  ask: Ask;
  details: Panel;
  focusElement: (id: string) => void;
  showLines: (on: boolean) => void;
}

/**
 * The selected element (single click), shown in the details panel, apart from the focus element
 * (double click: the canvas, the breadcrumbs and the URL); the relationship open in the details
 * panel; the Add relationship box; and where keyboard focus goes next in the panel.
 */
export function useSelection({
  graph,
  selectionKey,
  elementId,
  inView,
  ask,
  details,
  focusElement,
  showLines,
}: SelectionOptions) {
  const location = useLocation();
  // After following a relationship in the details panel, focus goes to the new element's name.
  const [headingFocusFor, setHeadingFocusFor] = useState<string | null>(null);
  const clearHeadingFocus = useCallback(() => {
    setHeadingFocusFor(null);
  }, []);

  // The selected element is the focus element until another is picked, and goes back to it when
  // the focus changes.
  const [picked, setPicked] = useState<{ key: string; id: string } | null>(null);
  const pickedId =
    picked !== null && picked.key === selectionKey && graph?.elements.has(picked.id) === true
      ? picked.id
      : undefined;
  const selectedId = pickedId ?? elementId;
  const selected = graph && selectedId !== undefined ? graph.elements.get(selectedId) : undefined;

  const [nameFocusFor, setNameFocusFor] = useState<string | null>(null);
  const clearNameFocus = useCallback(() => {
    setNameFocusFor(null);
  }, []);

  // The relationship open in the details panel (dropped when the focus changes), and the Add
  // relationship box.
  const [selection, setSelection] = useState<{ key: string; id: string } | null>(null);
  const selectedRelationshipId =
    selection !== null && selection.key === selectionKey ? selection.id : undefined;
  const selectedRelationship =
    graph && selectedRelationshipId !== undefined
      ? graph.relationships.find((r) => r.id === selectedRelationshipId)
      : undefined;
  const [relHeadingFocus, setRelHeadingFocus] = useState(false);
  const clearRelHeadingFocus = useCallback(() => {
    setRelHeadingFocus(false);
  }, []);
  const [addBoxFor, setAddBoxFor] = useState<string | null>(null);
  const addBoxOpen = addBoxFor !== null && addBoxFor === selectedId;

  const openRelationship = (id: string) => {
    ask(() => {
      // In a view no card is selected at first: the line's source is, so the panel can show.
      const source = graph?.relationships.find((r) => r.id === id)?.source;
      if (inView && selectedId === undefined && source !== undefined) {
        setPicked({ key: selectionKey, id: source });
      }
      setSelection({ key: selectionKey, id });
      setRelHeadingFocus(true);
      if (!details.open) details.toggle();
    });
  };
  const deselect = () => {
    if (selectedRelationshipId === undefined) return;
    ask(() => {
      setSelection(null);
      if (selectedId !== undefined) setHeadingFocusFor(selectedId);
    });
  };
  /** A single click on a card or list row: the details panel shows it; the canvas stays. */
  const selectElement = (id: string, then?: () => void) => {
    if (id === selectedId && selectedRelationshipId === undefined) {
      if (then) ask(then);
      return;
    }
    ask(() => {
      setPicked({ key: selectionKey, id });
      setSelection(null);
      setAddBoxFor(null);
      then?.();
    });
  };
  /** A link to an element in the details panel: back to it when selected, else it is focused. */
  const followElement = (id: string) => {
    if (id === selectedId) {
      deselect();
    } else if (id === elementId) {
      ask(() => {
        setPicked(null);
        setSelection(null);
        setHeadingFocusFor(id);
      });
    } else {
      setHeadingFocusFor(id);
      focusElement(id);
    }
  };

  // "Open in Modelling" on a relationship in Viewing: the relationship (and the element it was
  // opened from) come along in the history entry's state, not in the URL. Once per entry; adjusted
  // while rendering.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const opened = location.state as { relationship?: unknown; element?: unknown } | null;
  if (typeof opened?.relationship === 'string' && openedFor !== location.key) {
    setOpenedFor(location.key);
    if (typeof opened.element === 'string') setPicked({ key: selectionKey, id: opened.element });
    setSelection({ key: selectionKey, id: opened.relationship });
    setRelHeadingFocus(true);
  }

  const addRelationshipFrom = (id: string) => {
    ask(() => {
      setSelection(null);
      // The element is selected (the canvas stays), not focused.
      setPicked({ key: selectionKey, id });
      setAddBoxFor(id);
      showLines(true);
      if (!details.open) details.toggle();
    });
  };

  return {
    headingFocusFor,
    setHeadingFocusFor,
    clearHeadingFocus,
    setPicked,
    selectedId,
    selected,
    nameFocusFor,
    setNameFocusFor,
    clearNameFocus,
    setSelection,
    selectedRelationship,
    relHeadingFocus,
    clearRelHeadingFocus,
    addBoxOpen,
    setAddBoxFor,
    openRelationship,
    deselect,
    selectElement,
    followElement,
    addRelationshipFrom,
  };
}

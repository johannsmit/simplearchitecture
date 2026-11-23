import { useEffect, useRef, useState, type RefObject } from 'react';
import type { NavigateFunction } from 'react-router';
import { readViewsOpen, writeViewsOpen } from './prefs';
import type { Panel } from './usePanel';

export type ViewDialogName = 'save' | 'rename' | 'delete';

/**
 * Views in the left panel, and the view bar: the Views section's open state, its refresh after a
 * change, the view dialog open, and where keyboard focus goes after one.
 */
export function useViewPanel(url: string, tree: Panel, navigate: NavigateFunction) {
  const viewsHeader = useRef<HTMLButtonElement>(null);
  const saveViewButton = useRef<HTMLButtonElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  const [viewsOpen, setViewsOpen] = useState(readViewsOpen);
  const [viewsRefresh, setViewsRefresh] = useState(0);
  const [viewHeadingFocus, setViewHeadingFocus] = useState(false);
  const [viewDialog, setViewDialog] = useState<ViewDialogName | null>(null);
  const toggleViews = () => {
    setViewsOpen(!viewsOpen);
    writeViewsOpen(!viewsOpen);
  };
  /** After the page has drawn: focus on `target`, or on the canvas area when it isn't there. */
  const focusInPanel = (target: RefObject<HTMLButtonElement | null>) => {
    requestAnimationFrame(() => {
      if (target.current?.isConnected === true) target.current.focus();
      else document.getElementById('canvas')?.focus();
    });
  };
  const focusViewsHeader = () => {
    focusInPanel(viewsHeader);
  };
  // Leaving a view for the start page (Close view, Delete view): focus goes to the Views header,
  // or to the start page's canvas area with the panel hidden. Only once that page is drawn: the
  // address changes in a transition, so a frame can come before it and find the view's canvas.
  const focusOnArrival = useRef<string | null>(null);
  const leaveViewFor = (path: string, replace = false) => {
    focusOnArrival.current = path;
    void navigate(path, replace ? { replace: true } : undefined);
  };
  useEffect(() => {
    const path = focusOnArrival.current;
    if (path === null) return;
    // Any move clears it; only arriving at the start page asked for takes the focus.
    focusOnArrival.current = null;
    if (url !== path) return;
    if (viewsHeader.current?.isConnected === true) viewsHeader.current.focus();
    else document.getElementById('canvas')?.focus();
  }, [url]);
  /** "All views" on the start page: the panel shows, with Views open and focus on its header. */
  const showAllViews = () => {
    if (!tree.open) tree.toggle();
    if (!viewsOpen) {
      setViewsOpen(true);
      writeViewsOpen(true);
    }
    focusViewsHeader();
  };
  /** A view was saved, renamed or deleted: the lists of views are read again. */
  const refreshViews = () => {
    setViewsRefresh((n) => n + 1);
  };
  return {
    viewsHeader,
    saveViewButton,
    renameButton,
    viewsOpen,
    toggleViews,
    viewsRefresh,
    refreshViews,
    viewHeadingFocus,
    setViewHeadingFocus,
    viewDialog,
    setViewDialog,
    focusInPanel,
    leaveViewFor,
    showAllViews,
  };
}

export type ViewPanel = ReturnType<typeof useViewPanel>;

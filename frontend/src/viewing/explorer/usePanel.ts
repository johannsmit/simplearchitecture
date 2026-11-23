import { useState } from 'react';
import {
  panels,
  readPanelOpen,
  readPanelWidth,
  writePanelOpen,
  writePanelWidth,
  type PanelName,
} from './prefs';

/** A side panel's open state and width, remembered in this browser. */
export function usePanel(panel: PanelName) {
  const [open, setOpen] = useState(() => readPanelOpen(panel));
  const [width, setWidth] = useState(() => readPanelWidth(panel));
  return {
    open,
    width,
    toggle: () => {
      setOpen(!open);
      writePanelOpen(panel, !open);
    },
    resize: (next: number, done: boolean) => {
      setWidth(next);
      if (done) writePanelWidth(panel, next);
    },
    reset: () => {
      setWidth(panels[panel].fallback);
      writePanelWidth(panel, null);
    },
  };
}

export type Panel = ReturnType<typeof usePanel>;

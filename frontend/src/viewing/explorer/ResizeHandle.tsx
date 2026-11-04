import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { panels, type PanelName } from './prefs';

const keyboardStep = 16;

interface ResizeHandleProps {
  panel: PanelName;
  width: number;
  /** Called while resizing; `done` is true when the width should be remembered. */
  onWidth: (width: number, done: boolean) => void;
  onReset: () => void;
}

/**
 * Drag handle on a panel's inner edge. Arrow keys move the edge 16px; Enter or a
 * double-click goes back to the default width.
 */
export function ResizeHandle({ panel, width, onWidth, onReset }: ResizeHandleProps) {
  const spec = panels[panel];
  // Moving right widens the left panel but narrows the right one.
  const direction = panel === 'tree' ? 1 : -1;
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);
  const clamp = (value: number) => Math.min(spec.max, Math.max(spec.min, Math.round(value)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, last: width };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = clamp(drag.current.startWidth + direction * (event.clientX - drag.current.startX));
    drag.current.last = next;
    onWidth(next, false);
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    onWidth(drag.current.last, true);
    drag.current = null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onReset();
      return;
    }
    const step =
      event.key === 'ArrowLeft' ? -keyboardStep : event.key === 'ArrowRight' ? keyboardStep : 0;
    if (step === 0) return;
    event.preventDefault();
    onWidth(clamp(width + direction * step), true);
  };

  return (
    <div
      className={`resize-handle is-${panel}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize the ${spec.name}`}
      aria-valuenow={width}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}

import { useReactFlow, useStore } from '@xyflow/react';
import { Icon } from '../../../icons';
import { reducedMotion } from './canvasModel';

export function ZoomControls({ onFit }: { onFit: () => void }) {
  const flow = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const duration = () => (reducedMotion() ? 0 : 200);
  return (
    <div className="zoom" role="group" aria-label="Zoom">
      <button
        className="icon-btn"
        type="button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={() => void flow.zoomOut({ duration: duration() })}
      >
        <Icon name="minus" />
      </button>
      <output aria-label="Zoom level">{Math.round(zoom * 100)}%</output>
      <button
        className="icon-btn"
        type="button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={() => void flow.zoomIn({ duration: duration() })}
      >
        <Icon name="plus" />
      </button>
      <button
        className="icon-btn"
        type="button"
        aria-label="Fit view"
        title="Fit view"
        onClick={onFit}
      >
        <Icon name="fit" />
      </button>
    </div>
  );
}

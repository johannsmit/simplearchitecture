import { defaultNeighbourhoodCap } from '@simplearchitecture/shared';
import type { RefObject } from 'react';
import { counted, formatNumber } from '../../../words';
import type { ExplorerCanvasProps } from './explorerCanvasProps';
import { GroupByPanel } from './GroupByPanel';
import { LineProperties } from './LineProperties';

interface CanvasTopProps {
  /** The canvas's own props: its panels' choices, notices and what it shows. */
  canvas: ExplorerCanvasProps;
  /** The panels' column: fits and keyboard focus keep cards clear of it. */
  panelsRef: RefObject<HTMLDivElement | null>;
  inView: boolean;
  /** A new canvas waits for ELK. */
  pending: boolean;
  layoutError: string | null;
  /** Keyboard move mode: the card's name, and whether its width can be set. */
  moving: { name: string; resizable: boolean } | null;
}

/**
 * Show Viewpoints and Group by at the top left, always open, in one column; the notices beside it,
 * or under it when there's no room beside it.
 */
export function CanvasTop({
  canvas,
  panelsRef,
  inView,
  pending,
  layoutError,
  moving,
}: CanvasTopProps) {
  const {
    lineFields,
    shownProperties,
    onShownProperties,
    groupChoices,
    groupBy,
    onGroupBy,
    hood,
    depth,
    refused,
    fullText,
    notice,
  } = canvas;
  const capNotice = hood.capped
    ? `Showing ${formatNumber(hood.hops.size)} of ${formatNumber(hood.reachable)} elements.${depth > 1 ? ' Choose a smaller depth to see fewer.' : ''}`
    : null;
  const loneNotice =
    inView || hood.relationships.length > 0 ? null : 'No relationships. This element stands alone.';
  const fullNotice =
    fullText ??
    (refused > 0
      ? `The canvas is full (${formatNumber(defaultNeighbourhoodCap)} elements): ${counted(refused, 'element')} not added. Choose a smaller depth to make room.`
      : null);
  return (
    <div className="canvas-top">
      <div ref={panelsRef} className="canvas-panels">
        <LineProperties fields={lineFields} shown={shownProperties} onChange={onShownProperties} />
        {groupChoices && onGroupBy && (
          <GroupByPanel choices={groupChoices} chosen={groupBy} onChange={onGroupBy} />
        )}
      </div>
      <div className="canvas-notices">
        {(pending || layoutError !== null) && (
          <div className="canvas-overlay" role="status">
            {layoutError === null ? (
              <>
                <span className="spinner" aria-hidden="true" />
                Laying out…
              </>
            ) : (
              layoutError
            )}
          </div>
        )}
        {notice ? (
          <div className="canvas-notice view-notice" role="alert">
            {notice}
          </div>
        ) : moving ? (
          <p className="canvas-notice move-hint">
            Moving &ldquo;<span className="move-name">{moving.name}</span>&rdquo;. Arrow keys move
            it, Shift for bigger steps
            {moving.resizable ? <>, Alt + &larr; &rarr; change its width</> : null}. Enter drops,
            Esc cancels.
          </p>
        ) : (
          (fullNotice ?? capNotice) && (
            <p className="canvas-notice" role="status">
              {fullNotice ?? capNotice}
            </p>
          )
        )}
        {!notice && !moving && !fullNotice && !capNotice && loneNotice && (
          <p className="canvas-notice muted">{loneNotice}</p>
        )}
      </div>
    </div>
  );
}

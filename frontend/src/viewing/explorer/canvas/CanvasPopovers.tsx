import { missingRelatedElements, type ModelGraph } from '@simplearchitecture/shared';
import { useMemo, type Dispatch, type SetStateAction } from 'react';
import { NewElementForm } from '../../../modelling/NewElement';
import { NewRelationshipPopover } from '../../../modelling/relationships';
import type { CanvasPop, Laid, RelatedState } from './canvasModel';
import type { ExplorerCanvasProps } from './explorerCanvasProps';
import type { Point } from './positions';
import { RelatedPopup } from './RelatedPopup';

interface CanvasPopoversProps {
  /** The canvas's own props: the model, and what the page does with what is added. */
  canvas: ExplorerCanvasProps;
  pop: CanvasPop | null;
  editable: boolean;
  nameOf: (id: string) => string;
  isOnCanvas: (id: string) => boolean;
  setPop: Dispatch<SetStateAction<CanvasPop | null>>;
  closePop: (focusSource: boolean) => void;
  focusCardOf: (id: string) => void;
  revealCard: (id: string, focus: boolean) => void;
  /** A new card for this element goes at this point (where the popover was opened). */
  placeAt: (id: string, at: Point) => void;
}

/**
 * The popovers that add to an editable canvas: New relationship (after a line is dropped on a card), and
 * New element (at a point on the canvas, then perhaps the relationship to it).
 */
export function CanvasPopovers(props: CanvasPopoversProps) {
  const { canvas, pop, editable, setPop, closePop, focusCardOf } = props;
  const { modelId, graph } = canvas;
  return (
    <>
      {editable && pop?.kind === 'relationship' && modelId !== undefined && (
        <NewRelationshipPopover
          key={`${pop.source}->${pop.target}`}
          modelId={modelId}
          graph={graph}
          source={pop.source}
          target={pop.target}
          style={{ top: pop.top, left: pop.left }}
          nest={canvas.nest}
          onAdded={(result) => {
            const { source } = pop;
            setPop(null);
            canvas.onRelationshipAdded?.(result);
            focusCardOf(source);
          }}
          onCancel={() => {
            closePop(true);
          }}
          onShow={(id) => {
            setPop(null);
            canvas.onOpenRelationship?.(id);
          }}
        />
      )}
      {editable && pop?.kind === 'element' && modelId !== undefined && (
        <NewElementForm
          modelId={modelId}
          graph={graph}
          defaultType={graph.elements.get(pop.from ?? canvas.focusId)?.type}
          className="canvas-pop"
          style={{ top: pop.top, left: pop.left }}
          hint={
            pop.from === undefined
              ? undefined
              : `Then choose the relationship from ${props.nameOf(pop.from)}.`
          }
          onClose={(focusOpener) => {
            closePop(focusOpener);
          }}
          isOnCanvas={props.isOnCanvas}
          onExisting={(element) => {
            const { at, from, top, left } = pop;
            if (props.isOnCanvas(element.id)) {
              props.revealCard(element.id, from === undefined);
            } else {
              props.placeAt(element.id, at);
              canvas.onBringElement?.(element.id);
              if (from === undefined) focusCardOf(element.id);
            }
            // After a dropped line, the element is the relationship's other end (same rules).
            if (from === undefined) setPop(null);
            else setPop({ kind: 'relationship', source: from, target: element.id, top, left });
          }}
          onCreated={(result) => {
            const { at, from, top, left } = pop;
            props.placeAt(result.element.id, at);
            canvas.onElementCreated?.(result);
            if (from === undefined) {
              setPop(null);
              focusCardOf(result.element.id);
            } else {
              setPop({ kind: 'relationship', source: from, target: result.element.id, top, left });
            }
          }}
        />
      )}
    </>
  );
}

/** A card's related elements popup (from its pill), while it is open. */
export function CanvasRelatedPopup({
  related,
  graph,
  laid,
  full,
  onPick,
  onClose,
}: {
  related: RelatedState;
  graph: ModelGraph;
  laid: Laid | null;
  /** No room for more elements on the canvas. */
  full: boolean;
  onPick: (id: string) => void;
  onClose: (returnFocus: boolean) => void;
}) {
  const relatedCard = graph.elements.get(related.cardId);
  const relatedGroups = useMemo(
    () => (laid ? missingRelatedElements(graph, related.cardId, laid.placed) : []),
    [graph, related, laid],
  );
  if (!relatedCard) return null;
  return (
    <RelatedPopup
      name={relatedCard.name}
      groups={relatedGroups}
      top={related.top}
      left={related.left}
      opener={related.opener}
      full={full}
      onPick={onPick}
      onClose={onClose}
    />
  );
}

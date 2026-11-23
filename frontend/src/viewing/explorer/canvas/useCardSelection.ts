import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { selectedCards, toggledCard, type Picks } from './cardSelection';
import type { Laid, Note } from './canvasModel';
import type { ExplorerCanvasProps } from './explorerCanvasProps';

/** What the selection of several cards reads and updates. */
export interface CardSelectionInput {
  props: Pick<ExplorerCanvasProps, 'selectedId' | 'onSelectElement' | 'onDeselect'>;
  /** Changes when the canvas is a new one: the picks go with it. */
  canvasKey: string;
  laid: Laid | null;
  setNote: Dispatch<SetStateAction<Note | null>>;
}

/**
 * The cards selected on the canvas: the details card, plus the ones picked with `Shift`, `Ctrl` or
 * `⌘` + click. `pick` adds or takes out a card; `endPicks` leaves the details card alone.
 */
export function useCardSelection({ props, canvasKey, laid, setNote }: CardSelectionInput) {
  const { selectedId, onSelectElement, onDeselect } = props;
  const [picks, setPicks] = useState<Picks | null>(null);
  const placed = laid?.placed;
  const selected = useMemo(
    () => selectedCards(picks, canvasKey, selectedId, placed ?? new Map<string, unknown>()),
    [picks, canvasKey, selectedId, placed],
  );
  const selectedIds = useMemo(() => new Set(selected), [selected]);

  const endPicks = useCallback(() => {
    setPicks(null);
  }, []);

  /** A modifier click on a card: in or out of the selection; the details panel follows. */
  const pick = (id: string) => {
    const next = toggledCard(selected, id);
    const last = next[next.length - 1];
    if (last === undefined) {
      // Nothing left: as a click on empty canvas.
      setPicks(null);
      onDeselect?.();
      return;
    }
    setPicks({ key: canvasKey, ids: next });
    if (last !== selectedId) onSelectElement?.(last);
    if (next.length > 1) {
      setNote({
        laid,
        text: `${String(next.length)} cards selected.`,
        ...(laid ? { canvas: laid.canvas } : {}),
      });
    }
  };

  return { selected, selectedIds, pick, endPicks };
}

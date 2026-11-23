import { nodeTypeDefinitions, type ModelGraph } from '@simplearchitecture/shared';
import { useCallback, useMemo } from 'react';
import { containerMinSize } from './cardSize';
import { endBoxesOf, groupHeadsOf } from './canvasCards';
import type { Laid } from './canvasModel';
import { absoluteBoxes, type PlacedCard } from './elkLayout';
import { groupMinSize } from './groups';
import { arrangeCards, type Holding, type MovedPositions } from './positions';

/**
 * Where the cards are drawn: the layout, with the moved cards where the user put them, and the
 * containers they are in fitted to what they hold (while a card is held, only growing); their
 * positions on the canvas, and the made-up ids React Flow and the DOM know them by.
 */
export function useCanvasGeometry(input: {
  laid: Laid | null;
  moved: MovedPositions;
  holding: Holding | undefined;
  graph: ModelGraph;
  hoodFocusId: string;
}) {
  const { laid, moved, holding, graph, hoodFocusId } = input;
  // Model ids can hold any character, but React Flow builds CSS selectors from node ids.
  // So React Flow and the DOM get made-up ids (`n0`, `card-0`), mapped back on events.
  const { domIds, flowIds, elementIds } = useMemo(() => {
    const dom = new Map<string, string>();
    const flow = new Map<string, string>();
    const element = new Map<string, string>();
    [...(laid?.placed.keys() ?? [])].forEach((id, index) => {
      dom.set(id, `card-${index}`);
      flow.set(id, `n${index}`);
      element.set(`n${index}`, id);
    });
    return { domIds: dom, flowIds: flow, elementIds: element };
  }, [laid]);
  const flowId = useCallback((id: string) => flowIds.get(id) ?? '', [flowIds]);

  // Each group box's header: its value as shown, its count, and how wide the two are drawn.
  const groupHeads = useMemo(() => groupHeadsOf(laid), [laid]);
  const minContainerSize = useCallback(
    (id: string) => {
      const head = groupHeads.get(id);
      if (head) return groupMinSize(head.width);
      const element = graph.elements.get(id);
      return containerMinSize({
        name: element?.name ?? '',
        focused: id === hoodFocusId,
        userIcon: element !== undefined && nodeTypeDefinitions[element.type].icon === 'user',
      });
    },
    [graph, hoodFocusId, groupHeads],
  );
  const shown = useMemo(
    () =>
      laid
        ? arrangeCards(laid.placed, moved, { minSizeOf: minContainerSize, holding })
        : new Map<string, PlacedCard>(),
    [laid, moved, minContainerSize, holding],
  );
  // Positions on the canvas (cards inside containers are placed relative to them).
  const absolute = useMemo(() => absoluteBoxes(shown), [shown]);
  // The cards as a line's ends see them: a Stakeholder's lines end on its circle, not its box.
  // Group boxes too: a line keeps out of a box it neither starts nor ends in, and off its header.
  const endBoxes = useMemo(
    () => endBoxesOf(absolute, graph, laid, shown, groupHeads),
    [absolute, graph, laid, shown, groupHeads],
  );
  return { domIds, elementIds, flowId, groupHeads, shown, absolute, endBoxes };
}

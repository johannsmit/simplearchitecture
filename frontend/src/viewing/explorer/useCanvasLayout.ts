import {
  canRemoveFromCanvas,
  containerOf,
  neighbourhood,
  nodeTypes,
  withAddedElements,
  withContainers,
  withoutElements,
  type ModelElement,
  type ModelGraph,
} from '@simplearchitecture/shared';
import { useCallback, useMemo, useState } from 'react';
import { isGroupId } from './canvas/layoutGeometry';
import {
  hasMovedCards,
  noMovedPositions,
  withMovedCard,
  type MovedPositions,
  type Point,
} from './canvas/positions';
import { storedWidths } from './canvas/viewLayout';
import { readNestContained, writeNestContained } from './prefs';
import type { OpenView } from './useOpenView';
import { viewHood } from './views';

/** A stable empty list, so memos don't see a new one on every render. */
const noIds: readonly string[] = [];
const noWidths: ReadonlyMap<string, number> = new Map();
const noIdSet: ReadonlySet<string> = new Set();

interface CanvasLayoutOptions {
  graph: ModelGraph | undefined;
  /** The focused element, when it is in the model. */
  element: ModelElement | undefined;
  elementId: string | undefined;
  /** Changes when the focus changes, or another view opens. */
  canvasKey: string;
  inView: boolean;
  openView: OpenView;
  viewEditable: boolean;
  viewBlocked: boolean;
  depth: number;
  /** Group by outside a view, from the address. */
  groupAsked: string | undefined;
}

/**
 * What the canvas shows and how it is laid out: the cards added and taken off, cards moved and
 * resized by hand, nesting, Group by, Tidy up and Tidy relations.
 */
export function useCanvasLayout({
  graph,
  element,
  elementId,
  canvasKey,
  inView,
  openView,
  viewEditable,
  viewBlocked,
  depth,
  groupAsked,
}: CanvasLayoutOptions) {
  const [nest, setNest] = useState(readNestContained);

  // Elements added from a card's related elements. Kept here, not in the URL, and dropped when
  // the focused element changes. They stay on a depth change: the depth decides how far down
  // their contents reach. A view keeps its own contents instead.
  const addedKey = canvasKey;
  const [added, setAdded] = useState<{ key: string; ids: string[] }>({ key: addedKey, ids: [] });
  // Forget them as soon as the focus changes (even if it later changes back).
  if (added.key !== addedKey) setAdded({ key: addedKey, ids: [] });
  const addedIds = added.key === addedKey ? added.ids : noIds;
  // Cards taken off the canvas: visual only, never saved. Like the added ones, they are forgotten
  // when the focus changes, and stay off through a depth change or Tidy up.
  const [removed, setRemoved] = useState<{ key: string; ids: string[] }>({
    key: addedKey,
    ids: [],
  });
  if (removed.key !== addedKey) setRemoved({ key: addedKey, ids: [] });
  const removedIds = removed.key === addedKey ? removed.ids : noIds;
  const addElement = useCallback(
    (id: string) => {
      setAdded((current) => ({
        key: addedKey,
        ids: [...(current.key === addedKey ? current.ids : []), id],
      }));
      // Back on the canvas, with the containers it is drawn inside.
      setRemoved((current) => {
        if (current.key !== addedKey || current.ids.length === 0) return current;
        const back = new Set([id]);
        if (graph) {
          for (let up = containerOf(graph, id); up !== undefined && !back.has(up);) {
            back.add(up);
            up = containerOf(graph, up);
          }
        }
        return { key: addedKey, ids: current.ids.filter((removedId) => !back.has(removedId)) };
      });
    },
    [addedKey, graph],
  );
  /** Takes a card off a focus canvas (visual only). */
  const takeOffCanvas = (id: string) => {
    setRemoved((current) => ({
      key: addedKey,
      ids: [...(current.key === addedKey ? current.ids : []), id],
    }));
  };

  // Cards moved on the canvas: never in the model or the URL, and dropped on a focus or depth
  // change, or by Tidy up. An open view saves its layout from what the canvas shows.
  const movedKey = inView ? canvasKey : `${elementId ?? ''}|${depth}`;
  const [moved, setMoved] = useState<{ key: string; positions: MovedPositions }>({
    key: movedKey,
    positions: noMovedPositions,
  });
  if (moved.key !== movedKey) setMoved({ key: movedKey, positions: noMovedPositions });
  const movedPositions = moved.key === movedKey ? moved.positions : noMovedPositions;
  const resetMoved = () => {
    setMoved({ key: movedKey, positions: noMovedPositions });
  };
  // In a view, its Group by; changed for the page in Viewing (and, in Modelling, until the change is
  // saved), and forgotten when the view is opened or read again.
  const [viewGroup, setViewGroup] = useState<{ key: string; group: string | undefined } | null>(
    null,
  );
  const groupBy = inView
    ? viewGroup?.key === openView.key
      ? viewGroup.group
      : (openView.view?.groupBy ?? undefined)
    : groupAsked;
  /** Group by in the open view. */
  const groupView = (key: string | undefined) => {
    setViewGroup({ key: openView.key, group: key });
  };
  const moveCard = useCallback(
    (id: string, position: Point | undefined) => {
      setMoved((current) => ({
        key: movedKey,
        positions: withMovedCard(
          current.key === movedKey ? current.positions : noMovedPositions,
          id,
          position,
        ),
      }));
    },
    [movedKey],
  );
  const [tidyCount, setTidyCount] = useState(0);
  // Tidy relations: each choice redraws every line from the cards; the canvas says when it can.
  const [relationsTidyCount, setRelationsTidyCount] = useState(0);
  const [canTidyRelations, setCanTidyRelations] = useState(false);
  // The canvas is laid out only when it is a new one; changes in between keep every card in place.
  const canvasLayoutKey = `${movedKey}|${nest ? 'nest' : 'flat'}|${groupBy === undefined ? '' : `group:${groupBy}`}`;
  const layoutKey = `${canvasLayoutKey}|${tidyCount}`;
  // An open view's stored layout: a new canvas opens with it (cards where they were left, with
  // their widths). A focus canvas has none.
  const storedLayout = inView ? openView.view?.layout : undefined;
  // And its lines' routes given by hand, read with it.
  const storedRoutes = inView ? openView.view?.routes : undefined;
  const baseWidths = useMemo(
    () => (storedLayout === undefined ? noWidths : storedWidths(storedLayout)),
    [storedLayout],
  );
  // Card widths set by hand on the canvas, kept through Tidy up until the canvas is a new one,
  // which starts from the view's stored widths (none on a focus canvas). Saved only in a view.
  const [widths, setWidths] = useState<{
    key: string;
    widths: ReadonlyMap<string, number> | undefined;
  }>({ key: canvasLayoutKey, widths: undefined });
  if (widths.key !== canvasLayoutKey) setWidths({ key: canvasLayoutKey, widths: undefined });
  const cardWidths = (widths.key === canvasLayoutKey ? widths.widths : undefined) ?? baseWidths;
  const resizeCard = useCallback(
    (id: string, width: number | undefined) => {
      setWidths((current) => {
        const next = new Map(
          (current.key === canvasLayoutKey ? current.widths : undefined) ?? baseWidths,
        );
        if (width === undefined) next.delete(id);
        else next.set(id, width);
        return { key: canvasLayoutKey, widths: next };
      });
    },
    [canvasLayoutKey, baseWidths],
  );
  // Adding or taking off cards, and Tidy up, in a view that can change: once the canvas shows the
  // change, it reports where its cards are, and the view's layout is saved.
  const [arrangeRequest, setArrangeRequest] = useState(0);
  const requestArrange = () => {
    setArrangeRequest((n) => n + 1);
  };
  /** The canvas changed without a new layout (its key then): Tidy up has something to do. */
  const [keptFor, setKeptFor] = useState<string | null>(null);

  const viewContents = openView.contents;
  const viewReady = openView.load.status === 'ready';
  const hood = useMemo(() => {
    if (!graph) return undefined;
    // A view: exactly its elements and relationships, with no containers brought in.
    if (inView) return viewReady ? viewHood(graph, viewContents) : undefined;
    if (!element) return undefined;
    const shown = withAddedElements(graph, neighbourhood(graph, element.id, { depth }), addedIds, {
      depth,
    });
    // A nested element's containers are always brought onto the canvas, so nesting shows; they
    // count towards the cap.
    return withoutElements(graph, nest ? withContainers(graph, shown) : shown, removedIds, {
      nest,
    });
  }, [graph, element, depth, addedIds, removedIds, nest, inView, viewReady, viewContents]);

  // The cards with a remove button: on a focus canvas, all but the focused element and the cards
  // it is drawn inside; in a view that can change, every card.
  const removableIds = useMemo(() => {
    if (!graph || !hood) return noIdSet;
    if (inView) return viewEditable && !viewBlocked ? new Set(hood.hops.keys()) : noIdSet;
    return new Set(
      [...hood.hops.keys()].filter((id) => canRemoveFromCanvas(graph, hood, id, { nest })),
    );
  }, [graph, hood, inView, viewEditable, viewBlocked, nest]);
  // The element types on the canvas, for the legend.
  const typesOnCanvas = useMemo(() => {
    const present = new Set(
      [...(hood?.hops.keys() ?? [])].map((id) => graph?.elements.get(id)?.type),
    );
    return nodeTypes.filter((type) => present.has(type));
  }, [graph, hood]);

  // "Nest contained elements" lays the canvas out again, like Tidy up.
  const toggleNest = useCallback(() => {
    setNest((current) => {
      writeNestContained(!current);
      return !current;
    });
    setMoved({ key: movedKey, positions: noMovedPositions });
  }, [movedKey]);

  const onCanvas = useMemo(() => new Set(hood?.hops.keys() ?? []), [hood]);

  const canTidy =
    hood !== undefined &&
    (keptFor === layoutKey ||
      hasMovedCards(movedPositions, hood.hops) ||
      [...movedPositions.keys()].some(isGroupId));
  const tidyUp = () => {
    setMoved({ key: movedKey, positions: noMovedPositions });
    setTidyCount((n) => n + 1);
    // In a view, the new layout is saved.
    if (inView) requestArrange();
    // The button is disabled now: keep keyboard focus on the canvas, never on <body>.
    document.getElementById('canvas')?.focus();
  };
  /**
   * Tidy relations: every card stays, and every line is drawn again from the cards (lines moved by
   * hand too). In a view, the result is saved. From the menu, focus goes to the canvas.
   */
  const tidyRelations = (fromMenu: boolean) => {
    if (!canTidyRelations) return;
    setRelationsTidyCount((n) => n + 1);
    // The canvas is no longer the automatic layout: Tidy up has something to do.
    setKeptFor(layoutKey);
    if (inView) requestArrange();
    if (fromMenu) document.getElementById('canvas')?.focus();
  };
  const tidyRelationsByKey = () => {
    tidyRelations(false);
  };

  return {
    nest,
    toggleNest,
    addElement,
    takeOffCanvas,
    movedPositions,
    moveCard,
    resetMoved,
    groupBy,
    groupView,
    tidyCount,
    relationsTidyCount,
    canTidyRelations,
    setCanTidyRelations,
    layoutKey,
    storedLayout,
    storedRoutes,
    cardWidths,
    resizeCard,
    arrangeRequest,
    requestArrange,
    setKeptFor,
    hood,
    removableIds,
    typesOnCanvas,
    onCanvas,
    canTidy,
    tidyUp,
    tidyRelations,
    tidyRelationsByKey,
  };
}

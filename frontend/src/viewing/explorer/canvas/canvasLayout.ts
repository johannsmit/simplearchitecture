import {
  containsType,
  nodeTypeDefinitions,
  type ModelGraph,
  type Neighbourhood,
  type ViewCardLayout,
  type ViewLineRoute,
} from '@simplearchitecture/shared';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { cardShape } from '../../../metamodel-ui';
import { nestingParents } from '../views';
import { cardHeightAt, cardSize, containerMinSize, containerNameWidth } from './cardSize';
import { noRoutes, setWidth, type LatestCallbacks, type Laid, type Note } from './canvasModel';
import { getElk } from './elkEngine';
import {
  absoluteBoxes,
  layoutCards,
  layoutFailureMessage,
  layoutTimeLimit,
  LayoutTimeoutError,
  withinTimeLimit,
  type LayoutCard,
  type PlacedCard,
} from './elkLayout';
import {
  groupCards,
  groupedText,
  groupHeaderWidth,
  groupMinSize,
  groupNowOf,
  groupValueText,
} from './groups';
import { groupValueOf, isGroupId } from './layoutGeometry';
import { heldFromStored, type HeldRoute } from './lineRoutes';
import { keepCards, relinkHandles, type PlaceHint } from './placeCards';
import {
  arrangeCards,
  fitContainers,
  type Holding,
  type MovedPositions,
  type Point,
} from './positions';
import { storedGroupedPositions, storedPlacement, storedPositions } from './viewLayout';
import { layoutLinkRelationships, layoutLinks, type CanvasLink } from './view';

/** An open view's stored layout, read only when the canvas is a new one. */
export interface StoredLayout {
  cards: readonly ViewCardLayout[] | undefined;
  routes: readonly ViewLineRoute[] | undefined;
  groupBy: string | undefined;
}

/** What the canvas's layout reads: its inputs, and the canvas's refs and state it updates. */
export interface LayoutRun {
  fontsReady: boolean;
  hood: Neighbourhood;
  links: CanvasLink[];
  graph: ModelGraph;
  nest: boolean;
  layoutKey: string;
  widths: ReadonlyMap<string, number>;
  groupBy: string | undefined;
  laidRef: RefObject<Laid | null>;
  holdingRef: RefObject<Holding | undefined>;
  hints: RefObject<Map<string, PlaceHint>>;
  section: RefObject<HTMLElement | null>;
  latest: RefObject<LatestCallbacks>;
  movedRef: RefObject<MovedPositions>;
  storedRef: RefObject<StoredLayout>;
  canvasCount: RefObject<number>;
  arrangeWanted: RefObject<boolean>;
  setLaid: Dispatch<SetStateAction<Laid | null>>;
  setLayoutError: Dispatch<SetStateAction<string | null>>;
  setNote: Dispatch<SetStateAction<Note | null>>;
}

/**
 * Lays the canvas out, for the canvas's layout effect. A new canvas is measured (after the fonts
 * load) and laid out in ELK's worker. Any other change (cards or lines added or taken off, an
 * element edited) keeps every card where it is. Returns the effect's cleanup, if any.
 */
export function layOutCanvas(run: LayoutRun): (() => void) | undefined {
  const {
    fontsReady,
    hood,
    links,
    graph,
    nest,
    layoutKey,
    widths,
    groupBy,
    laidRef,
    holdingRef,
    hints,
    section,
    latest,
    movedRef,
    storedRef,
    canvasCount,
    arrangeWanted,
    setLaid,
    setLayoutError,
    setNote,
  } = run;
  if (!fontsReady) return;
  let live = true;
  // Nesting: each element inside its container, when that and their Contains are shown.
  const wanted = nest ? nestingParents(graph, hood) : new Map<string, string>();
  const ids = [...hood.hops.keys()].filter((id) => graph.elements.has(id));
  // Group by: each top-level card in its value's group box, one more level above the cards.
  const grouping = groupBy === undefined ? undefined : groupCards(graph, ids, wanted, groupBy);
  const groupIds = grouping?.order ?? [];
  /** The box each card is drawn in: its container, or its group box. */
  const parentOf = new Map(wanted);
  for (const [id, group] of grouping?.groupOf ?? []) parentOf.set(id, group);
  const headerWidthOf = (group: string) =>
    groupHeaderWidth(
      groupValueText(groupBy ?? '', groupValueOf(group)),
      grouping?.members.get(group)?.length ?? 0,
    );
  const sizeOf = (id: string, container: boolean) => {
    if (isGroupId(id)) return groupMinSize(headerWidthOf(id));
    const element = graph.elements.get(id);
    if (!element) return { width: 0, height: 0 };
    const focused = id === hood.focusId;
    return container
      ? containerMinSize({
          name: element.name,
          focused,
          userIcon: nodeTypeDefinitions[element.type].icon === 'user',
        })
      : cardSize({ name: element.name, focused, shape: cardShape(element.type) });
  };
  const heightAt = (id: string, width: number) => {
    const element = graph.elements.get(id);
    if (!element || cardShape(element.type) !== 'card') return sizeOf(id, false).height;
    return cardHeightAt({ name: element.name, focused: id === hood.focusId }, width);
  };
  /** Every card and group box to draw, parents first. */
  const canvasCards = [
    ...groupIds.map((id) => ({ id })),
    ...ids.map((id) => ({ id, parent: parentOf.get(id) })),
  ];
  /** Element containers only: group boxes are drawn as boxes of their own. */
  const elementParents = (placed: ReadonlyMap<string, PlacedCard>) => {
    const parents = new Map<string, string>();
    for (const card of placed.values()) {
      if (card.parent !== undefined && !isGroupId(card.parent)) parents.set(card.id, card.parent);
    }
    return parents;
  };
  const withoutGroups = (set: Iterable<string>) => new Set([...set].filter((id) => !isGroupId(id)));
  // A Contains drawn as nesting: no line.
  const nested =
    (parents: ReadonlyMap<string, string>) =>
    (link: { type: string; source: string; target: string }) =>
      link.type === containsType && parents.get(link.target) === link.source;
  const made = (
    placed: Map<string, PlacedCard>,
    parents: ReadonlyMap<string, string>,
    containers: ReadonlySet<string>,
    fresh: boolean,
    routes: Pick<Laid, 'canvas' | 'routes'>,
  ): Laid => ({
    key: layoutKey,
    fresh,
    widths,
    hood,
    links,
    drawn: links.filter((link) => !nested(parents)(link)),
    placed,
    parents,
    containers,
    ...routes,
    groupBy,
  });

  const previous = laidRef.current;
  /**
   * The previous canvas kept, its lines' routes included, with the cards in `moved` where they
   * were put: cards that came go to a free spot, cards that went are taken off.
   */
  const keep = (previous: Laid, moved: MovedPositions) => {
    // The cards as drawn now, moved ones included, become the canvas's own places.
    const before = arrangeCards(previous.placed, moved, {
      minSizeOf: (id) => sizeOf(id, true),
      holding: holdingRef.current,
    });
    // On a grouped canvas, a card that belongs in another box than it is in (its value changed,
    // or it came into or out of a container) goes, with what it holds, to a free spot in its
    // box, as a new card does, nearest to where it was. No other card moves.
    const staying = new Map(before);
    if (grouping) {
      const at = absoluteBoxes(before);
      const leaving = new Set<string>();
      for (const card of before.values()) {
        const want = parentOf.get(card.id);
        if (card.parent === want || isGroupId(card.id)) continue;
        const inGroup = (id: string | undefined) => id !== undefined && isGroupId(id);
        if (!inGroup(card.parent) && !inGroup(want)) continue;
        leaving.add(card.id);
        const was = at.get(card.id);
        if (was && !hints.current.has(card.id)) {
          hints.current.set(card.id, { at: { x: was.x, y: was.y } });
        }
      }
      for (const card of before.values()) {
        for (let up: string | undefined = card.id; up !== undefined; up = before.get(up)?.parent) {
          if (leaving.has(up)) {
            staying.delete(card.id);
            break;
          }
        }
      }
    }
    const box = section.current?.getBoundingClientRect();
    const kept = keepCards({
      previous: staying,
      previousContainers: previous.containers,
      cards: canvasCards,
      related: hood.relationships,
      sizeOf,
      heightAt,
      widths,
      hints: hints.current,
      centre: box
        ? latest.current.flow.screenToFlowPosition({
            x: box.left + box.width / 2,
            y: box.top + box.height / 2,
          })
        : { x: 0, y: 0 },
    });
    // A container whose card was taken off fits what it still holds, and so do its containers;
    // and a group box whose card went to another box.
    const lostIn = new Set<string>();
    for (const card of before.values()) {
      if (card.parent === undefined) continue;
      const now = kept.placed.get(card.id);
      if (now && (now.parent === card.parent || !isGroupId(card.parent))) continue;
      for (let up: string | undefined = card.parent; up !== undefined && !lostIn.has(up);) {
        lostIn.add(up);
        up = before.get(up)?.parent;
      }
    }
    const fitted =
      lostIn.size === 0
        ? kept.placed
        : fitContainers(kept.placed, lostIn, { minSizeOf: (id) => sizeOf(id, true) });
    const parents = elementParents(fitted);
    const placed = relinkHandles(
      fitted,
      layoutLinkRelationships(previous.hood.relationships),
      layoutLinks(hood.relationships, (relationship) => !nested(parents)(relationship)),
    );
    // A layout's failure message stays: only a new layout, or a new canvas, clears it.
    setLaid(
      made(placed, parents, withoutGroups(kept.containers), false, {
        canvas: previous.canvas,
        routes: previous.routes,
      }),
    );
    for (const id of placed.keys()) hints.current.delete(id);
    // A moved card taken out of its container keeps its place on the canvas.
    for (const [id, point] of moved) {
      const card = placed.get(id);
      if (card && (card.x !== point.x || card.y !== point.y)) {
        latest.current.onMove(id, { x: card.x, y: card.y });
      }
    }
  };
  if (previous?.key === layoutKey && previous.groupBy === groupBy) {
    keep(previous, movedRef.current);
    return;
  }

  /**
   * A new canvas without ELK: the cards with a stored position where they were left (with the
   * lines' stored routes), the others at a free spot. `problem`: why ELK's layout isn't used.
   */
  const placeWithoutElk = (
    stored: ReadonlyMap<string, Point>,
    storedRoutes: readonly ViewLineRoute[],
    problem: string | null,
  ) => {
    const cards = canvasCards;
    // A card at the width it was given, as it was left: the lines' stored routes end on it.
    const leftSize = (id: string, container: boolean) => {
      if (isGroupId(id)) return sizeOf(id, true);
      const element = graph.elements.get(id);
      const set = container ? undefined : widths.get(id);
      if (set === undefined || !element || cardShape(element.type) !== 'card') {
        return sizeOf(id, container);
      }
      const width = setWidth(set);
      return { width, height: heightAt(id, width) };
    };
    const start = storedPlacement({ cards, stored, sizeOf: leftSize });
    const box = section.current?.getBoundingClientRect();
    const kept = keepCards({
      previous: start.placed,
      previousContainers: start.containers,
      cards,
      related: hood.relationships,
      sizeOf,
      heightAt,
      widths,
      hints: new Map(),
      centre: box
        ? latest.current.flow.screenToFlowPosition({
            x: box.left + box.width / 2,
            y: box.top + box.height / 2,
          })
        : { x: 0, y: 0 },
    });
    const parents = elementParents(kept.placed);
    // No routes from ELK: every line follows its cards, as after a move.
    const placed = relinkHandles(
      kept.placed,
      new Map(),
      layoutLinks(hood.relationships, (relationship) => !nested(parents)(relationship)),
    );
    // The lines moved by hand, read against their cards as the layout was left; their ends then
    // follow the cards the containers' fit moved.
    const boxes = absoluteBoxes(arrangeCards(placed, movedRef.current));
    const left = absoluteBoxes(start.asLeft);
    const ends = new Map(hood.relationships.map((relationship) => [relationship.id, relationship]));
    const routes = new Map<string, HeldRoute>();
    for (const route of storedRoutes) {
      const relationship = ends.get(route.relationshipId);
      if (!relationship) continue;
      const { source, target } = relationship;
      const held = heldFromStored(
        route.points,
        { source, target },
        left.get(source) ?? boxes.get(source),
        left.get(target) ?? boxes.get(target),
      );
      if (held) routes.set(route.relationshipId, held);
    }
    hints.current.clear();
    setLayoutError(problem);
    const next = made(placed, parents, withoutGroups(kept.containers), true, {
      canvas: ++canvasCount.current,
      routes,
    });
    setLaid(next);
    return next;
  };

  // Another Group by: laid out afresh (and in a view, saved).
  const regrouped = previous !== null && previous.groupBy !== groupBy;
  /** What the canvas's status says once a regroup is drawn. */
  const regroupNote =
    groupBy === undefined
      ? 'Not grouped.'
      : groupedText(groupBy, groupIds.length, graph.elementProperties);
  // Another canvas: a report asked for on the previous one is never made for it.
  if (!regrouped) arrangeWanted.current = false;
  const storedCards = storedRef.current.cards ?? [];
  // A view with a stored layout: its cards where they were left, the others at a free spot. The
  // layout holds for the grouping it was saved with (also on a regroup back to it); any other is
  // laid out afresh.
  const stored =
    storedRef.current.groupBy !== groupBy
      ? undefined
      : grouping
        ? storedGroupedPositions(
            storedCards,
            (id) => groupNowOf(grouping, wanted, id),
            grouping.members,
          )
        : storedPositions(storedCards);
  if (stored !== undefined && ids.some((id) => stored.has(id))) {
    const next = placeWithoutElk(stored, storedRef.current.routes ?? [], null);
    if (regrouped) setNote({ laid: next, text: regroupNote });
    return;
  }

  hints.current.clear();
  const containers = new Set(wanted.values());
  const groupLayoutCards = groupIds.map((id): LayoutCard => ({
    id,
    ...sizeOf(id, true),
    shape: 'container',
    // Lines into a group box come in beside its value and count.
    nameWidth: headerWidthOf(id),
  }));
  const cards = ids.map((id): LayoutCard => {
    const element = graph.elements.get(id);
    const parent = parentOf.get(id);
    const container = containers.has(id);
    const shape = container ? ('container' as const) : element ? cardShape(element.type) : 'card';
    // A width set by hand (a view's stored one) is kept by a new layout, with the name wrapped to it.
    const set = container || shape !== 'card' ? undefined : widths.get(id);
    const width = set === undefined ? undefined : setWidth(set);
    return {
      id,
      ...(width === undefined ? sizeOf(id, container) : { width, height: heightAt(id, width) }),
      shape,
      ...(parent === undefined ? {} : { parent }),
      // Lines into a container come in beside its name, however long.
      ...(container && element
        ? {
            nameWidth: containerNameWidth({
              name: element.name,
              focused: id === hood.focusId,
              userIcon: nodeTypeDefinitions[element.type].icon === 'user',
            }),
          }
        : {}),
    };
  });
  const laidOut = layoutLinks(hood.relationships, (relationship) => !nested(wanted)(relationship));
  // A new try (a regroup after a failure): "Laying out…" again until it answers.
  setLayoutError(null);
  const elk = getElk();
  // Group boxes first, in the property's order: where the lines leave a choice, they keep it.
  const timed = withinTimeLimit(
    layoutCards(elk, [...groupLayoutCards, ...cards], laidOut),
    layoutTimeLimit,
  );
  timed.promise
    .then((byElk) => {
      if (!live) return;
      setLayoutError(null);
      // Every container and group box fits what it holds, as after a move.
      const placed = fitContainers(byElk, [...containers, ...groupIds], {
        minSizeOf: (id) => sizeOf(id, true),
      });
      const next = made(placed, wanted, containers, true, {
        canvas: ++canvasCount.current,
        routes: noRoutes,
      });
      setLaid(next);
      if (regrouped) setNote({ laid: next, text: regroupNote });
    })
    .catch((error: unknown) => {
      if (!live) return;
      // Too slow: ELK's worker is stopped, so the next layout doesn't wait behind it.
      if (error instanceof LayoutTimeoutError) elk.terminateWorker();
      console.warn('The automatic layout failed.', error);
      // A failed layout is never saved: a regroup's save is dropped, unless the person moved a
      // card while it ran.
      if (movedRef.current.size === 0) arrangeWanted.current = false;
      // A new canvas stays usable: every card at a free spot, with a message.
      placeWithoutElk(new Map(), [], layoutFailureMessage(error));
    });
  return () => {
    live = false;
    timed.cancel();
  };
}

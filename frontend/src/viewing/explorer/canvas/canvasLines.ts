import {
  displayLabel,
  relationshipVerb,
  type ModelGraph,
  type Neighbourhood,
} from '@simplearchitecture/shared';
import { cardShape } from '../../../metamodel-ui';
import { noRoutes, withoutRoute, zIndexes, type Highlight, type Laid } from './canvasModel';
import { currentBends, floatingEnds, type EndBox, type FloatingLine } from './edgeLine';
import { portId, type PlacedCard, type Side } from './elkLayout';
import {
  endPlace,
  followCards,
  laidLine,
  routesToSave,
  withLaidRoutes,
  type HeldRoute,
} from './lineRoutes';
import type { Box, Point } from './positions';
import type { RelationshipFlowEdge } from './RelationshipEdge';
import { isGrayed, linkDataParts, linkText } from './view';
import { layoutOfCanvas, type CanvasLayout } from './viewLayout';

/**
 * Lines moved by hand, with their cards where they are now: the stretches the person moved stay,
 * and the stretches at a moved card's end follow it. A merged line takes its first relationship's
 * route.
 */
export function handRoutesOf(
  laid: Laid | null,
  endBoxes: ReadonlyMap<string, EndBox>,
  held: ReadonlyMap<string, HeldRoute>,
): Map<string, Point[]> {
  const result = new Map<string, Point[]>();
  for (const link of laid?.drawn ?? []) {
    const source = endBoxes.get(link.source);
    const target = endBoxes.get(link.target);
    if (!source || !target) continue;
    for (const id of link.relationshipIds) {
      const route = held.get(id);
      if (route?.source !== link.source || route.target !== link.target) continue;
      const points = followCards(route, source, target);
      if (points) {
        result.set(link.id, points);
        break;
      }
    }
  }
  return result;
}

/**
 * ELK's routes that still hold. Worked out apart from the edges, so a hover keeps the same bends
 * and doesn't place the labels again.
 */
export function layoutRoutesOf(
  laid: Laid | null,
  shown: ReadonlyMap<string, PlacedCard>,
  absolute: ReadonlyMap<string, Box>,
  handRoutes: ReadonlyMap<string, Point[]>,
): Map<string, Point[]> {
  const result = new Map<string, Point[]>();
  // A card whose size changed (a rename, a width set by hand) has lines that follow it, as after a
  // move: ELK's ports on it no longer hold.
  const sameSize = (id: string) => {
    const before = laid?.layoutSizes.get(id);
    const now = shown.get(id);
    return before !== undefined && now?.width === before.width && now.height === before.height;
  };
  for (const link of laid?.drawn ?? []) {
    if (handRoutes.has(link.id)) continue;
    if (!sameSize(link.source) || !sameSize(link.target)) continue;
    const handle = shown
      .get(link.source)
      ?.handles.find((candidate) => candidate.id === portId(link.id, 'source'));
    const bends = currentBends(handle?.route, absolute.get(link.source), absolute.get(link.target));
    if (bends) result.set(link.id, bends);
  }
  return result;
}

/** What the canvas reports as its arrangement (`onArranged`). */
export interface ArrangedInput {
  laid: Laid;
  shown: ReadonlyMap<string, PlacedCard>;
  graph: ModelGraph;
  widths: ReadonlyMap<string, number>;
  hood: Neighbourhood;
  routes: ReadonlyMap<string, Point[]>;
  endBoxes: ReadonlyMap<string, EndBox>;
  held: ReadonlyMap<string, HeldRoute>;
}

/**
 * Where every card is, and the route of every line moved by hand or on the layout's route: the
 * layout made for this canvas, its cards and its widths.
 */
export function arrangedLayoutOf(input: ArrangedInput): CanvasLayout {
  const { laid, shown, graph, widths, hood, routes, endBoxes, held } = input;
  const cards = layoutOfCanvas(
    shown,
    (id) => {
      const element = graph.elements.get(id);
      return (
        widths.has(id) &&
        !laid.containers.has(id) &&
        element !== undefined &&
        cardShape(element.type) === 'card'
      );
    },
    laid.groupBy !== undefined,
  );
  const ends = new Map(hood.relationships.map((relationship) => [relationship.id, relationship]));
  // Lines on the layout's route (after Tidy up) are saved as drawn, so the view opens with them.
  const laidLines = new Map<string, Point[]>();
  for (const link of laid.drawn) {
    const bends = routes.get(link.id);
    const source = endBoxes.get(link.source);
    const target = endBoxes.get(link.target);
    if (!bends || !source || !target) continue;
    const line = laidLine(
      bends,
      {
        handles: shown.get(link.source)?.handles ?? [],
        box: source,
        port: portId(link.id, 'source'),
      },
      {
        handles: shown.get(link.target)?.handles ?? [],
        box: target,
        port: portId(link.id, 'target'),
      },
    );
    if (line) laidLines.set(link.id, line);
  }
  return {
    cards,
    routes: withLaidRoutes(routesToSave(held, ends, endBoxes), laidLines, laid.drawn, endBoxes),
    groupBy: laid.groupBy ?? null,
  };
}

/**
 * Lines without a route: their ends on the sides where their cards face each other now, so they
 * follow a moved card (live, while it is dragged) and take the shortest way.
 */
export function floatingOf(
  laid: Laid | null,
  absolute: ReadonlyMap<string, Box>,
  endBoxes: ReadonlyMap<string, EndBox>,
  shown: ReadonlyMap<string, PlacedCard>,
  routes: ReadonlyMap<string, Point[]>,
  handRoutes: ReadonlyMap<string, Point[]>,
): Map<string, FloatingLine> {
  if (!laid) return new Map<string, FloatingLine>();
  const boxes = endBoxes;
  // The ends of routed lines keep their places: the others keep clear of them.
  const taken = new Map<string, { side: Side; offset: number }[]>();
  for (const link of laid.drawn) {
    if (!routes.has(link.id)) continue;
    for (const [card, end] of [
      [link.source, 'source'],
      [link.target, 'target'],
    ] as const) {
      const handle = shown.get(card)?.handles.find((h) => h.id === portId(link.id, end));
      if (handle) taken.set(card, [...(taken.get(card) ?? []), handle]);
    }
  }
  // So do the ends of lines moved by hand.
  for (const link of laid.drawn) {
    const points = handRoutes.get(link.id);
    if (!points) continue;
    for (const [card, point] of [
      [link.source, points[0]],
      [link.target, points[points.length - 1]],
    ] as const) {
      const box = absolute.get(card);
      const place = point && box && endPlace(point, box);
      if (place) taken.set(card, [...(taken.get(card) ?? []), place]);
    }
  }
  return floatingEnds(
    laid.drawn.filter((link) => !routes.has(link.id) && !handRoutes.has(link.id)),
    boxes,
    taken,
  );
}

/** A bend being dragged, on this line: from 4px on, the line as it would be if dropped now. */
export interface LineDrag {
  linkId: string;
  points?: Point[];
}

/**
 * The lines whose bend handles show: the line under the pointer and the open relationship's line;
 * while a bend is dragged, only its line.
 */
export function bendLinkIdsOf(
  bendsAllowed: boolean,
  laid: Laid | null,
  lineDrag: LineDrag | null,
  hoveredLink: string | undefined,
  chosen: string | undefined,
): string[] {
  if (!bendsAllowed || !laid) return [];
  if (lineDrag) return [lineDrag.linkId];
  return laid.drawn
    .filter(
      (link) =>
        link.id === hoveredLink || (chosen !== undefined && link.relationshipIds.includes(chosen)),
    )
    .map((link) => link.id);
}

/** What the relationship lines are drawn from. */
export interface EdgesInput {
  laid: Laid | null;
  graph: ModelGraph;
  highlight: Highlight;
  flowId: (id: string) => string;
  cardBoxes: Box[];
  dragging: boolean;
  /** The relationship open in the details panel. */
  chosen: string | undefined;
  /** A relationship just added. */
  fresh: string | undefined;
  routes: ReadonlyMap<string, Point[]>;
  floating: ReadonlyMap<string, FloatingLine>;
  handRoutes: ReadonlyMap<string, Point[]>;
  lineDrag: LineDrag | null;
  linesMovable: boolean;
  bendLinkIds: readonly string[];
  shownProperties: readonly string[];
}

/**
 * Every relationship line as a React Flow edge, without the callbacks that act on the canvas (the
 * canvas adds those).
 */
export function relationshipEdgesOf(
  input: EdgesInput,
): (RelationshipFlowEdge & { data: NonNullable<RelationshipFlowEdge['data']> })[] {
  const {
    laid,
    graph,
    highlight,
    flowId,
    cardBoxes,
    dragging,
    chosen,
    fresh,
    routes,
    floating,
    handRoutes,
    lineDrag,
    linesMovable,
    bendLinkIds,
    shownProperties,
  } = input;
  if (!laid) return [];
  const name = (id: string) => graph.elements.get(id)?.name || '(unnamed)';
  return laid.drawn.map((link) => {
    const isSelected = chosen !== undefined && link.relationshipIds.includes(chosen);
    const isFresh = fresh !== undefined && link.relationshipIds.includes(fresh);
    const lit = (highlight?.links.has(link.id) ?? false) || isSelected || isFresh;
    const nested = laid.parents.has(link.source) || laid.parents.has(link.target);
    const text = linkText(link, shownProperties, (member) => displayLabel(member, graph));
    const lists = linkDataParts(link, shownProperties, graph, text);
    const [only] = link.members;
    const resting = text !== '';
    const grayed = isGrayed(link, shownProperties);
    const bends = routes.get(link.id);
    const ends = floating.get(link.id);
    const dragged = lineDrag?.linkId === link.id ? lineDrag.points : undefined;
    const route = dragged ?? handRoutes.get(link.id);
    return {
      id: link.id,
      type: 'relationship' as const,
      // Edges to nested cards go above the container bodies.
      zIndex: nested ? zIndexes.nestedEdge : 0,
      source: flowId(link.source),
      target: flowId(link.target),
      sourceHandle: portId(link.id, 'source'),
      targetHandle: portId(link.id, 'target'),
      focusable: false,
      selectable: false,
      ariaLabel: `${name(link.source)} ${relationshipVerb(link.type, link.twoWay ? 'both' : 'outgoing')} ${name(link.target)}`,
      ...(highlight || grayed || link.state !== 'Current' || isSelected || isFresh
        ? {
            className: [
              highlight || isFresh ? (lit ? 'is-lit' : 'is-dim') : '',
              isSelected ? 'is-selected' : '',
              grayed && !lit ? 'is-grayed' : '',
              link.state === 'Current' ? '' : `is-${link.state.toLowerCase()}`,
            ]
              .filter(Boolean)
              .join(' '),
          }
        : {}),
      data: {
        type: link.type,
        text,
        ...(lists
          ? {
              dataLines: lists.parts,
              title: lists.title,
              ...(only?.source === only?.target ? { self: true } : {}),
            }
          : {}),
        lit,
        state: link.state,
        ...(link.twoWay ? { twoWay: true } : {}),
        ...(bends ? { bends } : {}),
        ...(ends ? { ends } : {}),
        ...(route ? { route } : {}),
        ...(linesMovable && bendLinkIds.includes(link.id) ? { bendHandles: true } : {}),
        ...(highlight && !lit ? { dim: true } : {}),
        ...(grayed && !lit ? { grayed: true } : {}),
        ...(resting ? { resting: true } : {}),
        ...(lit || resting || link.state !== 'Current'
          ? { cards: cardBoxes, hideLabel: dragging }
          : {}),
      },
    };
  });
}

/**
 * The canvas after Tidy relations: every card stays, and every line follows its cards, the layout's
 * routes and the routes given by hand dropped.
 */
export function withoutLineRoutes(laid: Laid): Laid {
  const placed = new Map<string, PlacedCard>();
  for (const [id, card] of laid.placed) {
    placed.set(id, { ...card, handles: card.handles.map(withoutRoute) });
  }
  return { ...laid, placed, routes: noRoutes };
}

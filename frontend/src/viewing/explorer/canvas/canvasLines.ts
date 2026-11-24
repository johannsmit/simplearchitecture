import {
  displayLabel,
  relationshipVerb,
  type ModelGraph,
  type Neighbourhood,
} from '@simplearchitecture/shared';
import { cardShape } from '../../../metamodel-ui';
import { noRoutes, withoutRoute, zIndexes, type Highlight, type Laid } from './canvasModel';
import { floatingEnds, type EndBox, type FloatingLine } from './edgeLine';
import { portId, type PlacedCard, type Side } from './elkLayout';
import { endPlace, followCards, routesToSave, type HeldRoute } from './lineRoutes';
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

/** What the canvas reports as its arrangement (`onArranged`). */
export interface ArrangedInput {
  laid: Laid;
  shown: ReadonlyMap<string, PlacedCard>;
  graph: ModelGraph;
  widths: ReadonlyMap<string, number>;
  hood: Neighbourhood;
  endBoxes: ReadonlyMap<string, EndBox>;
  held: ReadonlyMap<string, HeldRoute>;
}

/**
 * Where every card is, and the route of every line moved by hand: the layout made for this canvas,
 * its cards and its widths. Every other line is drawn by the canvas, so it saves no route.
 */
export function arrangedLayoutOf(input: ArrangedInput): CanvasLayout {
  const { laid, shown, graph, widths, hood, endBoxes, held } = input;
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
  return {
    cards,
    routes: routesToSave(held, ends, endBoxes),
    groupBy: laid.groupBy ?? null,
  };
}

/**
 * Every line not moved by hand: drawn by the canvas, never on the layout's route. Its ends are on
 * the sides where its cards face each other now, so it follows a moved card (live, while it is
 * dragged) and takes the shortest way, round cards in its way.
 */
export function floatingOf(
  laid: Laid | null,
  absolute: ReadonlyMap<string, Box>,
  endBoxes: ReadonlyMap<string, EndBox>,
  handRoutes: ReadonlyMap<string, Point[]>,
): Map<string, FloatingLine> {
  if (!laid) return new Map<string, FloatingLine>();
  const boxes = endBoxes;
  // The ends of lines moved by hand keep their places: the others keep clear of them.
  const taken = new Map<string, { side: Side; offset: number }[]>();
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
    laid.drawn.filter((link) => !handRoutes.has(link.id)),
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
 * The canvas after Tidy relations: every card stays, and every line follows its cards, the routes
 * given by hand dropped.
 */
export function withoutLineRoutes(laid: Laid): Laid {
  const placed = new Map<string, PlacedCard>();
  for (const [id, card] of laid.placed) {
    placed.set(id, { ...card, handles: card.handles.map(withoutRoute) });
  }
  return { ...laid, placed, routes: noRoutes };
}

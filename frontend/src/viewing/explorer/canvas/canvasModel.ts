import type { Neighbourhood } from '@simplearchitecture/shared';
import type { ReactFlowInstance } from '@xyflow/react';
import { maxSetCardWidth, minCardWidth } from './cardSize';
import type { CardNode } from './ElementCard';
import type { PlacedCard, PlacedHandle } from './elkLayout';
import type { GroupNode } from './GroupBox';
import type { HeldRoute } from './lineRoutes';
import type { Point } from './positions';
import type { RelationshipFlowEdge } from './RelationshipEdge';
import type { CanvasLink, Direction } from './view';

/** What React Flow draws as nodes: cards, and Group by's boxes. */
export type CanvasNode = CardNode | GroupNode;

/** The React Flow instance the canvas draws with. */
export type CanvasFlow = ReactFlowInstance<CanvasNode, RelationshipFlowEdge>;

/** The zoom a fit may choose; its padding keeps the cards clear of the panels at the top left. */
export const fitZoom = { min: 0.2, max: 1.25 } as const;

/** A width set by hand, within the smallest and the widest a card's width can be set to. */
export function setWidth(width: number): number {
  return Math.min(maxSetCardWidth, Math.max(minCardWidth, Math.round(width)));
}

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const arrowDirections: Record<string, Direction> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/** A popover on the canvas: New relationship, or New element (at a point on the canvas). */
export type CanvasPop =
  | { kind: 'relationship'; source: string; target: string; top: number; left: number }
  | {
      kind: 'element';
      at: Point;
      from?: string;
      top: number;
      left: number;
      /** Opened with `N`: where focus was then, to go back to on Esc. */
      opener?: HTMLElement;
    };

export const relPopWidth = 300;
export const relPopHeight = 340;

export interface Laid {
  /** The canvas it was made for (`layoutKey`). */
  key: string;
  tidyCount: number;
  /**
   * A new canvas (laid out by ELK, or from a view's stored layout): the view is fitted to it.
   * Otherwise the previous canvas with cards added or taken off.
   */
  fresh: boolean;
  hood: Neighbourhood;
  /** Every relationship on the canvas, including the ones drawn as nesting. */
  links: CanvasLink[];
  /** The links drawn as lines: all but the nesting ones. */
  drawn: CanvasLink[];
  placed: Map<string, PlacedCard>;
  /** Element id → the container it is drawn inside. */
  parents: ReadonlyMap<string, string>;
  /** Elements drawn as containers (with elements inside). */
  containers: ReadonlySet<string>;
  /** Each card's size when ELK laid it out: a line keeps ELK's route only while both stay so. */
  layoutSizes: ReadonlyMap<string, { width: number; height: number }>;
  /** The widths set by hand it was made with. */
  widths: ReadonlyMap<string, number>;
  /** The new canvas it belongs to (one for each new canvas; kept as cards come and go). */
  canvas: number;
  /** The routes given by hand that its lines start with, by relationship id. */
  routes: ReadonlyMap<string, HeldRoute>;
  /** The property its cards are grouped by (its group boxes are in `placed`), or undefined. */
  groupBy: string | undefined;
}

/**
 * What the live region says after a keyboard move or a tidy up (until the next layout), or, with
 * `canvas`, until the canvas is a new one (a moved line's save redraws the same canvas).
 */
export interface Note {
  laid: Laid | null;
  text: string;
  canvas?: number;
}

/** The latest page callbacks and React Flow instance, read without re-running the layout. */
export interface LatestCallbacks {
  onMove: (id: string, position: Point | undefined) => void;
  onKept: ((layoutKey: string) => void) | undefined;
  onResize: (id: string, width: number | undefined) => void;
  flow: CanvasFlow;
}

export const noRoutes: ReadonlyMap<string, HeldRoute> = new Map();

/** A handle without the layout's route: its line follows its cards. */
export function withoutRoute(handle: PlacedHandle): PlacedHandle {
  if (!handle.route) return handle;
  const rest = { ...handle };
  delete rest.route;
  return rest;
}

/** Stacking (React Flow's manual z-index): containers by depth, then edges, then cards. */
export const zIndexes = { nestedEdge: 500, card: 1000, lifted: 3000 } as const;

/** How soon after a line is dropped a click on it still counts as the end of the drag (ms). */
export const clickAfterDrag = 300;

/** "Show relationships" off: React Flow gets no edges at all, so no line, label or mark is drawn. */
export const noEdges: RelationshipFlowEdge[] = [];

export type Highlight = { ids: Set<string>; links: Set<string> } | null;
export interface RelatedState {
  cardId: string;
  opener: HTMLButtonElement;
  top: number;
  left: number;
}

export const popupWidth = 320;

export type Hover = { kind: 'card' | 'link'; id: string } | null;

/** Keyboard move mode: the card, and where it was when the move started (to cancel). */
export interface Moving {
  focusId: string;
  id: string;
  /** Its moved position before this move, or undefined when it was where the layout put it. */
  before: Point | undefined;
  /** Its width set by hand before this move, if any (`Alt` + arrows change it). */
  widthBefore: number | undefined;
  /** Its width on the canvas when the move started: Esc puts it back. */
  widthAt: number | undefined;
}

import type {
  ElementChangeResult,
  GroupByChoice,
  ModelGraph,
  Neighbourhood,
  RelationshipChangeResult,
  RelationshipViewField,
  ViewCardLayout,
  ViewLineRoute,
} from '@simplearchitecture/shared';
import type { ReactNode } from 'react';
import type { MovedPositions, Point } from './positions';
import type { CanvasLayout } from './viewLayout';

export interface ExplorerCanvasProps {
  graph: ModelGraph;
  /** What to draw: the neighbourhood plus any elements added from a card's related elements. */
  hood: Neighbourhood;
  focusId: string;
  depth: number;
  /** Elements requested but left out because the canvas was full. */
  refused: number;
  /** The relationship properties a viewpoint can show. */
  lineFields: readonly RelationshipViewField[];
  /** The ones selected: a selection changes how lines look, never the layout. */
  shownProperties: readonly string[];
  onShownProperties: (keys: string[]) => void;
  /** The element properties the cards can be grouped by (Group by); none: no panel. */
  groupChoices?: readonly GroupByChoice[];
  /**
   * The property the cards are grouped by, one box per value, or undefined for none. A change lays
   * the canvas out again (the page makes it part of `layoutKey`).
   */
  groupBy?: string | undefined;
  onGroupBy?: (key: string | undefined) => void;
  /** Adds a related element to the canvas (the focused element stays the same). */
  onAddElement: (id: string) => void;
  /** A double click (or Enter) on a card: it becomes the focus element. */
  onFocusElement: (id: string) => void;
  /** The element shown in the details panel: the focus element unless another is picked. */
  selectedId?: string | undefined;
  /** A single click on a card, or the arrow keys: select it without changing the canvas. */
  onSelectElement?: (id: string) => void;
  onDepth: (depth: number) => void;
  /** Changes when the space around the canvas changes, so the view is fitted again. */
  fitKey: string;
  /** Cards the user moved. Cleared by the page on a focus or depth change. */
  moved: MovedPositions;
  /**
   * A card was dragged or moved with the keyboard to this position; undefined puts it back in the
   * layout (a cancelled keyboard move of a card that hadn't moved before).
   */
  onMove: (id: string, position: Point | undefined) => void;
  /** Card widths set by hand (rectangle cards only): cleared by a new canvas (a view's stay). */
  widths: ReadonlyMap<string, number>;
  /** A card's width was set (its grip, or `Alt` + arrows in move mode); undefined drops it. */
  onResize: (id: string, width: number | undefined) => void;
  /**
   * Changes when the canvas is a new one (another element or view, a depth, the Nest switch, Group
   * by): only then is it laid out. Any other change keeps every card where it is.
   */
  layoutKey: string;
  /**
   * Goes up by one on each "Tidy relations": every card stays where it is, and every line is drawn
   * again from the cards, its route given by hand dropped. No new layout.
   */
  relationsTidyCount?: number;
  /** Whether Tidy relations can be used now: the canvas draws a line and isn't laying out. */
  onRelationsTidyable?: (can: boolean) => void;
  /** `T` on the canvas, when Tidy relations can be used. */
  onTidyRelations?: () => void;
  /** "Nest contained elements": draw contained elements inside their container. */
  nest: boolean;
  onToggleNest: () => void;
  /** "Show relationships": off hides every relationship line, with its marks. The cards stay put. */
  lines: boolean;
  onLines: (on: boolean) => void;
  /** Editable Modelling: drawing relationships and adding elements on the canvas. */
  editable?: boolean;
  modelId?: string;
  /** The relationship open in the details panel: its line is drawn selected. */
  selectedRelationshipId?: string | undefined;
  /** A relationship just added: its line is lit for a moment. */
  litRelationshipId?: string | undefined;
  onOpenRelationship?: (id: string) => void;
  /** A click on the empty canvas, or Esc, with a relationship selected. */
  onDeselect?: () => void;
  onRelationshipAdded?: (result: RelationshipChangeResult) => void;
  /** An element created on the canvas (its card goes where the popover was opened). */
  onElementCreated?: (result: ElementChangeResult) => void;
  /** `R` on a card: open Add relationship for it. */
  onAddRelationshipFrom?: (id: string) => void;
  /** Goes up by one on each `N`: the New element popover opens at the view's centre. */
  newElementRequest?: number;
  /**
   * New element's "Add to canvas", or a row dropped on the canvas: bring an existing element onto
   * the canvas (its card goes where it was dropped or asked for). Nothing is created.
   */
  onBringElement?: (id: string) => void;
  /** Goes up by one (with an element on the canvas): select that card and pan to it. */
  reveal?: { id: string; n: number } | undefined;
  /**
   * An open view, by name: no card is focused, the depth keys do nothing, and the canvas says
   * it is the view.
   */
  viewName?: string | undefined;
  /** The related pill on cards (off in a view that can't change). Default: on. */
  related?: boolean;
  /** A notice at the canvas's top (a view's change that wasn't saved), with its actions. */
  notice?: ReactNode;
  /** In place of the full canvas notice (a view has its own words). */
  fullText?: string | undefined;
  /** Over an empty canvas (a view with no elements). */
  emptyText?: ReactNode;
  /** The cards with a remove button (×): they can be taken off the canvas, or out of the view. */
  removable?: ReadonlySet<string>;
  /** The remove button on a card: takes it off the canvas (or out of the open view). */
  onRemoveCard?: (id: string) => void;
  /**
   * An open view's stored layout: a new canvas puts the cards with a position there, and the
   * others at a free spot, in place of a layout by ELK. Read only then.
   */
  storedLayout?: readonly ViewCardLayout[] | undefined;
  /**
   * An open view's stored line routes: read with `storedLayout`, when the canvas opens from it.
   */
  storedRoutes?: readonly ViewLineRoute[] | undefined;
  /**
   * The Group by the stored layout was saved with: the layout is read only while the canvas is
   * grouped the same way (a change in Viewing lays the page out afresh).
   */
  storedGroupBy?: string | undefined;
  /**
   * Goes up by one when the person added or took off cards, or tidied the lines: once the canvas
   * shows it, it reports where its cards are (`onArranged`).
   */
  arrangeRequest?: number;
  /**
   * Where every card is, and the route of every line moved by hand,
   * after the person moved or resized a card, moved a line, or after `arrangeRequest`. Never for a
   * layout, a placement or a route the canvas made on its own. Given, in a view, the lines' middle
   * stretches can be dragged.
   */
  onArranged?: (layout: CanvasLayout) => void;
}

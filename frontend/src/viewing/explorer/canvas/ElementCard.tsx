import type { ArchitectureState, ModelElement } from '@simplearchitecture/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { memo, type CSSProperties } from 'react';
import { Icon } from '../../../icons';
import { colourClass, isQuietState, StateBadge, TypeMark } from '../../../metamodel-ui';
import { counted } from '../../../words';
import type { CardShape } from './cardSize';
import { circleHandles } from './circle';
import type { PlacedHandle, Side } from './elkLayout';

export interface CardData extends Record<string, unknown> {
  element: ModelElement;
  /**
   * A rectangle card, or a circle with the name underneath (`cardShape` of the type), or a
   * container box with its contained elements inside.
   */
  shape: CardShape | 'container';
  /**
   * The metamodel colour of the container this element is drawn inside, if any: a circle's
   * label then sits on that container's body colour.
   */
  containerColour?: string;
  /**
   * A circle's name is longer than its 3-line label, or a container's than its one-line header:
   * the name ends in an ellipsis.
   */
  nameCut: boolean;
  /**
   * Different elements related to this one (through the relationship types shown) that aren't on
   * the canvas. 0: no relationship pill.
   */
  missing: number;
  state: ArchitectureState | undefined;
  focused: boolean;
  /** The selected element (shown in the details panel): drawn with the keyboard-focus ring. */
  selected?: boolean;
  /** The card that takes keyboard focus when tabbing into the canvas (roving tabindex). */
  tabbable: boolean;
  /** DOM id of the card's main button; the pill is `${domId}-related`. */
  domId: string;
  handles: PlacedHandle[];
  /** The related-elements popup is open for this card. */
  relatedOpen: boolean;
  /** The card is in keyboard move mode (lifted, with a dashed focus ring). */
  moving: boolean;
  onShowRelated: (elementId: string, button: HTMLButtonElement) => void;
  /** Editable Modelling: a connect handle to draw a relationship from. */
  connectable?: boolean;
  /** While a line is drawn over it: a valid target, or the source itself. */
  drop?: 'ok' | 'self';
}

export type CardNode = Node<CardData, 'element'>;

const positions: Record<Side, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};

/**
 * What a screen reader hears for a card: "Order Hub, Application, Current". The type is said even
 * though the card doesn't print it (colour, column, shape and legend show it). Functions are in
 * the details panel, not on the card.
 */
export function cardLabel(data: Pick<CardData, 'element' | 'state'>): string {
  return [data.element.name || '(unnamed)', data.element.type, data.state]
    .filter(Boolean)
    .join(', ');
}

/** The pill's accessible name: "3 related elements not on the canvas, show them" (1: "show it"). */
export function relatedButtonLabel(missing: number): string {
  return `${relatedButtonTitle(missing)}, show ${missing === 1 ? 'it' : 'them'}`;
}

/** The pill's tooltip: "3 related elements not on the canvas". */
export function relatedButtonTitle(missing: number): string {
  return `${counted(missing, 'related element')} not on the canvas`;
}

export function relatedButtonId(domId: string): string {
  return `${domId}-related`;
}

/** The number on the pill: as it is up to 999, then "999+" (the name has the full count). */
export function pillText(count: number): string {
  return count > 999 ? '999+' : String(count);
}

function handleStyle(handle: PlacedHandle): CSSProperties {
  return handle.side === 'left' || handle.side === 'right'
    ? { top: handle.offset }
    : { left: handle.offset };
}

/** One handle per relationship, where ELK put its port. Never connectable (read-only). */
function CardHandles({ handles }: { handles: readonly PlacedHandle[] }) {
  return handles.map((handle) => (
    <Handle
      key={handle.id}
      id={handle.id}
      type={handle.kind}
      position={positions[handle.side]}
      isConnectable={false}
      style={handleStyle(handle)}
    />
  ));
}

/** The handles moved onto the circle's edge, leaving sideways. */
function CircleHandles({ handles }: { handles: readonly PlacedHandle[] }) {
  return circleHandles(handles).map((handle) => (
    <Handle
      key={handle.id}
      id={handle.id}
      type={handle.kind}
      position={positions[handle.side]}
      isConnectable={false}
      style={{ left: handle.x, top: handle.y, right: 'auto', transform: 'translate(-50%, -50%)' }}
    />
  ));
}

/**
 * An element on the canvas, coloured by type: a rectangle card with the name centred, or (for
 * Stakeholders) a circle with the name underneath. A rectangle shows its Architecture state, when
 * it isn't the default, on its top border. While related elements are missing from the canvas, a
 * small pill with their number lists them. The card (or the circle with its label) is one button
 * that selects the element (a double click focuses it); it can be dragged, or moved with the keyboard (M, then arrows).
 */
export const ElementCard = memo(function ElementCard({ data }: NodeProps<CardNode>) {
  const { element } = data;
  const circle = data.shape === 'circle';
  const container = data.shape === 'container';
  const badge =
    !circle && data.state !== undefined && !isQuietState(data.state) ? data.state : undefined;
  const name = element.name || <i className="muted">(unnamed)</i>;
  const style =
    circle && data.containerColour !== undefined
      ? ({ '--container-fill': `var(--${data.containerColour}-fill)` } as CSSProperties)
      : undefined;
  return (
    <div
      className={`card ${circle ? 'is-circle ' : ''}${container ? 'is-container ' : ''}${style ? 'is-nested ' : ''}${colourClass(element.type)}${data.focused ? ' is-focus' : ''}${data.selected ? ' is-selected' : ''}${data.moving ? ' is-moving' : ''}${data.drop ? ` is-drop-${data.drop}` : ''}`}
      style={style}
      data-element-id={element.id}
    >
      {circle ? <CircleHandles handles={data.handles} /> : <CardHandles handles={data.handles} />}
      <button
        id={data.domId}
        type="button"
        className="card-main"
        tabIndex={data.tabbable ? 0 : -1}
        aria-label={cardLabel(data)}
        aria-current={data.focused ? 'true' : undefined}
        aria-keyshortcuts={data.connectable ? 'M R' : 'M'}
        title={(circle || container) && data.nameCut ? element.name : undefined}
      >
        {circle && (
          <span className="ccircle">
            <Icon name="user" />
          </span>
        )}
        {container ? (
          <span className="chead">
            <TypeMark type={element.type} />
            <span className="cname">{name}</span>
          </span>
        ) : (
          <span className="cname">{name}</span>
        )}
      </button>
      {data.connectable && (
        <Handle
          id="connect"
          type="source"
          position={Position.Right}
          isConnectable
          className="connect-handle"
          title="Drag to another element to add a relationship"
          aria-hidden="true"
        />
      )}
      {badge !== undefined && <StateBadge state={badge} className="cbadge" />}
      {data.missing > 0 && (
        <button
          id={relatedButtonId(data.domId)}
          type="button"
          className="cpill"
          tabIndex={data.tabbable ? 0 : -1}
          aria-label={relatedButtonLabel(data.missing)}
          aria-haspopup="menu"
          aria-expanded={data.relatedOpen}
          title={relatedButtonTitle(data.missing)}
          onClick={(event) => {
            // Don't let React Flow treat this as a click on the card (which selects the element).
            event.stopPropagation();
            data.onShowRelated(element.id, event.currentTarget);
          }}
        >
          <Icon name="spline" />
          <span className="cpill-n">{pillText(data.missing)}</span>
        </button>
      )}
    </div>
  );
});

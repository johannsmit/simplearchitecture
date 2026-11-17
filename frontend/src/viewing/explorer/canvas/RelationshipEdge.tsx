import type { ArchitectureState, EdgeType } from '@simplearchitecture/shared';
import { BaseEdge, EdgeLabelRenderer, useStore, type Edge, type EdgeProps } from '@xyflow/react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { edgeEnds } from '../../../metamodel-ui';
import { directLine, edgeLine, linePath, simplified, type LineEnd } from './edgeLine';
import { labelLines, placeRestingLabel, placeStateMark } from './labels';
import { bendsOf } from './lineRoutes';
import { dragThreshold } from './positions';
import type { Box, Point } from './positions';

export interface RelationshipData extends Record<string, unknown> {
  type: EdgeType;
  /** What the line shows (`linkText`): its label, selected values or "×3". Empty: nothing. */
  text: string;
  lit: boolean;
  /** Another line or card is lit: a resting label fades with its line. */
  dim?: boolean;
  /** Grayed out by the view: a merged line's count fades with its line. */
  grayed?: boolean;
  /** There is text to show: always placed. */
  resting?: boolean;
  /** Target and Deprecate get a mark on the line and a different line weight. */
  state: ArchitectureState;
  /** Two-way: an arrow at the source too. */
  twoWay?: boolean;
  /** ELK's bends on the canvas, while the route still holds (edgeLine.ts). */
  bends?: readonly Point[];
  /**
   * Without a route: where the line leaves and enters, on the sides where its cards face each
   * other now (`floatingEnds`), in place of its handles.
   */
  ends?: { start: LineEnd; end: LineEnd; points?: readonly Point[] };
  /** A route given by hand (in a view), as it runs with its cards where they are now. */
  route?: readonly Point[];
  /** Its bends show as handles, to be dragged (Modelling, in a view). */
  bendHandles?: boolean;
  /**
   * A press on a bend handle: the canvas decides which bend it grabs (the nearest of those that
   * show), and true when the press may become a drag (the pointer is then captured).
   */
  onBendPress?: (press: LinePress) => boolean;
  /**
   * A press on the line itself (Modelling, in a view): a drag from it pans the canvas, as React
   * Flow keeps its lines from panning. True when the canvas took it.
   */
  onLinePress?: (press: LinePress) => boolean;
  /** Where the line is drawn now, so the canvas can find the bend nearest a press. */
  onLineDrawn?: (linkId: string, line: readonly Point[] | undefined) => void;
  /**
   * While lit, with a resting label, or with a state mark: every card on the canvas, so the label
   * and the mark are placed where they cover none.
   */
  cards?: readonly Box[];
  /** Labels are hidden while a card is dragged, and placed again on the drop. */
  hideLabel?: boolean;
  /** A click on the label or a bend handle: does what a click on the line does. */
  onLineClick?: (clientX: number, clientY: number) => void;
  /**
   * The pointer enters or leaves the label or a bend handle: the line stays lit (and its bends
   * show) while it is on them.
   */
  onLineHover?: (over: boolean) => void;
}

export type RelationshipFlowEdge = Edge<RelationshipData, 'relationship'>;

/** A press of the main pointer button, where it was on the screen. */
export interface LinePress {
  clientX: number;
  clientY: number;
  pointerId: number;
}

export const arrowMarkerId = 'sa-arrow';
export const litArrowMarkerId = 'sa-arrow-lit';
export const diamondMarkerId = 'sa-diamond';
export const litDiamondMarkerId = 'sa-diamond-lit';

/**
 * A relationship: neutral gray with an arrow at the target, at both ends when two-way (Contains: a
 * diamond at the container instead). Lit (accent, wider) while it or one of its cards is hovered or focused.
 * Its text always shows, on the line's middle if every spot covers a card (labels.ts). A line with
 * no text shows nothing, on hover either.
 */
export const RelationshipEdge = memo(function RelationshipEdge(
  props: EdgeProps<RelationshipFlowEdge>,
) {
  const { data, sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition } = props;
  const bends = data?.bends;
  const floatingEnds = data?.ends;
  const route = data?.route;
  const automatic = useMemo(
    () =>
      route
        ? [...route]
        : floatingEnds && !bends
          ? (floatingEnds.points ?? directLine(floatingEnds.start, floatingEnds.end))
          : edgeLine(
              { x: sourceX, y: sourceY, side: sourcePosition },
              { x: targetX, y: targetY, side: targetPosition },
              bends,
            ),
    [
      route,
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      bends,
      floatingEnds,
    ],
  );
  // While a bend is dragged, the canvas gives the line as it would be if dropped (`route`).
  const line = automatic;
  const onBendPress = data?.onBendPress;
  const onLinePress = data?.onLinePress;
  const onLineDrawn = data?.onLineDrawn;
  useEffect(() => {
    if (!onLineDrawn) return;
    onLineDrawn(props.id, line);
    return () => {
      onLineDrawn(props.id, undefined);
    };
  }, [onLineDrawn, props.id, line]);
  const path = useMemo(() => linePath(line), [line]);
  const lit = data?.lit === true;
  const ends = data === undefined ? edgeEnds('Relation') : edgeEnds(data.type);
  const text = data?.text ?? '';
  // Data shows its parts on lines of their own; anything else is one line.
  const lines = useMemo(() => labelLines(text), [text]);
  const cards = data?.cards;
  const state = data?.state ?? 'Current';
  const marked = state !== 'Current';
  const hidden = data?.hideLabel === true;
  const resting = data?.resting === true;
  // Placed when the cards or the line move, not on hover; not at all during a drag.
  const label = useMemo(() => {
    if (!cards || hidden || !resting) return undefined;
    return placeRestingLabel(line, text, marked, cards);
  }, [resting, cards, line, text, marked, hidden]);
  // Placed on layout, Tidy up and drop (when the cards move), not on hover.
  const mark = useMemo(
    () => (marked && cards && !hidden ? placeStateMark(line, cards) : undefined),
    [marked, cards, line, hidden],
  );
  // Where a press on the label started: a press that moved (a pan) opens nothing.
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  return (
    <>
      <g
        onPointerDown={(event) => {
          // The main button only.
          if (!onLinePress || event.button > 0) return;
          const { clientX, clientY, pointerId } = event;
          if (!onLinePress({ clientX, clientY, pointerId })) return;
          // No text selection while panning.
          event.preventDefault();
        }}
      >
        <BaseEdge
          id={props.id}
          path={path}
          {...(ends.start === 'diamond'
            ? { markerStart: `url(#${lit ? litDiamondMarkerId : diamondMarkerId})` }
            : ends.end === 'arrow' && data?.twoWay === true
              ? // The arrow marker is drawn reversed at the start (orient="auto-start-reverse").
                { markerStart: `url(#${lit ? litArrowMarkerId : arrowMarkerId})` }
              : {})}
          {...(ends.end === 'arrow'
            ? { markerEnd: `url(#${lit ? litArrowMarkerId : arrowMarkerId})` }
            : {})}
          // About 20px to click on, so a thin line is easy to hit.
          interactionWidth={20}
        />
      </g>
      {onBendPress && (
        <BendHandles
          linkId={props.id}
          line={line}
          shown={data.bendHandles === true}
          onPress={onBendPress}
          onClick={data.onLineClick}
          onHover={data.onLineHover}
        />
      )}
      {mark && (
        <g
          className={`smark ${state.toLowerCase()}`}
          transform={`translate(${mark.x} ${mark.y})`}
          aria-hidden="true"
        >
          <circle r={7} />
          <path d={statePath(state, 3.5)} />
        </g>
      )}
      {label && !hidden && (
        <EdgeLabelRenderer>
          <div
            className={`edge-label${marked ? ' has-mark' : ''}${lit ? ' is-lit' : ''}${
              data?.grayed === true ? ' is-grayed' : ''
            }${data?.dim === true ? ' is-dim' : ''}`}
            style={{
              maxWidth: label.width,
              transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)`,
            }}
            title={text}
            onPointerDown={(event) => {
              // A drag from the label pans the canvas; a click without a move opens the line.
              pressedAt.current = { x: event.clientX, y: event.clientY };
            }}
            onClick={(event) => {
              // React passes events up from the label to its line (the label is a portal inside
              // it): the label opens its own line, so the line's click (nearest line) doesn't run.
              event.stopPropagation();
              const from = pressedAt.current;
              pressedAt.current = null;
              const moved =
                from !== null &&
                Math.hypot(event.clientX - from.x, event.clientY - from.y) > dragThreshold;
              if (!moved) data?.onLineClick?.(event.clientX, event.clientY);
            }}
            data-line={props.id}
            onMouseEnter={() => data?.onLineHover?.(true)}
            onMouseLeave={(event) => {
              if (!stillOnLine(event.relatedTarget, props.id)) data?.onLineHover?.(false);
            }}
          >
            {marked && <StateMark state={state} />}
            {lines.length === 1 ? (
              <span className="t">{text}</span>
            ) : (
              <span className="tl">
                {lines.map((part, index) => (
                  <span className="t" key={index}>
                    {part}
                  </span>
                ))}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/**
 * True when the pointer left the label or a square for another part of the same line: its stroke,
 * its label or another square. The line then stays pointed at, as React Flow sees no new entry
 * onto a line from its own label or squares (they are drawn elsewhere, but belong to the line).
 */
function stillOnLine(to: EventTarget | null, linkId: string): boolean {
  if (!(to instanceof Element)) return false;
  const id = CSS.escape(linkId);
  return to.closest(`.react-flow__edge[data-id="${id}"], [data-line="${id}"]`) !== null;
}

/** How long bend handles take to fade out, as `--t-fast`. */
const handleFade = 120;

/**
 * A square on each bend of a line, dragged to move the bend. Drawn in the labels' layer, above the
 * cards and labels, and the same size on the screen at every zoom. Hidden from assistive
 * technology: the drop and a cancel are announced by the canvas.
 */
function BendHandles(props: {
  linkId: string;
  line: readonly Point[];
  shown: boolean;
  onPress: (press: LinePress) => boolean;
  onClick: ((clientX: number, clientY: number) => void) | undefined;
  onHover: ((over: boolean) => void) | undefined;
}) {
  const { shown } = props;
  // Hidden handles fade out before they go.
  const [leaving, setLeaving] = useState(false);
  const [wasShown, setWasShown] = useState(shown);
  if (shown !== wasShown) {
    setWasShown(shown);
    setLeaving(!shown);
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => {
      setLeaving(false);
    }, handleFade);
    return () => {
      clearTimeout(timer);
    };
  }, [leaving]);
  const active = shown || leaving;
  // Only lines whose handles show follow the zoom.
  const zoom = useStore((state) => (active ? state.transform[2] : 1));
  const [pressed, setPressed] = useState<number | null>(null);
  // Where the press started: a press that moved (a drag) opens nothing.
  const pressedAt = useRef<{ x: number; y: number } | null>(null);
  const points = useMemo(() => simplified(props.line), [props.line]);
  if (!active) return null;
  return (
    <EdgeLabelRenderer>
      {bendsOf(points).map((index) => {
        const { x, y } = points[index] as Point;
        return (
          <div
            key={index}
            // Not a pan of the canvas, nor a drag of a card.
            className={`bend-handle nopan nodrag${shown ? '' : ' is-leaving'}${
              pressed === index ? ' is-pressed' : ''
            }`}
            data-line={props.linkId}
            aria-hidden="true"
            style={{
              transform: `translate(${x}px, ${y}px) scale(${1 / (zoom || 1)}) translate(-50%, -50%)`,
            }}
            onPointerDown={(event) => {
              // The main button only.
              if (!shown || event.button > 0) return;
              pressedAt.current = { x: event.clientX, y: event.clientY };
              const { clientX, clientY, pointerId } = event;
              if (!props.onPress({ clientX, clientY, pointerId })) return;
              // No text selection while dragging.
              event.preventDefault();
              setPressed(index);
              if (typeof event.currentTarget.setPointerCapture === 'function') {
                event.currentTarget.setPointerCapture(pointerId);
              }
            }}
            onPointerUp={() => {
              setPressed(null);
            }}
            onLostPointerCapture={() => {
              setPressed(null);
            }}
            onClick={(event) => {
              // The handle is part of its line: a click opens it, not the line under it.
              event.stopPropagation();
              const from = pressedAt.current;
              pressedAt.current = null;
              const moved =
                from !== null &&
                Math.hypot(event.clientX - from.x, event.clientY - from.y) > dragThreshold;
              if (!moved) props.onClick?.(event.clientX, event.clientY);
            }}
            onMouseEnter={() => props.onHover?.(true)}
            onMouseLeave={(event) => {
              if (!stillOnLine(event.relatedTarget, props.linkId)) props.onHover?.(false);
            }}
          />
        );
      })}
    </EdgeLabelRenderer>
  );
}

/** The glyph of a state mark, centred on 0,0: plus for Target, minus for Deprecate. */
export function statePath(state: ArchitectureState, half: number): string {
  const minus = `M${-half} 0H${half}`;
  return state === 'Target' ? `${minus}M0 ${-half}V${half}` : minus;
}

/** The 12px state mark at the start of a lit label, and in the legend. */
export function StateMark({ state }: { state: ArchitectureState }) {
  return (
    <span className={`lmark ${state.toLowerCase()}`} aria-hidden="true">
      <svg viewBox="-3 -3 6 6" focusable="false">
        <path d={statePath(state, 3)} />
      </svg>
    </span>
  );
}

/** Arrowheads and diamonds (Contains, at the container's end), referenced by id from the edges. */
export function EdgeMarkers() {
  return (
    <svg className="edge-markers" aria-hidden="true" focusable="false">
      <defs>
        {[arrowMarkerId, litArrowMarkerId].map((id) => (
          <marker
            key={id}
            id={id}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth={id === arrowMarkerId ? 10 : 11}
            markerHeight={id === arrowMarkerId ? 10 : 11}
            orient="auto-start-reverse"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0,0 L10,5 L0,10 Z" className={id === arrowMarkerId ? 'mk' : 'mk-lit'} />
          </marker>
        ))}
        {[diamondMarkerId, litDiamondMarkerId].map((id) => (
          <marker
            key={id}
            id={id}
            viewBox="0 0 12 8"
            refX="0"
            refY="4"
            markerWidth={12}
            markerHeight={8}
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0,4 L6,0 L12,4 L6,8 Z" className={id === diamondMarkerId ? 'mk' : 'mk-lit'} />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

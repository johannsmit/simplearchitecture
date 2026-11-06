import type { nodeTypes } from '@simplearchitecture/shared';
import { useId, useState } from 'react';
import { Icon } from '../../icons';
import { TypeMark } from '../../metamodel-ui';
import { statePath } from './canvas/RelationshipEdge';
import { readLegendOpen, writeLegendOpen } from './prefs';

/**
 * The legend, at the bottom of the left panel while a canvas is drawn: the element types on the
 * canvas, the relationship state marks, and the "Nest contained elements" and "Show relationships"
 * switches. Open or closed is remembered per browser.
 */
export function Legend(props: {
  types: readonly (typeof nodeTypes)[number][];
  nest: boolean;
  onToggleNest: () => void;
  lines: boolean;
  onToggleLines: () => void;
}) {
  const [open, setOpen] = useState(readLegendOpen);
  const bodyId = useId();
  return (
    <div className="psec legend">
      <button
        type="button"
        className="psec-head"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => {
          setOpen(!open);
          writeLegendOpen(!open);
        }}
      >
        <Icon name="chev-right" size="sm" />
        Legend
      </button>
      {open && (
        <div id={bodyId} className="psec-body legend-body">
          {/* h2: the legend comes right after the page's h1 (axe heading-order). */}
          <h2>Elements</h2>
          <ul>
            {props.types.map((type) => (
              <li key={type}>
                <TypeMark type={type} />
                {type}
              </li>
            ))}
          </ul>
          <h2>Relationship state</h2>
          <ul>
            {(['Target', 'Deprecate'] as const).map((state) => (
              <li key={state}>
                <StateSample state={state} />
                {state}
              </li>
            ))}
          </ul>
          <label className="nest" title="Draw contained elements inside their container">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={props.nest}
              onChange={props.onToggleNest}
            />
            <span className="lname">Nest contained elements</span>
          </label>
          <label className="lines" title="Draw the relationship lines">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={props.lines}
              onChange={props.onToggleLines}
            />
            <span className="lname">Show relationships</span>
          </label>
        </div>
      )}
    </div>
  );
}

/** A 28px line sample with a 12px state mark, as in the legend. */
function StateSample({ state }: { state: 'Target' | 'Deprecate' }) {
  return (
    <svg className="edge-sample" width="28" height="12" aria-hidden="true" focusable="false">
      <path className="lsample" d="M1 6h22" />
      <path className="mk" d="M21 2l6 4-6 4z" />
      <g className={`smark ${state.toLowerCase()} legend-mark`} transform="translate(11 6)">
        <circle r={6} />
        <path d={statePath(state, 3)} />
      </g>
    </svg>
  );
}

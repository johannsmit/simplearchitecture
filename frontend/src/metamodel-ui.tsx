import {
  edgeTypeDefinitions,
  nodeTypeDefinitions,
  type ArchitectureState,
  type EdgeType,
  type ModelRelationship,
  type NodeType,
} from '@simplearchitecture/shared';
import { Icon } from './icons';

/**
 * How the metamodel looks. Colours, icons and line styles come from shared/src/metamodel.ts;
 * nothing here names a node or edge type.
 */

/** Class that sets --fill and --line (tokens.css) from the type's metamodel colour. */
export function colourClass(type: NodeType): string {
  return `colour-${nodeTypeDefinitions[type].colour}`;
}

/** The type's mark: its icon in a circle when the metamodel gives one, else a colour swatch. */
export function TypeMark({ type }: { type: NodeType }) {
  return nodeTypeDefinitions[type].icon === 'user' ? (
    <span className={`uicon ${colourClass(type)}`} aria-hidden="true">
      <Icon name="user" />
    </span>
  ) : (
    <span className={`swatch ${colourClass(type)}`} aria-hidden="true" />
  );
}

/**
 * How the type's elements are drawn on the canvas: a circle with the name underneath for a type
 * with the user icon (people: Stakeholder today), else a rectangle card.
 */
export function cardShape(type: NodeType): 'card' | 'circle' {
  return nodeTypeDefinitions[type].icon === 'user' ? 'circle' : 'card';
}

/**
 * The default Architecture state. Cards show no badge for it, so the exceptions (Target,
 * Deprecate) stand out. The details panel still shows it.
 */
const quietState: ArchitectureState = 'Current';

export function isQuietState(state: ArchitectureState): boolean {
  return state === quietState;
}

/** Architecture state as a pill with a coloured dot; the word is always shown. */
export function StateBadge({ state, className }: { state: ArchitectureState; className?: string }) {
  return (
    <span className={`badge state-${state.toLowerCase()}${className ? ` ${className}` : ''}`}>
      {state}
    </span>
  );
}

/**
 * The marks at the ends of an edge type's line: an arrowhead at the target, or (for a containing
 * type, `line: 'contains'`) a filled diamond at the source, the container, and nothing at the
 * target.
 */
export function edgeEnds(type: EdgeType): { start: 'diamond' | 'none'; end: 'arrow' | 'none' } {
  return edgeTypeDefinitions[type].line === 'contains'
    ? { start: 'diamond', end: 'none' }
    : { start: 'none', end: 'arrow' };
}

/** The line under a relationship panel's back link, e.g. "Relation · Both ways". */
export function relationshipTypeLine(relationship: ModelRelationship): string {
  return [relationship.type, ...(relationship.twoWay === true ? ['Both ways'] : [])].join(' · ');
}

/** A 28px line sample with its end marks; two-way: an arrow at both ends. */
export function EdgeSample({ type, twoWay = false }: { type: EdgeType; twoWay?: boolean }) {
  const ends = edgeEnds(type);
  return (
    <svg className="edge-sample" width="28" height="10" aria-hidden="true" focusable="false">
      {ends.start === 'diamond' ? (
        <>
          <path className="lsample" d="M11 5H27" />
          <path className="mk" d="M1 5 6 1.5 11 5 6 8.5Z" />
        </>
      ) : (
        <>
          <path className="lsample" d={twoWay ? 'M5 5h18' : 'M1 5h22'} />
          <path className="mk" d="M21 1l6 4-6 4z" />
          {twoWay && <path className="mk" d="M7 1 1 5l6 4z" />}
        </>
      )}
    </svg>
  );
}

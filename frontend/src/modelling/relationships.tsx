import {
  architectureStates,
  compareNames,
  containersOf,
  containerOf,
  containsType,
  edgeTypes,
  relationshipProblems,
  relationshipsOf,
  relationshipVerb,
  searchElements,
  type ArchitectureState,
  type EdgeType,
  type ElementIdSet,
  type ModelElement,
  type ModelGraph,
  type RelationshipChangeResult,
  type RelationshipProblem,
} from '@simplearchitecture/shared';
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ApiRequestError, createRelationship } from '../api';
import { Icon } from '../icons';
import { EdgeSample, TypeMark } from '../metamodel-ui';
import { StateMark } from '../viewing/explorer/canvas/RelationshipEdge';

/** Relationship parts shared by the New relationship popover, Add relationship and the form. */

export const nameOf = (graph: ModelGraph, id: string): string =>
  graph.elements.get(id)?.name || '(unnamed)';

/**
 * "Billing Engine relates to Ledger" ("… to itself" for a self-relationship); two-way:
 * "Billing Engine relates both ways to Ledger".
 */
export function relationshipSentence(
  graph: ModelGraph,
  ends: {
    source: string;
    target: string;
    type: EdgeType;
    twoWay?: boolean;
  },
): string {
  const target = ends.source === ends.target ? 'itself' : nameOf(graph, ends.target);
  const direction = ends.twoWay === true ? 'both' : 'outgoing';
  const verb = relationshipVerb(ends.type, direction);
  return `${nameOf(graph, ends.source)} ${verb} ${target}`;
}

/** The refusal per type for these ends (undefined: allowed). */
export function problemsByType(
  graph: ModelGraph,
  source: string,
  target: string,
  ignore?: string,
): Map<EdgeType, RelationshipProblem | undefined> {
  return new Map(
    edgeTypes.map((type) => [
      type,
      relationshipProblems(graph, { source, target, type, ...(ignore ? { ignore } : {}) })[0],
    ]),
  );
}

/** The first allowed type: a new relationship starts as a Relation when it can. */
export function preselectedType(
  problems: ReadonlyMap<EdgeType, RelationshipProblem | undefined>,
): EdgeType | undefined {
  return edgeTypes.find((type) => problems.get(type) === undefined);
}

/**
 * The note under the type for a Contains: a warning when the target already has
 * another container, else what nesting will do. Undefined for other types.
 */
export function containsNote(
  graph: ModelGraph,
  source: string,
  target: string,
  nest: boolean,
): { kind: 'info' | 'warning'; text: string } | undefined {
  const others = containersOf(graph, target).filter((id) => id !== source);
  if (others.length > 0) {
    return {
      kind: 'warning',
      text: `${nameOf(graph, target)} is also in ${nameOf(graph, others[0] as string)}. It's nested in only one of them; the other Contains is drawn as a line.`,
    };
  }
  if (!nest || containerOf(graph, target) === source) return undefined;
  return {
    kind: 'info',
    text: `Tidy up then nests ${nameOf(graph, target)} in ${nameOf(graph, source)}.`,
  };
}

export function TypeNote({ note, id }: { note: ReturnType<typeof containsNote>; id?: string }) {
  if (!note) return null;
  return (
    <p className={note.kind === 'warning' ? 'hint warn-note' : 'type-note'} id={id}>
      <Icon name={note.kind === 'warning' ? 'alert' : 'info'} size="sm" />
      <span>{note.text}</span>
    </p>
  );
}

/** What a refused change says, from an API error (422 fields, `duplicateOf`, or a message). */
export interface Refusal {
  fields: { field: string; message: string }[];
  duplicateOf?: string;
  status: number;
  message: string;
}

export function refusalOf(failure: unknown): Refusal {
  const status = failure instanceof ApiRequestError ? failure.status : 0;
  const body = (failure instanceof ApiRequestError ? failure.body : undefined) as
    { fields?: unknown; duplicateOf?: unknown } | undefined;
  const fields = Array.isArray(body?.fields)
    ? (body.fields as { field?: unknown; message?: unknown }[]).flatMap((issue) =>
        typeof issue.message === 'string'
          ? [{ field: typeof issue.field === 'string' ? issue.field : '', message: issue.message }]
          : [],
      )
    : [];
  return {
    fields,
    ...(typeof body?.duplicateOf === 'string' ? { duplicateOf: body.duplicateOf } : {}),
    status,
    message:
      status === 0 || status >= 500
        ? 'Check your connection and try again.'
        : fields.map((issue) => issue.message).join(' ') ||
          (failure instanceof Error ? failure.message : ''),
  };
}

interface TypeRadiosProps {
  name: string;
  value: EdgeType | undefined;
  onChange: (type: EdgeType) => void;
  /** The refusal per type; a refused type is disabled with its reason. */
  problems?: ReadonlyMap<EdgeType, RelationshipProblem | undefined>;
  onShow?: (relationshipId: string) => void;
  disabled?: boolean;
  /** Below the radios (e.g. the Contains note). */
  children?: ReactNode;
  describedBy?: string;
}

/** The relationship types as radios with their line samples. */
export function TypeRadios(props: TypeRadiosProps) {
  const id = useId();
  return (
    <fieldset className="type-radios rel-types" aria-describedby={props.describedBy}>
      <legend>Type</legend>
      {edgeTypes.map((type) => {
        const problem = props.problems?.get(type);
        return (
          <div key={type} className={`rel-type${problem ? ' is-refused' : ''}`}>
            <label className="radio-row">
              <input
                type="radio"
                name={props.name}
                value={type}
                checked={props.value === type}
                disabled={props.disabled === true || problem !== undefined}
                aria-describedby={problem ? `${id}-${type.replace(/\W/g, '')}` : undefined}
                onChange={() => {
                  props.onChange(type);
                }}
              />
              <EdgeSample type={type} />
              {type}
            </label>
            {problem && (
              <TypeReason
                id={`${id}-${type.replace(/\W/g, '')}`}
                problem={problem}
                onShow={props.onShow}
              />
            )}
          </div>
        );
      })}
      {props.children}
    </fieldset>
  );
}

/** Why a type is refused, with "Show it" for a duplicate. */
function TypeReason(props: {
  id: string;
  problem: RelationshipProblem;
  onShow: ((relationshipId: string) => void) | undefined;
  /** The full message even for a duplicate, when the reason doesn't sit next to its type. */
  full?: boolean;
}) {
  const { problem, onShow } = props;
  return (
    <p className="rel-reason" id={props.id}>
      {problem.kind === 'duplicate' && props.full !== true ? 'Already exists.' : problem.message}
      {problem.kind === 'duplicate' && onShow && (
        <>
          {' '}
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              onShow(problem.duplicateOf);
            }}
          >
            Show it
          </button>
        </>
      )}
    </p>
  );
}

/** The relationship types as a segmented radio group, in the Direction control's style. */
export function TypeSegments(props: TypeRadiosProps) {
  const id = useId();
  const reasonId = (type: EdgeType) => `${id}-${type.replace(/\W/g, '')}`;
  return (
    <fieldset className="state-segs type-segs" aria-describedby={props.describedBy}>
      <legend>Type</legend>
      <div className="seg-radios">
        {edgeTypes.map((type) => {
          const problem = props.problems?.get(type);
          const classes = [props.value === type && 'is-checked', problem && 'is-refused']
            .filter(Boolean)
            .join(' ');
          return (
            <label key={type} className={classes || undefined}>
              <input
                type="radio"
                className="vh"
                name={props.name}
                value={type}
                checked={props.value === type}
                disabled={props.disabled === true || problem !== undefined}
                aria-describedby={problem ? reasonId(type) : undefined}
                onChange={() => {
                  props.onChange(type);
                }}
              />
              <EdgeSample type={type} />
              {type}
            </label>
          );
        })}
      </div>
      {edgeTypes.map((type) => {
        const problem = props.problems?.get(type);
        return (
          problem && (
            <TypeReason
              key={type}
              id={reasonId(type)}
              full
              problem={problem}
              onShow={props.onShow}
            />
          )
        );
      })}
      {props.children}
    </fieldset>
  );
}

/** "Direction: One way / Both ways", in the state's segmented style. */
export function DirectionSegments(props: {
  name: string;
  twoWay: boolean;
  onChange: (twoWay: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="state-segs">
      <legend>Direction</legend>
      <div className="seg-radios">
        {[false, true].map((both) => (
          <label key={String(both)} className={props.twoWay === both ? 'is-checked' : undefined}>
            <input
              type="radio"
              className="vh"
              name={props.name}
              value={both ? 'both' : 'one'}
              checked={props.twoWay === both}
              disabled={props.disabled}
              onChange={() => {
                props.onChange(both);
              }}
            />
            <span aria-hidden="true">{both ? '↔' : '→'}</span>
            {both ? 'Both ways' : 'One way'}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Architecture state as a segmented radio group: Deprecate, Current, Target. */
export function StateSegments(props: {
  name: string;
  value: ArchitectureState;
  onChange: (state: ArchitectureState) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="state-segs">
      <legend>Architecture state</legend>
      <div className="seg-radios">
        {architectureStates.map((state) => (
          <label key={state} className={props.value === state ? 'is-checked' : undefined}>
            <input
              type="radio"
              className="vh"
              name={props.name}
              value={state}
              checked={props.value === state}
              disabled={props.disabled}
              onChange={() => {
                props.onChange(state);
              }}
            />
            {state !== 'Current' && <StateMark state={state} />}
            {state}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface NewRelationshipPopoverProps {
  modelId: string;
  graph: ModelGraph;
  source: string;
  target: string;
  /** Where it opens, in the canvas's coordinates (already kept inside it). */
  style: CSSProperties;
  nest: boolean;
  onAdded: (result: RelationshipChangeResult) => void;
  onCancel: () => void;
  onShow: (relationshipId: string) => void;
}

/** "New relationship" after a line is dropped on a card. */
export function NewRelationshipPopover(props: NewRelationshipPopoverProps) {
  const { graph, source, target } = props;
  const id = useId();
  const problems = problemsByType(graph, source, target);
  const [type, setType] = useState<EdgeType | undefined>(() => preselectedType(problems));
  const [state, setState] = useState<ArchitectureState>('Current');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(props.onCancel);
  useEffect(() => {
    cancelRef.current = props.onCancel;
  });
  const busy = useRef(false);

  useEffect(() => {
    const checked = box.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    (checked ?? box.current?.querySelector<HTMLButtonElement>('.pop-buttons .btn'))?.focus();
    const onPointer = (event: MouseEvent) => {
      if (busy.current || box.current?.contains(event.target as Node)) return;
      cancelRef.current();
    };
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('mousedown', onPointer);
    };
  }, []);

  const add = async () => {
    if (adding || type === undefined) return;
    setAdding(true);
    busy.current = true;
    setError(null);
    try {
      const result = await createRelationship(props.modelId, {
        source,
        target,
        type,
        architectureState: state,
      });
      props.onAdded(result);
    } catch (failure) {
      setAdding(false);
      busy.current = false;
      setError(`The relationship wasn't added. ${refusalOf(failure).message}`.trim());
    }
  };

  const note = type === containsType ? containsNote(graph, source, target, props.nest) : undefined;
  const source_ = graph.elements.get(source);
  const target_ = graph.elements.get(target);
  return (
    <div
      ref={box}
      className="rel-pop"
      role="dialog"
      aria-labelledby={`${id}-title`}
      style={props.style}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!adding) props.onCancel();
        }
      }}
    >
      <form
        noValidate
        aria-busy={adding || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <h2 className="new-title" id={`${id}-title`}>
          New relationship
        </h2>
        {error !== null && (
          <p className="form-alert" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
        <p className="rel-ends">
          {source_ && <TypeMark type={source_.type} />}
          <span className="rel-end">{nameOf(graph, source)}</span>
          <span className="muted"> → </span>
          {target_ && <TypeMark type={target_.type} />}
          <span className="rel-end">{nameOf(graph, target)}</span>
        </p>
        <TypeRadios
          name={`${id}-type`}
          value={type}
          onChange={setType}
          problems={problems}
          onShow={props.onShow}
          disabled={adding}
        >
          <div aria-live="polite">
            <TypeNote note={note} />
          </div>
        </TypeRadios>
        <StateSegments name={`${id}-state`} value={state} onChange={setState} disabled={adding} />
        <div className="pop-buttons">
          <button type="button" className="btn" disabled={adding} onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={type === undefined}
            aria-disabled={adding || undefined}
          >
            {adding && <span className="spinner sm" aria-hidden="true" />}
            {adding ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** The most search results listed. */
export const pickLimit = 50;

interface AddRelationshipBoxProps {
  modelId: string;
  graph: ModelGraph;
  element: ModelElement;
  /** The elements on the canvas: listed while the search is empty. */
  onCanvas: ElementIdSet & Iterable<string>;
  nest: boolean;
  onAdded: (result: RelationshipChangeResult) => void;
  onClose: () => void;
  onShow: (relationshipId: string) => void;
}

/** Add relationship in the element's Relationships section: the non-drag way. */
export function AddRelationshipBox(props: AddRelationshipBoxProps) {
  const { graph, element } = props;
  const id = useId();
  const [type, setType] = useState<EdgeType>(edgeTypes[0]);
  const [direction, setDirection] = useState<'outgoing' | 'incoming'>('outgoing');
  const [state, setState] = useState<ArchitectureState>('Current');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [addedAny, setAddedAny] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const pickedField = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLFormElement>(null);

  useEffect(() => {
    box.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, []);

  const trimmed = query.trim();
  const options: ModelElement[] =
    trimmed === ''
      ? [...props.onCanvas]
          .flatMap((other) => graph.elements.get(other) ?? [])
          .sort((a, b) => compareNames(a.name, b.name))
      : searchElements(graph, trimmed).sort((a, b) => compareNames(a.name, b.name));
  const shownOptions = options.slice(0, pickLimit);
  const activeOption = shownOptions[Math.min(active, shownOptions.length - 1)];

  const ends = (other: string) =>
    direction === 'outgoing'
      ? { source: element.id, target: other }
      : { source: other, target: element.id };
  const related = new Set(
    relationshipsOf(graph, element.id)
      .filter((r) => r.type === type)
      .map((r) =>
        direction === 'outgoing'
          ? r.source === element.id && r.target
          : r.target === element.id && r.source,
      )
      .filter((other): other is string => typeof other === 'string'),
  );
  const problem =
    picked === null ? undefined : relationshipProblems(graph, { ...ends(picked), type })[0];
  const note =
    picked !== null && type === containsType
      ? containsNote(graph, ends(picked).source, ends(picked).target, props.nest)
      : undefined;

  const pick = (other: ModelElement) => {
    if (other.id === element.id) return;
    setPicked(other.id);
    setPickError(null);
    requestAnimationFrame(() => {
      box.current?.querySelector<HTMLInputElement>('.state-segs input:checked')?.focus();
    });
  };

  const add = async () => {
    if (adding) return;
    if (picked === null) {
      setPickError('Pick the other element.');
      search.current?.focus();
      return;
    }
    if (problem) {
      pickedField.current?.querySelector('button')?.focus();
      return;
    }
    setAdding(true);
    setError(null);
    try {
      const result = await createRelationship(props.modelId, {
        ...ends(picked),
        type,
        architectureState: state,
      });
      setAdding(false);
      setAddedAny(true);
      setPicked(null);
      setQuery('');
      props.onAdded(result);
      requestAnimationFrame(() => search.current?.focus());
    } catch (failure) {
      setAdding(false);
      setError(`The relationship wasn't added. ${refusalOf(failure).message}`.trim());
    }
  };

  const pickedElement = picked === null ? undefined : graph.elements.get(picked);
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-opt-${index}`;
  const verb = relationshipVerb(type, 'outgoing');
  const thisName = element.name || '(unnamed)';
  return (
    <form
      ref={box}
      className="add-rel"
      role="group"
      aria-labelledby={`${id}-title`}
      noValidate
      aria-busy={adding || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void add();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        if (!adding) props.onClose();
      }}
    >
      <div className="add-rel-title">
        <h4 id={`${id}-title`}>Add relationship</h4>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close Add relationship"
          title="Close"
          onClick={props.onClose}
        >
          <Icon name="x" />
        </button>
      </div>
      {error !== null && (
        <p className="form-alert" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
      <TypeRadios name={`${id}-type`} value={type} onChange={setType} disabled={adding} />
      <fieldset className="type-radios">
        <legend>Direction</legend>
        {(['outgoing', 'incoming'] as const).map((value) => (
          <label key={value} className="radio-row">
            <input
              type="radio"
              name={`${id}-direction`}
              checked={direction === value}
              disabled={adding}
              onChange={() => {
                setDirection(value);
              }}
            />
            {value === 'outgoing' ? (
              <span>
                <b>{thisName}</b> {verb} …
              </span>
            ) : (
              <span>
                … {verb} <b>{thisName}</b>
              </span>
            )}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={`${id}-search`}>Other element</label>
        {pickedElement ? (
          <div className="picked" ref={pickedField}>
            <TypeMark type={pickedElement.type} />
            <span className="pname" title={pickedElement.name}>
              {pickedElement.name || '(unnamed)'}
            </span>
            <span className="rtype">{pickedElement.type}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="Change other element"
              aria-describedby={problem ? `${id}-problem` : undefined}
              onClick={() => {
                setPicked(null);
                requestAnimationFrame(() => search.current?.focus());
              }}
            >
              <Icon name="x" />
            </button>
          </div>
        ) : (
          <>
            <div className="search pick-search">
              <Icon name="search" />
              <input
                ref={search}
                id={`${id}-search`}
                type="search"
                role="combobox"
                autoComplete="off"
                placeholder="Search elements…"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={
                  activeOption ? optionId(shownOptions.indexOf(activeOption)) : undefined
                }
                aria-invalid={pickError !== null || undefined}
                aria-describedby={pickError !== null ? `${id}-pick-error` : undefined}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                  setPickError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    const step = event.key === 'ArrowDown' ? 1 : -1;
                    setActive((at) => Math.max(0, Math.min(shownOptions.length - 1, at + step)));
                  } else if (event.key === 'Enter') {
                    event.preventDefault();
                    if (activeOption) pick(activeOption);
                  } else if (event.key === 'Escape' && query !== '') {
                    event.preventDefault();
                    setQuery('');
                  }
                }}
              />
            </div>
            <ul className="pick-list" id={listId} role="listbox" aria-label="Elements">
              {trimmed === '' ? (
                <li role="presentation" className="pick-caption">
                  On the canvas
                </li>
              ) : (
                <li role="presentation" className="pick-caption">
                  {options.length === 1 ? '1 match' : `${options.length} matches`}
                </li>
              )}
              {shownOptions.map((option, index) => {
                const self = option.id === element.id;
                return (
                  <li
                    key={option.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={option === activeOption}
                    aria-disabled={self || undefined}
                    className={option === activeOption ? 'is-active' : undefined}
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => {
                      pick(option);
                    }}
                  >
                    <TypeMark type={option.type} />
                    <span className="pname" title={option.name}>
                      {option.name || '(unnamed)'}
                    </span>
                    {!self && related.has(option.id) && (
                      <span className="pnote">Already related</span>
                    )}
                    <span className="rtype">{self ? 'This element' : option.type}</span>
                  </li>
                );
              })}
              {options.length > pickLimit && (
                <li role="presentation" className="pick-more">
                  Showing {pickLimit} of {options.length}. Keep typing to narrow it down.
                </li>
              )}
              {trimmed !== '' && options.length === 0 && (
                <li role="presentation" className="pick-more">
                  No elements match “{trimmed}”.
                </li>
              )}
            </ul>
          </>
        )}
        {pickError !== null && (
          <p className="field-error" id={`${id}-pick-error`}>
            <Icon name="alert" size="sm" />
            {pickError}
          </p>
        )}
        {problem && (
          <p className="field-error" id={`${id}-problem`}>
            <Icon name="alert" size="sm" />
            {problem.message}
            {problem.kind === 'duplicate' && (
              <>
                {' '}
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => {
                    props.onShow(problem.duplicateOf);
                  }}
                >
                  Show it
                </button>
              </>
            )}
          </p>
        )}
        <TypeNote note={note} />
      </div>
      <StateSegments name={`${id}-state`} value={state} onChange={setState} disabled={adding} />
      <div className="pop-buttons">
        <button type="button" className="btn" disabled={adding} onClick={props.onClose}>
          {addedAny ? 'Close' : 'Cancel'}
        </button>
        <button
          type="submit"
          className="btn primary"
          aria-disabled={adding || picked === null || problem !== undefined || undefined}
        >
          {adding && <span className="spinner sm" aria-hidden="true" />}
          {adding ? 'Adding…' : 'Add'}
        </button>
      </div>
    </form>
  );
}

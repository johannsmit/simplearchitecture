import {
  nodeTypes,
  normaliseForSearch,
  type ElementChangeResult,
  type ModelElement,
  type ModelGraph,
  type NodeType,
} from '@simplearchitecture/shared';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { ApiRequestError, createElement } from '../api';
import { Icon } from '../icons';
import { TypeMark } from '../metamodel-ui';
import { sameNameCount, sameNameNote } from './draft';

interface NewElementProps {
  modelId: string;
  graph: ModelGraph;
  /** The focused element's type, else the metamodel's first. */
  defaultType: NodeType | undefined;
  /** Opening goes through the unsaved changes dialog first. */
  onOpenRequest: (open: () => void) => void;
  onCreated: (result: ElementChangeResult) => void;
  /** Add to canvas on a name match: use that element instead. */
  onExisting?: (element: ModelElement) => void;
  isOnCanvas?: (id: string) => boolean;
  /** The name match's button text in place of Add/Show on canvas (the catalog: Show in catalog). */
  existingLabel?: string;
}

/** The most name matches New element lists. */
export const nameMatchLimit = 5;

/**
 * Elements of any type whose name is the typed one (ignoring case, accents and surrounding
 * spaces), in metamodel type order, at most `nameMatchLimit`.
 */
export function nameMatches(graph: ModelGraph, name: string): ModelElement[] {
  const needle = normaliseForSearch(name.trim());
  if (needle === '') return [];
  return [...graph.elements.values()]
    .filter((element) => normaliseForSearch(element.name.trim()) === needle)
    .sort((a, b) => nodeTypes.indexOf(a.type) - nodeTypes.indexOf(b.type))
    .slice(0, nameMatchLimit);
}

/** "+ New element" at the top of the element list, with its popover: a name and a type. */
export function NewElement({
  modelId,
  graph,
  defaultType,
  onOpenRequest,
  onCreated,
  onExisting,
  isOnCanvas,
  existingLabel,
}: NewElementProps) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className="new-element">
      <button
        ref={button}
        type="button"
        className="btn new-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            onOpenRequest(() => {
              setOpen(true);
            });
          }
        }}
      >
        <Icon name="plus" />
        New element
      </button>
      {open && (
        <NewElementForm
          modelId={modelId}
          graph={graph}
          defaultType={defaultType}
          opener={button}
          onClose={(focusOpener) => {
            setOpen(false);
            if (focusOpener) button.current?.focus();
          }}
          onCreated={(result) => {
            setOpen(false);
            onCreated(result);
          }}
          {...(onExisting
            ? {
                onExisting: (element: ModelElement) => {
                  setOpen(false);
                  onExisting(element);
                },
              }
            : {})}
          {...(isOnCanvas ? { isOnCanvas } : {})}
          {...(existingLabel === undefined ? {} : { existingLabel })}
        />
      )}
    </div>
  );
}

interface NewElementFormProps {
  modelId: string;
  graph: ModelGraph;
  defaultType: NodeType | undefined;
  /** Closed without creating: by Esc or Cancel (true: focus back to the opener) or outside. */
  onClose: (focusOpener: boolean) => void;
  onCreated: (result: ElementChangeResult) => void;
  /** The button that opened it: a click there isn't "outside". */
  opener?: RefObject<HTMLElement | null>;
  /** E.g. "Then choose the relationship from …" (a line dropped on empty canvas). */
  hint?: ReactNode;
  /** Use an existing element whose name matches (no element is created). */
  onExisting?: (element: ModelElement) => void;
  /** Whether a matching element is on the canvas already ("Show on canvas"). */
  isOnCanvas?: (id: string) => boolean;
  existingLabel?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * The New element popover: a name and a type. Used by the element list's
 * button and on the canvas (double-click, `N`, a line dropped on empty canvas).
 */
export function NewElementForm({
  modelId,
  graph,
  defaultType,
  onClose,
  onCreated,
  opener,
  hint,
  onExisting,
  isOnCanvas,
  existingLabel,
  className,
  style,
}: NewElementFormProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<NodeType>(defaultType ?? nodeTypes[0]);
  const [creating, setCreating] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  const close = (focusOpener = true) => {
    if (creating) return;
    onClose(focusOpener);
  };

  useEffect(() => {
    input.current?.focus();
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (box.current?.contains(target) || opener?.current?.contains(target)) return;
      closeRef.current(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('mousedown', onPointer);
    };
  }, [opener]);

  const create = async () => {
    if (creating) return;
    const trimmed = name.trim();
    if (trimmed === '') {
      setNameError('Enter a name.');
      input.current?.focus();
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const result = await createElement(modelId, { type, name: trimmed });
      setCreating(false);
      onCreated(result);
    } catch (failure) {
      setCreating(false);
      const status = failure instanceof ApiRequestError ? failure.status : 0;
      const fields = (failure instanceof ApiRequestError ? failure.body : undefined) as
        { fields?: { field?: unknown; message?: unknown }[] } | undefined;
      const nameMessages = (status === 422 ? (fields?.fields ?? []) : [])
        .filter((f) => f.field === 'name' && typeof f.message === 'string')
        .map((f) => String(f.message));
      if (nameMessages.length > 0) {
        setNameError(nameMessages.join(' '));
        input.current?.focus();
      } else if (status === 0 || status >= 500) {
        setError("The element wasn't created. Check your connection and try again.");
      } else {
        const message = failure instanceof Error ? ` ${failure.message}` : '';
        setError(`The element wasn't created.${message}`);
      }
    }
  };

  // With somewhere to put an existing element, the name matches replace the duplicate note.
  const matches = onExisting ? nameMatches(graph, name) : [];
  const note =
    matches.length > 0
      ? matches.length === 1
        ? `An element is already called “${name.trim()}”. Use it, or create a new one.`
        : `${matches.length} elements are already called “${name.trim()}”. Use one, or create a new one.`
      : onExisting
        ? undefined
        : sameNameNote(sameNameCount(graph, type, name), type, name);

  return (
    <div
      ref={box}
      className={`new-pop${className ? ` ${className}` : ''}`}
      style={style}
      role="dialog"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && !box.current?.contains(next) && !opener?.current?.contains(next)) {
          close(false);
        }
      }}
    >
      <form
        noValidate
        aria-busy={creating || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <h2 className="new-title" id={`${id}-title`}>
          New element
        </h2>
        {hint && <p className="hint new-hint">{hint}</p>}
        <div className="field">
          <label htmlFor={`${id}-name`}>
            Name <span className="req">Required</span>
          </label>
          <input
            ref={input}
            id={`${id}-name`}
            required
            aria-required="true"
            aria-invalid={nameError !== null || undefined}
            aria-describedby={
              [nameError !== null && `${id}-error`, note && `${id}-note`]
                .filter(Boolean)
                .join(' ') || undefined
            }
            value={name}
            readOnly={creating}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
          />
          {nameError !== null && (
            <p className="field-error" id={`${id}-error`}>
              <Icon name="alert" size="sm" />
              {nameError}
            </p>
          )}
          {note && (
            <p className="hint dup-note" id={`${id}-note`}>
              <Icon name="info" size="sm" />
              {note}
            </p>
          )}
          {matches.length > 0 && (
            <ul className="name-matches" aria-label="Elements with this name">
              {matches.map((match) => {
                const shown = isOnCanvas?.(match.id) === true;
                const label = existingLabel ?? (shown ? 'Show on canvas' : 'Add to canvas');
                return (
                  <li key={match.id}>
                    <TypeMark type={match.type} />
                    <span className="pname" title={match.name}>
                      {match.name || '(unnamed)'}
                    </span>
                    <span className="rtype">{match.type}</span>
                    <button
                      type="button"
                      className="linkbtn"
                      aria-label={`${label}: ${match.name || '(unnamed)'}, ${match.type}`}
                      disabled={creating}
                      onClick={() => {
                        onExisting?.(match);
                      }}
                    >
                      {label}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <fieldset className="type-radios">
          <legend>Type</legend>
          {nodeTypes.map((option) => (
            <label key={option} className="radio-row">
              <input
                type="radio"
                name={`${id}-type`}
                value={option}
                checked={type === option}
                disabled={creating}
                onChange={() => {
                  setType(option);
                }}
              />
              <TypeMark type={option} />
              {option}
            </label>
          ))}
        </fieldset>
        {error !== null && (
          <p className="form-alert" role="alert">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
        <div className="pop-buttons">
          <button
            type="button"
            className="btn"
            disabled={creating}
            onClick={() => {
              close();
            }}
          >
            Cancel
          </button>
          <button type="submit" className="btn primary" aria-disabled={creating || undefined}>
            {creating && <span className="spinner sm" aria-hidden="true" />}
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  );
}

import {
  compareNames,
  maxReferences,
  searchElements,
  type ModelElement,
  type ModelGraph,
} from '@simplearchitecture/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../icons';
import { TypeMark } from '../metamodel-ui';
import { counted } from '../words';
import { pickLimit } from './relationships';

/** How long after typing stops the number of matches is said. */
const statusDelay = 500;

interface ReferenceFieldProps {
  /** The text box's id: errors and a new row put focus there. */
  id: string;
  /** The field's key as typed, or "the new field". */
  name: string;
  /** The elements it holds, in the order added. */
  ids: readonly string[];
  /** The element being edited, which can't refer to itself. */
  ownId: string;
  graph: ModelGraph;
  /** While saving: nothing can be added or removed. */
  readOnly: boolean;
  /** The row's error, when there is one. */
  errorId?: string | undefined;
  onChange: (ids: string[]) => void;
}

/** The search a box's text stands for: trimmed, with one leading `@` dropped. */
export function referenceSearch(text: string): string {
  const trimmed = text.trim();
  return (trimmed.startsWith('@') ? trimmed.slice(1) : trimmed).trim();
}

const nameOf = (element: ModelElement): string => element.name.trim() || '(unnamed)';

/**
 * A Reference field: the elements it holds as chips, each with a remove button, then a text box
 * that searches the model's elements (`@` alone lists them all) in a list floating under the
 * field. Enter adds the highlighted element and never saves the form; Backspace in the empty box
 * removes the last one; Esc closes the list without the Discard dialog. What is typed is only a
 * search: it is cleared when focus leaves the box, and never saved.
 */
export function ReferenceField(props: ReferenceFieldProps) {
  const { graph, ids, ownId, readOnly, name } = props;
  const own = useId();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [said, setSaid] = useState('');
  const box = useRef<HTMLInputElement>(null);
  // Where focus goes after the next render: a chip's remove button, or the box.
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    if (focusNext.current === null) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  });

  const query = referenceSearch(text);
  const full = ids.length >= maxReferences;
  const options = useMemo(() => {
    const taken = new Set(ids);
    return (query === '' ? [...graph.elements.values()] : searchElements(graph, query))
      .filter((element) => element.id !== ownId && !taken.has(element.id))
      .sort((a, b) => compareNames(a.name, b.name));
  }, [graph, query, ids, ownId]);
  const shown = options.slice(0, pickLimit);
  const showing = open && !readOnly && !full;
  const highlighted = showing ? shown[active] : undefined;

  const listId = `${own}-list`;
  const hintId = `${own}-hint`;
  const limitId = `${own}-limit`;
  const optionId = (index: number) => `${own}-opt-${index}`;
  const chipId = (index: number) => `${own}-chip-${index}`;

  if (open && (readOnly || full)) setOpen(false);

  useEffect(() => {
    if (showing) document.getElementById(listId)?.scrollIntoView({ block: 'nearest' });
  }, [showing, listId]);
  useEffect(() => {
    if (highlighted !== undefined) {
      document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId follows from own
  }, [highlighted, active]);

  // The number of matches, once typing stops.
  const matches = options.length === 1 ? '1 match' : `${options.length} matches`;
  const counting = showing && query !== '';
  useEffect(() => {
    if (!counting) return;
    const timer = setTimeout(() => {
      setSaid(matches);
    }, statusDelay);
    return () => {
      clearTimeout(timer);
    };
  }, [counting, matches]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  /** Closes the list and drops what was typed: it is only ever a search. */
  const clear = () => {
    close();
    setText('');
  };

  const add = (element: ModelElement) => {
    props.onChange([...ids, element.id]);
    clear();
    setSaid(`Added ${nameOf(element)}.`);
  };

  const remove = (index: number, refocus: boolean) => {
    const removed = ids[index];
    if (removed === undefined) return;
    const next = ids.filter((_, at) => at !== index);
    props.onChange(next);
    const element = graph.elements.get(removed);
    setSaid(`Removed ${element ? nameOf(element) : 'element not found'}.`);
    // The button that takes its place, the one before it, or the box.
    if (refocus)
      focusNext.current = next.length === 0 ? props.id : chipId(Math.min(index, next.length - 1));
  };

  const describedBy = [hintId, props.errorId, full && limitId].filter(Boolean).join(' ');

  return (
    <div className="ref-wrap">
      <div
        className={`ref-field${props.errorId !== undefined ? ' is-invalid' : ''}${readOnly ? ' is-saving' : ''}`}
        role="group"
        aria-label={`${name}, Reference`}
        onFocus={() => {
          setFocused(true);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocused(false);
            setSaid('');
          }
        }}
        onClick={(event) => {
          // A click on the field's empty space is a click in the box.
          if (event.target !== event.currentTarget) return;
          box.current?.focus();
          if (!readOnly) setOpen(true);
        }}
      >
        {ids.length > 0 && (
          <ul className="ref-chips" aria-label={`${name}: ${counted(ids.length, 'element')}`}>
            {ids.map((elementId, index) => {
              const element = graph.elements.get(elementId);
              const shownName = element ? nameOf(element) : undefined;
              return (
                <li
                  key={`${String(index)}:${elementId}`}
                  className={`chip${element ? '' : ' is-missing'}`}
                  title={element ? `${shownName ?? ''} · ${element.type}` : 'Element not found'}
                >
                  {element ? (
                    <TypeMark type={element.type} metadata={element.metadata} />
                  ) : (
                    <Icon name="alert" size="sm" />
                  )}
                  <span className="chip-text">{shownName ?? 'Element not found'}</span>
                  {element && <span className="chip-type">{element.type}</span>}
                  <button
                    type="button"
                    id={chipId(index)}
                    className="chip-remove"
                    aria-label={
                      element
                        ? `Remove ${shownName ?? ''}, ${element.type}`
                        : 'Remove element not found'
                    }
                    title="Remove"
                    disabled={readOnly}
                    onClick={() => {
                      remove(index, true);
                    }}
                  >
                    <Icon name="x" size="sm" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <input
          ref={box}
          id={props.id}
          type="text"
          className="ref-box"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showing}
          {...(showing ? { 'aria-controls': listId } : {})}
          {...(highlighted !== undefined ? { 'aria-activedescendant': optionId(active) } : {})}
          aria-label={`Add element to ${name}`}
          aria-describedby={describedBy}
          aria-invalid={props.errorId !== undefined || undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Type @ or a name"
          value={text}
          readOnly={readOnly}
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            setOpen(true);
            // With text to search, the first match is highlighted, so Enter adds it.
            setActive(referenceSearch(next) === '' ? -1 : 0);
          }}
          onClick={() => {
            if (!readOnly) setOpen(true);
          }}
          onBlur={clear}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              // Saves the form in its own handler, with the search dropped first.
              clear();
              return;
            }
            if (event.key === 'Enter') {
              // Adds the highlighted element; never saves the form.
              event.preventDefault();
              if (highlighted !== undefined) add(highlighted);
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              if (readOnly || full) return;
              event.preventDefault();
              if (!showing) {
                if (event.key === 'ArrowDown') {
                  setOpen(true);
                  setActive(shown.length > 0 ? 0 : -1);
                }
              } else if (event.key === 'ArrowDown') {
                setActive(Math.min(active + 1, shown.length - 1));
              } else {
                setActive(Math.max(active - 1, -1));
              }
            } else if (event.key === 'Escape' && showing) {
              // Closes the list and goes no further: no Discard dialog.
              event.preventDefault();
              event.stopPropagation();
              clear();
            } else if (event.key === 'Backspace' && text === '' && !event.repeat && !readOnly) {
              // Only a fresh press: holding Backspace to clear the text stops at the text.
              if (ids.length > 0) {
                event.preventDefault();
                remove(ids.length - 1, false);
              }
            }
          }}
        />
        {showing && (
          <ul
            className="ref-list"
            id={listId}
            role="listbox"
            aria-label={`Elements for ${name}`}
            onMouseDown={(event) => {
              // Keeps focus in the box, on the list's scroll bar too.
              event.preventDefault();
            }}
          >
            <li role="presentation" className="pick-caption">
              {query === '' ? 'All elements' : matches}
            </li>
            {shown.map((option, index) => (
              <li
                key={option.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'is-active' : undefined}
                onClick={() => {
                  add(option);
                }}
              >
                <TypeMark type={option.type} metadata={option.metadata} />
                <span className="pname">{nameOf(option)}</span>{' '}
                <span className="rtype">{option.type}</span>
              </li>
            ))}
            {options.length > pickLimit && (
              <li role="presentation" className="pick-more">
                Showing {pickLimit} of {options.length}. Keep typing to narrow it down.
              </li>
            )}
            {options.length === 0 && (
              <li role="presentation" className="pick-more">
                {query === '' ? 'No other elements to add.' : `No elements match “${query}”.`}
              </li>
            )}
          </ul>
        )}
        <span className="vh" id={hintId}>
          Type a name, or @ for all elements, and press Enter to add one. Backspace in the empty box
          removes the last one.
        </span>
        {focused && (
          <span className="vh" role="status">
            {said}
          </span>
        )}
      </div>
      {full && (
        <p className="hint" id={limitId}>
          A field can hold at most {maxReferences} elements.
        </p>
      )}
    </div>
  );
}

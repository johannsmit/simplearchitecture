import {
  compareNames,
  searchElements,
  type ModelElement,
  type ModelGraph,
} from '@simplearchitecture/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from '../icons';
import { TypeMark } from '../metamodel-ui';
import { pickLimit } from './relationships';

/** How long after typing stops the number of matches is said. */
const statusDelay = 500;

interface EndPickerProps {
  graph: ModelGraph;
  /** The end's caption on the form: From, To, Between or And. */
  caption: string;
  /** The element the end shows now, and the one at the other end. */
  current: string;
  other: string;
  onPick: (element: ModelElement) => void;
  /** Esc, or focus left the box: nothing picked. `refocus`: give the Change button the focus. */
  onClose: (refocus: boolean) => void;
}

/**
 * A relationship end's "Change" box: a search over the model's elements, by name, each with its
 * type. The keys are those of a value field's suggestions: no row starts highlighted, the arrows go
 * through the list, Enter picks the highlighted row, and Esc closes the box.
 */
export function EndPicker(props: EndPickerProps) {
  const { graph, caption } = props;
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const trimmed = query.trim();
  const options = useMemo(
    () =>
      (trimmed === '' ? [...graph.elements.values()] : searchElements(graph, trimmed)).sort(
        (a, b) => compareNames(a.name, b.name),
      ),
    [graph, trimmed],
  );
  const shown = options.slice(0, pickLimit);
  const highlighted = active >= 0 ? shown[active] : undefined;
  const listId = `${id}-list`;
  const matches = options.length === 1 ? '1 match' : `${options.length} matches`;
  // Said once typing stops, as a value field's suggestions are.
  const [status, setStatus] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      setStatus(trimmed === '' ? '' : matches);
    }, statusDelay);
    return () => {
      clearTimeout(timer);
    };
  }, [trimmed, matches]);
  const optionId = (index: number) => `${id}-opt-${index}`;

  useEffect(() => {
    if (highlighted !== undefined) {
      document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId follows from id
  }, [highlighted, active]);

  return (
    <div
      className="end-pick"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) props.onClose(false);
      }}
    >
      <label htmlFor={`${id}-search`}>New element for “{caption}”</label>
      <div className="search pick-search">
        <Icon name="search" />
        <input
          ref={input}
          id={`${id}-search`}
          type="text"
          role="combobox"
          autoComplete="off"
          placeholder="Search elements…"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={highlighted ? optionId(active) : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(-1);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (shown.length === 0) return;
              setActive((at) =>
                event.key === 'ArrowDown'
                  ? Math.min(at + 1, shown.length - 1)
                  : Math.max(at - 1, -1),
              );
            } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
              // Never saves the form; with no row highlighted, nothing happens.
              event.preventDefault();
              if (highlighted) props.onPick(highlighted);
            } else if (event.key === 'Escape') {
              // Closes the box and goes no further: no dialog, and the relationship stays open.
              event.preventDefault();
              event.stopPropagation();
              props.onClose(true);
            }
          }}
        />
      </div>
      <ul className="pick-list" id={listId} role="listbox" aria-label="Elements">
        <li role="presentation" className="pick-caption">
          {trimmed === '' ? 'All elements' : matches}
        </li>
        {shown.map((option, index) => (
          <li
            key={option.id}
            id={optionId(index)}
            role="option"
            aria-selected={index === active}
            className={index === active ? 'is-active' : undefined}
            onMouseDown={(event) => {
              // Keeps the focus in the search box.
              event.preventDefault();
            }}
            onClick={() => {
              props.onPick(option);
            }}
          >
            <TypeMark type={option.type} />
            <span className="pname" title={option.name}>
              {option.name || '(unnamed)'}
            </span>
            {option.id === props.current && <span className="pnote">Now</span>}
            {option.id === props.other && option.id !== props.current && (
              <span className="pnote">Other end</span>
            )}
            <span className="rtype">{option.type}</span>
          </li>
        ))}
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
      <span className="vh" role="status">
        {status}
      </span>
    </div>
  );
}

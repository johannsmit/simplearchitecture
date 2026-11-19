import type { ModelElement, ModelGraph } from '@simplearchitecture/shared';
import { useId } from 'react';
import { Icon } from '../icons';
import { TypeMark } from '../metamodel-ui';
import { EndPicker } from './EndPicker';

interface EndFieldProps {
  graph: ModelGraph;
  /** `rf-from` or `rf-to`: the end shown first is the source as it will be saved. */
  id: string;
  caption: 'From' | 'To';
  /** The element the end shows now, and the one at the other end. */
  current: string;
  other: string;
  /** Open, with what its search starts with; null when closed. */
  open: string | null;
  /** Picked here and not saved yet (a change Reverse alone wouldn't show). */
  changed: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  disabled: boolean;
  /** Opens the list, starting its search with `initial`, or closes it (null). */
  onOpen: (initial: string | null) => void;
  onPick: (element: ModelElement) => void;
  /** Closed with nothing picked; `refocus`: give the field the focus. */
  onClose: (refocus: boolean) => void;
}

/**
 * A relationship end on the form, From or To: a field showing the element's type mark and name
 * (wrapping at spaces), that opens the element search as its list, floating under it. A button
 * that opens a combobox: Enter, Space, a click or ↓ opens it, and a letter opens it with that
 * letter typed.
 */
export function EndField(props: EndFieldProps) {
  const { graph, id, caption } = props;
  const listId = `${useId()}-list`;
  const element = graph.elements.get(props.current);
  const name = element ? element.name || '(unnamed)' : undefined;
  const open = props.open !== null;
  const label =
    element === undefined
      ? `${caption}: element not found`
      : `${caption}: ${name ?? ''}, ${element.type}${props.changed ? ', changed, not saved yet' : ''}`;
  return (
    <div className="field end">
      <div className="end-label">
        {/* Not a <label>: a click on it focuses the field without opening it. */}
        <span
          id={`${id}-label`}
          onClick={() => {
            document.getElementById(id)?.focus();
          }}
        >
          {caption}
        </span>
        {props.changed && (
          <span className="tag" aria-hidden="true">
            Changed
          </span>
        )}
      </div>
      <div className="end-anchor">
        <button
          id={id}
          type="button"
          className="end-field"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={label}
          title={element ? `${name ?? ''} · ${element.type}` : undefined}
          aria-invalid={props.invalid || undefined}
          aria-describedby={props.describedBy}
          disabled={props.disabled}
          onMouseDown={(event) => {
            // An open list keeps the focus in its search, so this click closes it (no blur first).
            if (open) event.preventDefault();
          }}
          onClick={(event) => {
            if (open) event.currentTarget.focus();
            props.onOpen(open ? null : '');
          }}
          onKeyDown={(event) => {
            if (open || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              props.onOpen('');
            } else if (event.key.length === 1 && event.key !== ' ' && !event.altKey) {
              // A letter starts the search; the page's own keys (N, /) don't see it.
              event.preventDefault();
              event.stopPropagation();
              props.onOpen(event.key);
            }
          }}
        >
          <span className="end-mark">
            {element ? (
              <TypeMark type={element.type} metadata={element.metadata} />
            ) : (
              <span className="end-missing">
                <Icon name="alert" size="sm" />
              </span>
            )}
          </span>
          <span className={element ? 'end-name' : 'end-name muted'}>
            {element ? name : 'Element not found'}
          </span>
          <Icon name="chev-down" size="sm" />
        </button>
        {props.open !== null && (
          <EndPicker
            graph={graph}
            caption={caption}
            listId={listId}
            initial={props.open}
            current={props.current}
            other={props.other}
            onPick={props.onPick}
            onClose={props.onClose}
          />
        )}
      </div>
    </div>
  );
}

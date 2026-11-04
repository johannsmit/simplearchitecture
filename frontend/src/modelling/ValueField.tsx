import {
  useEffect,
  useId,
  useMemo,
  useState,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { suggestedValues } from '@simplearchitecture/shared';
import { pickLimit } from './relationships';

/** How long after typing stops the number of rows is said. */
const statusDelay = 500;

interface SuggestionOptions {
  value: string;
  /** The property's values in the model; none makes it a plain text field. */
  values: readonly string[];
  /** Names the list: "Suggestions for …". */
  label: string;
  /** While saving, or read-only: no list. */
  disabled?: boolean;
  /** Takes a row, as typing the whole value would. */
  onTake: (value: string) => void;
  /** Open from the start, and narrowed by the text if `typed` (a catalog cell opened by typing). */
  startOpen?: boolean;
  startTyped?: boolean;
  /** Says "Down arrow for suggestions." itself; a catalog cell has its own hint. */
  hint?: boolean;
}

/**
 * The offer behind a text field: the wiring of the search in Add relationship
 * with the floating list of a catalog cell, but no row starts highlighted, and only a row the person
 * highlighted or clicked is ever taken. The text is never changed otherwise.
 */
export function useValueSuggestions(options: SuggestionOptions) {
  const { value, values, label, disabled = false, onTake } = options;
  const id = useId();
  const [open, setOpen] = useState(options.startOpen === true);
  // The text last typed: the list narrows only while the field still holds it.
  const [typed, setTyped] = useState<string | null>(options.startTyped === true ? value : null);
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [status, setStatus] = useState('');

  const narrow = typed === value;
  const rows = useMemo(() => suggestedValues(values, value, narrow), [values, value, narrow]);
  const shown = rows.slice(0, pickLimit);
  const offers = values.length > 0;
  const showing = open && !disabled && shown.length > 0;
  const highlighted = showing ? shown[active] : undefined;
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const optionId = (index: number) => `${id}-opt-${index}`;

  if (open && disabled) setOpen(false);

  // Keeps the list in view inside whatever scrolls around it, and the highlight in the list.
  useEffect(() => {
    if (showing) document.getElementById(listId)?.scrollIntoView({ block: 'nearest' });
  }, [showing, listId]);
  useEffect(() => {
    if (highlighted !== undefined) {
      document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionId follows from id
  }, [highlighted, active]);

  const count = rows.length;
  const words = !showing
    ? ''
    : count > pickLimit
      ? `Showing ${pickLimit} of ${count} suggestions`
      : `${count} ${count === 1 ? 'suggestion' : 'suggestions'}`;
  useEffect(() => {
    const timer = setTimeout(() => {
      setStatus(words);
    }, statusDelay);
    return () => {
      clearTimeout(timer);
    };
  }, [words]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const take = (row: string) => {
    setOpen(false);
    setActive(-1);
    setTyped(null);
    onTake(row);
  };
  /** The text changed by typing, pasting or deleting. */
  const onTyped = (text: string) => {
    setTyped(text);
    setOpen(true);
    setActive(-1);
  };
  /** `↓` and `↑`; true when it was one of them and there is something to go through. */
  const onArrow = (event: KeyboardEvent<HTMLElement>): boolean => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return false;
    if (disabled || shown.length === 0) return false;
    event.preventDefault();
    const last = shown.length - 1;
    if (!open) {
      setOpen(true);
      setActive(event.key === 'ArrowDown' ? 0 : last);
    } else if (event.key === 'ArrowDown') {
      setActive(Math.min(active + 1, last));
    } else {
      setActive(Math.max(active - 1, -1));
    }
    return true;
  };

  const inputProps: InputHTMLAttributes<HTMLInputElement> = {
    autoComplete: 'off',
    onClick: () => {
      if (!disabled) setOpen(true);
    },
    onFocus: () => {
      setFocused(true);
    },
    onBlur: () => {
      setFocused(false);
      close();
    },
    ...(offers
      ? {
          role: 'combobox',
          'aria-autocomplete': 'list' as const,
          'aria-expanded': showing,
          ...(showing ? { 'aria-controls': listId } : {}),
          ...(highlighted !== undefined ? { 'aria-activedescendant': optionId(active) } : {}),
        }
      : {}),
  };

  const list: ReactNode = showing ? (
    <ul
      className="value-list"
      id={listId}
      role="listbox"
      aria-label={`Suggestions for ${label}`}
      onMouseDown={(event) => {
        // Keeps focus in the input, on the list's scrollbar too.
        event.preventDefault();
      }}
    >
      {shown.map((row, index) => (
        <li
          key={row}
          id={optionId(index)}
          role="option"
          aria-selected={index === active}
          className={index === active ? 'is-active' : undefined}
          title={row}
          onClick={() => {
            take(row);
          }}
        >
          <span>{row}</span>
        </li>
      ))}
      {count > pickLimit && (
        <li role="presentation" className="pick-more">
          Showing {pickLimit} of {count}. Keep typing to narrow it down.
        </li>
      )}
    </ul>
  ) : null;

  const extras: ReactNode = offers ? (
    <>
      {options.hint !== false && (
        <span className="vh" id={hintId}>
          Down arrow for suggestions.
        </span>
      )}
      {focused && (
        <span className="vh" role="status">
          {status}
        </span>
      )}
    </>
  ) : null;

  return {
    offers,
    showing,
    highlighted,
    hintId: offers && options.hint !== false ? hintId : undefined,
    inputProps,
    list,
    extras,
    onTyped,
    onArrow,
    close,
    take,
  };
}

interface ValueFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'list'
> {
  value: string;
  values: readonly string[];
  label: string;
  onValue: (text: string) => void;
  /** What the field makes of typed text (Supplier HQ Country: upper case). */
  normalise?: (text: string) => string;
}

/**
 * A text field on an editing form that also offers the values its property has in the model. The
 * list is placed against the nearest positioned ancestor: the row it belongs to.
 */
export function ValueField({
  value,
  values,
  label,
  onValue,
  normalise,
  readOnly,
  onKeyDown,
  ...input
}: ValueFieldProps) {
  const field = useValueSuggestions({
    value,
    values,
    label,
    disabled: readOnly === true,
    onTake: onValue,
  });
  const describedBy =
    [input['aria-describedby'], field.hintId].filter(Boolean).join(' ') || undefined;
  return (
    <>
      <input
        {...input}
        {...field.inputProps}
        aria-describedby={describedBy}
        value={value}
        readOnly={readOnly}
        onChange={(event) => {
          const text = normalise ? normalise(event.target.value) : event.target.value;
          field.onTyped(text);
          onValue(text);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            // Saves what the field shows, in the form's own handler.
            field.close();
            return;
          }
          if (field.onArrow(event) || !field.showing) return;
          if (event.key === 'Enter') {
            // With the list open, Enter never saves.
            event.preventDefault();
            if (field.highlighted !== undefined) field.take(field.highlighted);
            else field.close();
          } else if (event.key === 'Tab') {
            if (field.highlighted !== undefined) field.take(field.highlighted);
            else field.close();
          } else if (event.key === 'Escape') {
            // Closes the list and goes no further: no dialog, and the relationship stays open.
            event.preventDefault();
            event.stopPropagation();
            field.close();
          }
        }}
      />
      {field.list}
      {field.extras}
    </>
  );
}

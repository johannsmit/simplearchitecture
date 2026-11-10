import {
  maxDataValueLength,
  maxDataValues,
  sameDataValue,
  withDataValue,
} from '@simplearchitecture/shared';
import { useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes } from 'react';
import { Icon } from '../icons';
import { suggestionKeys, useValueSuggestions } from './ValueField';

interface ValueListFieldProps extends Pick<
  InputHTMLAttributes<HTMLInputElement>,
  'aria-invalid' | 'aria-describedby'
> {
  /** The input's id, for the field's label. */
  id: string;
  /** The field's name, e.g. Request Data. */
  label: string;
  /** The values, in the order added. */
  values: readonly string[];
  /** What is typed and not yet added: saving the form adds it too. */
  text: string;
  /** Values to offer: those the model already uses. Values in the field are left out. */
  suggestions: readonly string[];
  readOnly?: boolean;
  onChange: (values: readonly string[], text: string) => void;
}

/**
 * A field that holds several text values, shown as chips with a remove button each, and a text box
 * that adds one: Enter adds what is typed, or the highlighted suggestion, and never saves the form.
 * The suggestions work as in `ValueField`: arrows go through them, Enter or Tab takes the highlighted
 * one, Escape closes them. No value can be there twice, ignoring case. Each change is said in a live
 * region, and removing a chip puts focus on the next one, or on the text box.
 */
export function ValueListField({
  id,
  label,
  values,
  text,
  suggestions,
  readOnly = false,
  onChange,
  ...aria
}: ValueListFieldProps) {
  const own = useId();
  const [said, setSaid] = useState('');
  const [note, setNote] = useState('');
  // Where focus goes after the next render: a chip, or the text box.
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    if (focusNext.current === null) return;
    document.getElementById(focusNext.current)?.focus();
    focusNext.current = null;
  });
  const offered = useMemo(
    () => suggestions.filter((value) => !values.some((taken) => sameDataValue(taken, value))),
    [suggestions, values],
  );

  /** Adds a value; says why not when it can't be added, and keeps the text then. */
  const add = (value: string): boolean => {
    const trimmed = value.trim();
    if (trimmed === '') return false;
    const there = values.find((taken) => sameDataValue(taken, trimmed));
    const problem =
      there !== undefined
        ? `“${there}” is there already.`
        : trimmed.length > maxDataValueLength
          ? `A value can be at most ${maxDataValueLength} characters.`
          : values.length >= maxDataValues
            ? `${label} can hold at most ${maxDataValues} values.`
            : '';
    if (problem !== '') {
      setNote(problem);
      setSaid(problem);
      return false;
    }
    setNote('');
    setSaid(`Added ${trimmed}.`);
    onChange(withDataValue(values, trimmed), '');
    return true;
  };

  const field = useValueSuggestions({
    value: text,
    values: offered,
    label,
    disabled: readOnly,
    hint: false,
    onTake: (row) => {
      if (!add(row)) onChange(values, row);
    },
  });

  const chipId = (index: number) => `${own}-chip-${index}`;
  const remove = (index: number) => {
    const value = values[index];
    if (value === undefined) return;
    const next = values.filter((_, at) => at !== index);
    setNote('');
    setSaid(`Removed ${value}.`);
    onChange(next, text);
    // The chip that takes its place, the one before it, or the text box.
    focusNext.current = next.length === 0 ? id : chipId(Math.min(index, next.length - 1));
  };

  const hintId = `${own}-hint`;
  const noteId = `${own}-note`;
  const describedBy =
    [aria['aria-describedby'], hintId, note === '' ? undefined : noteId]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className="value-chips">
      {values.length > 0 && (
        <ul
          className="chips"
          aria-label={`${label}: ${values.length} ${values.length === 1 ? 'value' : 'values'}`}
        >
          {values.map((value, index) => (
            <li className="chip" key={`${String(index)}:${value}`}>
              <span className="chip-text" title={value}>
                {value}
              </span>
              <button
                type="button"
                id={chipId(index)}
                className="chip-remove"
                aria-label={`Remove ${value}`}
                title="Remove"
                disabled={readOnly}
                onClick={() => {
                  remove(index);
                }}
              >
                <Icon name="x" size="sm" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="value-anchor">
        <input
          {...field.inputProps}
          id={id}
          type="text"
          value={text}
          readOnly={readOnly}
          placeholder="Add a value"
          aria-invalid={aria['aria-invalid']}
          aria-describedby={describedBy}
          onChange={(event) => {
            setNote('');
            field.onTyped(event.target.value);
            onChange(values, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && !(event.ctrlKey || event.metaKey)) {
              // Adds a value; never saves the form.
              event.preventDefault();
              if (field.showing && field.highlighted !== undefined) {
                field.take(field.highlighted);
              } else {
                field.close();
                add(text);
              }
              return;
            }
            suggestionKeys(field, event);
          }}
        />
        {field.list}
      </div>
      <span className="vh" id={hintId}>
        Enter adds the value.{field.offers ? ' Down arrow for suggestions.' : ''}
      </span>
      {note !== '' && (
        <p className="hint" id={noteId}>
          {note}
        </p>
      )}
      {field.extras}
      <span className="vh" role="status">
        {said}
      </span>
    </div>
  );
}

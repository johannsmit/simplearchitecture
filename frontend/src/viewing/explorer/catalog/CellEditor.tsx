import {
  elementPropertyValues,
  isIsoCountryCode,
  standardProperties,
  type CatalogColumn,
  type ModelElement,
  type ModelGraph,
  type PropertyKind,
} from '@simplearchitecture/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Icon } from '../../../icons';
import { cellText, sameNameCount, sameNameNote, type CellKey } from '../../../modelling/draft';
import { useValueSuggestions } from '../../../modelling/ValueField';

/**
 * Where the cursor goes after a cell is saved: a row down, a cell right or left,
 * stays on the cell, or nowhere ('none': a click elsewhere decides).
 */
export type CellMove = 'down' | 'right' | 'left' | 'stay' | 'none';

/** An open cell: what is typed, and how its last save went. */
export interface CellEdit {
  id: string;
  col: number;
  key: CellKey;
  text: string;
  saving: boolean;
  /** Errors under the cell (before sending, or the server's). */
  messages: string[];
  conflict: 'changed' | 'deleted' | null;
  /** 403: the editor is read-only; Esc closes it. */
  forbidden: boolean;
  /** A choice list opened by a letter: the first option starting with it is active. */
  letter?: string;
  /** Owning team and country: the suggestions open at once (typing, Delete, a double click). */
  suggesting?: boolean;
  /** Opened by typing a character: the suggestions are narrowed by it. */
  typedFirst?: boolean;
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    return undefined;
  }
})();

interface CellEditorProps {
  graph: ModelGraph;
  element: ModelElement;
  column: CatalogColumn;
  edit: CellEdit;
  onText: (text: string) => void;
  onCommit: (move: CellMove, text?: string) => void;
  onCancel: () => void;
  /** Reload (changed) or Close (deleted) in a conflict message. */
  onConflict: () => void;
}

/**
 * The editor inside a catalog cell: a text input, a textarea over the
 * rows below (Description, Functions), a select-only combobox (choices) or the country input,
 * with the messages popover under the cell. Keys never reach the grid.
 */
export function CellEditor({
  graph,
  element,
  column,
  edit,
  onText,
  onCommit,
  onCancel,
  onConflict,
}: CellEditorProps) {
  const rule: PropertyKind | undefined =
    edit.key === 'name' ? undefined : standardProperties[edit.key].value;
  const kind = rule?.kind ?? 'text';
  const field = useRef<HTMLElement | null>(null);
  const setField = (node: HTMLElement | null) => {
    field.current = node;
  };
  const conflictButton = useRef<HTMLButtonElement>(null);
  const readOnly = edit.saving || edit.conflict !== null || edit.forbidden;
  const name = `${column.label}, ${element.name || '(unnamed)'}`;
  const offersValues =
    edit.key !== 'name' && edit.key !== 'description' && (kind === 'text' || kind === 'country');
  const suggestions = useValueSuggestions({
    value: edit.text,
    values: offersValues ? (elementPropertyValues(graph).get(edit.key) ?? []) : [],
    label: column.label,
    disabled: readOnly,
    startOpen: edit.suggesting === true,
    startTyped: edit.typedFirst === true,
    hint: false,
    onTake: (value) => {
      onCommit('stay', value);
    },
  });

  // The choices: a stored value that isn't one first, then Not set and the options.
  const options: readonly string[] = rule?.kind === 'choice' ? rule.options : [];
  const [original] = useState(() => cellText(element, edit.key));
  const unknown = rule?.kind === 'choice' && original !== '' && !options.includes(original);
  const values = [...(unknown ? [original] : []), '', ...options];
  const labelOf = (value: string) =>
    value === '' ? 'Not set' : unknown && value === original ? `“${value}” (not valid)` : value;
  const [active, setActive] = useState(() => {
    if (edit.letter !== undefined) {
      const letter = edit.letter.toLowerCase();
      const at = values.findIndex((value) => labelOf(value).toLowerCase().startsWith(letter));
      if (at !== -1) return at;
    }
    return Math.max(values.indexOf(edit.text), 0);
  });

  useEffect(() => {
    const target = field.current;
    if (!target) return;
    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.setSelectionRange(target.value.length, target.value.length);
    }
  }, []);

  // A textarea or choice list on a bottom row opens past the grid's edge: scroll it into view
  // inside the grid.
  useEffect(() => {
    const target = field.current?.closest('.cat-editor');
    const over = target?.querySelector('.cat-listbox, .cat-area');
    over?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  useEffect(() => {
    if (edit.conflict !== null) conflictButton.current?.focus();
    else if (edit.messages.length > 0) field.current?.focus();
  }, [edit.conflict, edit.messages]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (edit.saving) {
      event.preventDefault();
      return;
    }
    const multiLine = kind === 'text-list' || edit.key === 'description';
    if (event.key === 'Escape') {
      event.preventDefault();
      if (edit.conflict !== null) onConflict();
      else onCancel();
      return;
    }
    if (readOnly) return;
    if (event.nativeEvent.isComposing) return;
    // The highlighted suggestion, if there is one, is what a key saves; else the typed text.
    const taken = kind === 'choice' ? values[active] : suggestions.highlighted;
    if (event.key === 'Tab') {
      event.preventDefault();
      onCommit(event.shiftKey ? 'left' : 'right', taken);
      return;
    }
    if (event.key === 'Enter') {
      if (multiLine && event.shiftKey && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      onCommit('down', taken);
      return;
    }
    if (kind !== 'choice') {
      suggestions.onArrow(event);
      return;
    }
    const last = values.length - 1;
    const step = (to: number) => {
      event.preventDefault();
      setActive(Math.min(Math.max(to, 0), last));
    };
    if (event.key === 'ArrowDown') step(active + 1);
    else if (event.key === 'ArrowUp') step(active - 1);
    else if (event.key === 'Home') step(0);
    else if (event.key === 'End') step(last);
    else if (event.key.length === 1 && /\S/.test(event.key) && !event.ctrlKey && !event.metaKey) {
      const letter = event.key.toLowerCase();
      for (let offset = 1; offset <= values.length; offset++) {
        const at = (active + offset) % values.length;
        if (
          labelOf(values[at] ?? '')
            .toLowerCase()
            .startsWith(letter)
        ) {
          step(at);
          return;
        }
      }
    }
  };

  // Notes under the cell, as in the panel.
  const code = edit.text.trim();
  const countryNote =
    kind === 'country' && code !== ''
      ? isIsoCountryCode(code)
        ? { warn: false, text: regionNames?.of(code) ?? '' }
        : { warn: true, text: 'Not an ISO 3166-1 alpha-2 code, such as NL.' }
      : undefined;
  const nameNote =
    edit.key === 'name'
      ? sameNameNote(
          sameNameCount(graph, element.type, edit.text, element.id),
          element.type,
          edit.text,
        )
      : undefined;
  const hasPopover =
    edit.messages.length > 0 ||
    edit.conflict !== null ||
    (countryNote !== undefined && countryNote.text !== '' && countryNote.text !== code) ||
    nameNote !== undefined ||
    kind === 'text-list';
  const keys =
    kind === 'choice'
      ? 'Enter picks and saves, Esc cancels.'
      : kind === 'text-list' || edit.key === 'description'
        ? 'Enter saves, Shift+Enter adds a line, Esc cancels.'
        : suggestions.offers
          ? 'Down arrow for suggestions. Enter saves, Esc cancels.'
          : 'Enter saves, Esc cancels.';
  const describedBy = ['cat-keys', hasPopover ? 'cat-pop' : ''].filter(Boolean).join(' ');
  const common = {
    id: 'cat-editor',
    'aria-label': name,
    'aria-describedby': describedBy,
    'aria-invalid': edit.messages.length > 0 || undefined,
    'aria-busy': edit.saving || undefined,
    onKeyDown,
  };

  let control;
  if (kind === 'choice') {
    const value = values[active] ?? '';
    control = (
      <div className="cat-combo-wrap">
        <div
          {...common}
          ref={setField}
          role="combobox"
          tabIndex={0}
          className="cat-field cat-combo"
          aria-expanded={!readOnly}
          aria-controls="cat-listbox"
          aria-activedescendant={readOnly ? undefined : `cat-option-${active}`}
          aria-readonly={readOnly || undefined}
        >
          <span className="cat-combo-value">{labelOf(value)}</span>
          <Icon name="chev-down" size="sm" />
        </div>
        {!readOnly && (
          <ul className="cat-listbox" id="cat-listbox" role="listbox" aria-label={column.label}>
            {values.map((option, index) => (
              <li
                key={option === '' ? '(not set)' : option}
                id={`cat-option-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'is-active' : undefined}
                onMouseDown={(event) => {
                  // Keeps focus in the combobox.
                  event.preventDefault();
                }}
                onClick={() => {
                  setActive(index);
                  onCommit('stay', option);
                }}
              >
                {labelOf(option)}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  } else if (kind === 'text-list' || edit.key === 'description') {
    control = (
      <textarea
        {...common}
        ref={setField}
        className="cat-field cat-area"
        rows={4}
        value={edit.text}
        readOnly={readOnly}
        onChange={(event) => {
          onText(event.target.value);
        }}
      />
    );
  } else {
    control = (
      <input
        {...common}
        {...suggestions.inputProps}
        ref={setField}
        className="cat-field"
        value={edit.text}
        readOnly={readOnly}
        spellCheck={kind === 'country' ? false : undefined}
        autoCapitalize={kind === 'country' ? 'characters' : undefined}
        onChange={(event) => {
          const text = kind === 'country' ? event.target.value.toUpperCase() : event.target.value;
          suggestions.onTyped(text);
          onText(text);
        }}
      />
    );
  }

  return (
    <div
      className={`cat-editor${kind === 'text-list' || edit.key === 'description' ? ' is-area' : ''}`}
    >
      {control}
      {edit.saving && <span className="spinner sm" aria-hidden="true" />}
      <span className="vh" id="cat-keys">
        {keys}
      </span>
      {suggestions.extras}
      <div className="cat-stack">
        {hasPopover && (
          <div
            className="cat-pop"
            id="cat-pop"
            {...(edit.conflict !== null ? { role: 'alert' } : {})}
          >
            {edit.conflict !== null ? (
              <div
                className={`cat-conflict${edit.conflict === 'deleted' ? ' is-deleted' : ''}`}
                onKeyDown={(event) => {
                  // Esc in the message reloads (or closes), as its button does.
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    onConflict();
                  }
                }}
              >
                <h3>
                  {edit.conflict === 'changed'
                    ? 'Someone else changed this element'
                    : 'Someone else deleted this element'}
                </h3>
                <p>
                  {edit.conflict === 'changed'
                    ? "Your change isn't saved. Reload to see the latest version; this discards your change, so copy it first if you want to keep it."
                    : "Your change can't be saved. Copy it if you want to keep it, then close."}
                </p>
                <button ref={conflictButton} type="button" className="btn" onClick={onConflict}>
                  {edit.conflict === 'changed' ? 'Reload' : 'Close'}
                </button>
              </div>
            ) : (
              <>
                {edit.messages.map((message, index) => (
                  <p className="field-error" key={index}>
                    <Icon name="alert" size="sm" />
                    <span className="pre-wrap">{message}</span>
                  </p>
                ))}
                {kind === 'text-list' && <p className="hint">One function per line.</p>}
                {countryNote !== undefined &&
                  (countryNote.warn ? (
                    <p className="country-warn">
                      <Icon name="alert" size="sm" />
                      {countryNote.text}
                    </p>
                  ) : (
                    countryNote.text !== '' &&
                    countryNote.text !== code && <p className="country-name">{countryNote.text}</p>
                  ))}
                {nameNote !== undefined && (
                  <p className="hint dup-note">
                    <Icon name="info" size="sm" />
                    {nameNote}
                  </p>
                )}
              </>
            )}
          </div>
        )}
        {suggestions.list}
      </div>
    </div>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../icons';
import { fieldTypeWord, onlyType, typesLabel, type FieldType, type NameTypes } from './fieldTypes';
import { suggestionKeys, useValueSuggestions } from './ValueField';

interface AddFieldBoxProps {
  /** Names other elements use, most used first, with the types they use them as. */
  nameTypes: ReadonlyMap<string, NameTypes>;
  /** Whether this element already has a field with the key (trimmed). */
  has: (key: string) => boolean;
  /** While the form saves: Add waits. */
  saving: boolean;
  onAdd: (key: string, type: FieldType) => void;
  /** ✕ or Esc: nothing added. */
  onClose: () => void;
}

const typeHints: Record<FieldType, string> = {
  text: 'One line of text, as before.',
  reference: 'Other elements of this model, picked by name.',
};

/**
 * Add field on an element's form: a key, with the names other elements use offered, and a type,
 * Text or Reference. Not a form of its own, as it sits inside the element's form: Enter in Key
 * adds the field (never saves the element), and Esc closes the box without the Discard dialog.
 */
export function AddFieldBox(props: AddFieldBoxProps) {
  const { nameTypes } = props;
  const id = useId();
  const [key, setKey] = useState('');
  const [type, setType] = useState<FieldType>('text');
  // Once the person picks a Type, taking or typing a name no longer changes it.
  const [typeChosen, setTypeChosen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const offered = [...nameTypes.keys()].filter((name) => !props.has(name.trim()));

  /** The key changed: Type follows the name it matches, until the person picks one. */
  const keyChanged = (text: string) => {
    setKey(text);
    setError(null);
    if (typeChosen) return;
    const types = nameTypes.get(text.trim());
    // A name used as both types leaves Type as it is.
    if (types && types.text && types.reference) return;
    setType(onlyType(types) ?? 'text');
  };

  const field = useValueSuggestions({
    value: key,
    values: offered,
    label: 'Key',
    disabled: props.saving,
    note: (name) => typesLabel(nameTypes.get(name)),
    onTake: keyChanged,
  });

  const add = () => {
    const trimmed = key.trim();
    const problem =
      trimmed === ''
        ? 'Enter a key.'
        : props.has(trimmed)
          ? `This element already has a field “${trimmed}”.`
          : null;
    if (problem !== null) {
      setError(problem);
      input.current?.focus();
      return;
    }
    props.onAdd(trimmed, type);
  };

  const used = onlyType(nameTypes.get(key.trim()));
  const mismatch = used !== undefined && used !== type ? used : undefined;
  const keyId = `${id}-key`;
  const errorId = `${id}-error`;
  const noteId = `${id}-note`;
  const describedBy =
    [error !== null && errorId, field.hintId].filter(Boolean).join(' ') || undefined;

  return (
    <div
      className="add-rel add-field-box"
      role="group"
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        // Closes the box and goes no further: no Discard dialog.
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
      }}
    >
      <div className="add-rel-title">
        <h4 id={`${id}-title`}>Add field</h4>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close Add field"
          title="Close"
          onClick={props.onClose}
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="field value-anchor">
        <label htmlFor={keyId}>Key</label>
        <input
          ref={input}
          id={keyId}
          type="text"
          spellCheck={false}
          {...field.inputProps}
          aria-invalid={error !== null || undefined}
          aria-describedby={describedBy}
          value={key}
          onChange={(event) => {
            field.onTyped(event.target.value);
            keyChanged(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && !(event.ctrlKey || event.metaKey)) {
              // Takes the highlighted name, or adds the field; never saves the element.
              event.preventDefault();
              if (field.showing && field.highlighted !== undefined) {
                field.take(field.highlighted);
              } else {
                field.close();
                if (!props.saving) add();
              }
              return;
            }
            suggestionKeys(field, event);
          }}
        />
        {field.list}
        {field.extras}
        {error !== null && (
          <p className="field-error" id={errorId}>
            <Icon name="alert" size="sm" />
            <span>{error}</span>
          </p>
        )}
      </div>
      <fieldset className="state-segs">
        <legend>Type</legend>
        <div className="seg-radios">
          {(['text', 'reference'] as const).map((value) => (
            <label key={value} className={type === value ? 'is-checked' : undefined}>
              <input
                type="radio"
                className="vh"
                name={`${id}-type`}
                value={value}
                checked={type === value}
                aria-describedby={`${id}-${value}-hint`}
                onChange={() => {
                  setType(value);
                  setTypeChosen(true);
                }}
              />
              {fieldTypeWord[value]}
            </label>
          ))}
        </div>
        <span className="vh" id={`${id}-text-hint`}>
          {typeHints.text}
        </span>
        <span className="vh" id={`${id}-reference-hint`}>
          {typeHints.reference}
        </span>
      </fieldset>
      <div aria-live="polite">
        {mismatch !== undefined && (
          <p className="hint" id={noteId}>
            <Icon name="info" size="sm" />
            <span>
              Other elements use “{key.trim()}” as {fieldTypeWord[mismatch]}.
            </span>
          </p>
        )}
      </div>
      <div className="pop-buttons">
        <button type="button" className="btn primary" disabled={props.saving} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

import {
  fillLabel,
  insertLabelName,
  labelNameAt,
  labelPropertyNames,
  newerLabelName,
  type LabelSubject,
  type RelationshipPropertyDefinition,
} from '@simplearchitecture/shared';
import { useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../icons';
import { suggestionKeys, useValueSuggestions } from './ValueField';

interface LabelFieldProps {
  id: string;
  value: string;
  /** The relationship as the form holds it now: what `{Name}` is filled in from. */
  subject: LabelSubject;
  /** Custom metadata names the model's relationships use. */
  names: readonly string[];
  /** The properties an Admin defined: a Relation's labels use them by name. */
  definitions?: readonly RelationshipPropertyDefinition[];
  readOnly: boolean;
  invalid: boolean;
  /** The id of the field's error message, when it has one. */
  errorId?: string | undefined;
  onValue: (text: string) => void;
}

const noDefinitions: readonly RelationshipPropertyDefinition[] = [];

/** "No property called “A”." or "… “A” or “B”." */
const unknownWords = (names: readonly string[]): string =>
  `No property called ${names.map((name) => `“${name}”`).join(' or ')}.`;

/**
 * What to say about the unknown names: one sentence for them all, and one for each older name of a
 * list of data, with what it is now ("No property called “Request Data”. It is now
 * {Source to Target Data}.").
 */
function unknownSentences(names: readonly string[]): string[] {
  const others = names.filter((name) => newerLabelName(name) === undefined);
  return [
    ...(others.length > 0 ? [unknownWords(others)] : []),
    ...names.flatMap((name) => {
      const newer = newerLabelName(name);
      return newer === undefined ? [] : [`${unknownWords([name])} It is now {${newer}}.`];
    }),
  ];
}

/**
 * The relationship's Label: plain text that may hold `{Name}` for a property's value. Typing `{`
 * offers the property names, with the keys of a value field; while the label holds a brace, it
 * says what the line shows and warns about a name the relationship can't have.
 */
export function LabelField(props: LabelFieldProps) {
  const { id, value, subject, names, onValue } = props;
  const definitions = props.definitions ?? noDefinitions;
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  // Where the caret goes after a name is put in, once the new text is drawn.
  const placeCaret = useRef<number | null>(null);

  const at = caret === null ? undefined : labelNameAt(value, caret);
  const choices = labelPropertyNames(subject, names, definitions);
  const field = useValueSuggestions({
    value: at?.partial ?? '',
    values: choices,
    label: 'property names',
    disabled: props.readOnly || at === undefined,
    hint: false,
    onTake: (name) => {
      const next = insertLabelName(value, caret ?? value.length, name);
      placeCaret.current = next.caret;
      setCaret(next.caret);
      onValue(next.label);
    },
  });

  useLayoutEffect(() => {
    if (placeCaret.current === null) return;
    input.current?.setSelectionRange(placeCaret.current, placeCaret.current);
    placeCaret.current = null;
  });

  const expression = value.includes('{');
  const filled = expression ? fillLabel(value, subject, names, definitions) : undefined;
  const hintId = `${id}-names-hint`;
  const showsId = `${id}-shows`;
  const warnId = `${id}-unknown`;
  const describedBy = [
    props.errorId,
    filled ? showsId : undefined,
    filled && filled.unknown.length > 0 ? warnId : undefined,
    hintId,
  ]
    .filter(Boolean)
    .join(' ');

  const readCaret = (target: HTMLInputElement) => {
    setCaret(target.selectionStart);
  };

  return (
    <>
      <div className="value-anchor">
        <input
          ref={input}
          id={id}
          {...field.inputProps}
          value={value}
          readOnly={props.readOnly}
          aria-invalid={props.invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            const text = event.target.value;
            const where = event.target.selectionStart ?? text.length;
            setCaret(where);
            const typing = labelNameAt(text, where);
            if (typing === undefined) field.close();
            else field.onTyped(typing.partial);
            onValue(text);
          }}
          onSelect={(event) => {
            readCaret(event.currentTarget);
          }}
          onFocus={(event) => {
            field.inputProps.onFocus?.(event);
            readCaret(event.currentTarget);
          }}
          onKeyDown={(event) => {
            suggestionKeys(field, event);
          }}
        />
        {field.list}
        <span className="vh" id={hintId}>
          Type {'{'} for a property name: the line shows its value.
        </span>
        {field.extras}
      </div>
      {filled && (
        <p className="hint label-shows" id={showsId}>
          Shows as:{' '}
          {filled.text === '' ? (
            <span className="muted">no label</span>
          ) : (
            <span className="label-shows-text">“{filled.text}”</span>
          )}
        </p>
      )}
      {filled && filled.unknown.length > 0 && (
        <p className="hint warn-note" id={warnId}>
          <Icon name="alert" size="sm" />
          {/* One child, so the sentences run on as text beside the icon. */}
          <span>{unknownSentences(filled.unknown).join(' ')}</span>
        </p>
      )}
    </>
  );
}

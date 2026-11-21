import {
  elementValueFit,
  metadataText,
  referenceIds,
  type ElementPropertyDefinition,
  type ModelGraph,
} from '@simplearchitecture/shared';
import type { ReactNode } from 'react';
import { Icon } from '../icons';
import type { CustomRow } from './draft';
import { ReferenceField } from './ReferenceField';
import { ValueField } from './ValueField';

/** What a value that doesn't fit its property is called: "Not text", "Not a choice" … */
export const notKindWords: Record<ElementPropertyDefinition['kind'], string> = {
  text: 'Not text',
  choice: 'Not a choice',
  reference: 'Not a reference',
};

/** The stored value of a row, as the form reads it. */
function storedValue(row: CustomRow): unknown {
  if (row.refs !== undefined) return row.original;
  return row.editable ? row.text : row.original;
}

/** A kept value's body: element names, plain text, or JSON. */
function keptBody(value: unknown, graph: ModelGraph): ReactNode {
  const ids = referenceIds(value);
  if (ids !== undefined) return <span>Elements: {metadataText(value, graph.elements)}</span>;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <span className="pre-wrap">{String(value)}</span>;
  }
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

interface DefinedElementFieldProps {
  /** The field's control id (errors and focus find it). */
  id: string;
  definition: ElementPropertyDefinition;
  /** The draft's row for the key, if it has one. */
  row: CustomRow | undefined;
  /** The value as the element was read, if it had the key. */
  stored: unknown;
  graph: ModelGraph;
  ownId: string;
  suggestions: readonly string[];
  readOnly: boolean;
  error: ReactNode;
  errorId: string | undefined;
  onText: (text: string) => void;
  onReferences: (ids: string[]) => void;
  /** Removes a value of another kind, kept as is. */
  onRemove: () => void;
}

/**
 * One element property on an element's form: text (pick or type a value; a stored value with a
 * line break in a text area), a choice ("Not set", then the options in their order; a stored value
 * outside the list shows first as "not in the list" and stays until changed), or a Reference (the
 * `@` field). A value of another kind is kept as it is, marked "Not …", and can only be removed.
 */
export function DefinedElementField(props: DefinedElementFieldProps) {
  const { id, definition, row, readOnly, graph } = props;
  const value = row === undefined ? undefined : storedValue(row);
  const fit =
    row === undefined
      ? 'fits'
      : row.refs !== undefined
        ? definition.kind === 'reference'
          ? 'fits'
          : 'not-this-kind'
        : elementValueFit(definition, value);
  const invalid = props.errorId !== undefined || undefined;

  if (row !== undefined && fit === 'not-this-kind') {
    const caption = `${notKindWords[definition.kind]}, kept as is`;
    return (
      <div className="field">
        <span className="field-label" id={`${id}-label`}>
          {definition.name}
        </span>
        <div className="kept-row">
          <div
            id={id}
            className="kept-value"
            tabIndex={0}
            role="group"
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-kept`}
          >
            <small id={`${id}-kept`}>{caption}</small>
            {keptBody(value, graph)}
          </div>
          <button
            type="button"
            className="icon-btn danger-hover"
            aria-label={`Remove ${definition.name}`}
            title="Remove"
            disabled={readOnly}
            onClick={props.onRemove}
          >
            <Icon name="trash" />
          </button>
        </div>
        {props.error}
      </div>
    );
  }

  if (definition.kind === 'reference') {
    return (
      <div className="field">
        <label htmlFor={id}>{definition.name}</label>
        <ReferenceField
          id={id}
          name={definition.name}
          ids={row?.refs ?? []}
          ownId={props.ownId}
          graph={graph}
          readOnly={readOnly}
          errorId={props.errorId}
          onChange={props.onReferences}
        />
        {props.error}
      </div>
    );
  }

  const text = row?.editable === true ? row.text : '';
  if (definition.kind === 'choice') {
    const options = definition.options ?? [];
    const storedText =
      typeof props.stored === 'string' ||
      typeof props.stored === 'number' ||
      typeof props.stored === 'boolean'
        ? String(props.stored)
        : '';
    // Kept while the value is still the stored one: once changed, only the list or Not set.
    const unlisted = text !== '' && !options.includes(text) && text === storedText;
    return (
      <div className="field">
        <label htmlFor={id}>{definition.name}</label>
        <div className="select-wrap">
          <select
            id={id}
            value={text}
            disabled={readOnly}
            aria-invalid={invalid}
            aria-describedby={props.errorId}
            onChange={(event) => {
              props.onText(event.target.value);
            }}
          >
            {unlisted && <option value={text}>{`“${text}” (not in the list)`}</option>}
            <option value="">Not set</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <Icon name="chev-down" size="sm" />
        </div>
        {props.error}
      </div>
    );
  }

  return (
    <div className="field">
      <label htmlFor={id}>{definition.name}</label>
      {text.includes('\n') ? (
        <textarea
          id={id}
          value={text}
          readOnly={readOnly}
          aria-invalid={invalid}
          aria-describedby={props.errorId}
          onChange={(event) => {
            props.onText(event.target.value);
          }}
        />
      ) : (
        <div className="value-anchor">
          <ValueField
            id={id}
            value={text}
            values={props.suggestions}
            label={definition.name}
            readOnly={readOnly}
            aria-invalid={invalid}
            aria-describedby={props.errorId}
            onValue={props.onText}
          />
        </div>
      )}
      {props.error}
    </div>
  );
}

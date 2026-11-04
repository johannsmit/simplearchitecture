import type { ReactNode } from 'react';
import { Icon } from '../icons';
import { customRow, type CustomRow } from './draft';
import { ValueField } from './ValueField';

interface CustomMetadataFieldsProps {
  rows: readonly CustomRow[];
  saving: boolean;
  /** The "Add field" button's id: focus goes there when the last row is removed. */
  addId: string;
  /** The key input's id for a row's slot (`row:<id>`), so errors and new rows can focus it. */
  slotId: (slot: string) => string;
  errorId: (slot: string) => string;
  renderError: (slot: string) => ReactNode;
  invalid: (slot: string) => boolean;
  /** The values a key already has in the model, offered on its value field. */
  valuesOf: (key: string) => readonly string[];
  /** The custom metadata names in the model, most used first, offered on the key field. */
  names: readonly string[];
  /** A row was typed in or removed. `slot` is the row's, to clear its error. */
  onEdit: (slot: string, rows: CustomRow[]) => void;
  /** A row was added: focus goes to `focusId` after the render. */
  onAdd: (rows: CustomRow[], focusId: string) => void;
  /** A row was removed: focus goes to `focusId` after the render. */
  onRemoved: (focusId: string) => void;
}

const noValues: readonly string[] = [];

/** The rows of custom metadata on an editing form: keys and values, for elements and relationships. */
export function CustomMetadataFields(props: CustomMetadataFieldsProps) {
  const { rows, saving, slotId, errorId } = props;
  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    const key = row.key.trim();
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const removeRow = (index: number) => {
    const next = rows[index + 1] ?? rows[index - 1];
    props.onEdit(
      `row:${rows[index]?.id ?? ''}`,
      rows.filter((_, i) => i !== index),
    );
    props.onRemoved(next ? slotId(`row:${next.id}`) : props.addId);
  };
  return (
    <fieldset className="meta-fields">
      <legend>Custom metadata</legend>
      {rows.length === 0 ? (
        <p className="muted">No custom metadata.</p>
      ) : (
        <div className="meta-caps" aria-hidden="true">
          <span>Key</span>
          <span>Value</span>
        </div>
      )}
      {rows.map((row, index) => {
        const slot = `row:${row.id}`;
        const key = row.key.trim();
        const invalid = props.invalid(slot);
        const setRow = (next: Partial<CustomRow>) => {
          props.onEdit(
            slot,
            rows.map((r) => (r.id === row.id ? { ...r, ...next } : r)),
          );
        };
        const valueName = key === '' ? 'the new field' : key;
        return (
          <div className="meta-row" key={row.id}>
            <div className="meta-key">
              <ValueField
                id={slotId(slot)}
                aria-label="Key"
                spellCheck={false}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? errorId(slot) : undefined}
                value={row.key}
                // A name another row already has would only be refused as used twice.
                values={props.names.filter(
                  (name) => name === key || (keyCounts.get(name) ?? 0) === 0,
                )}
                label="Key"
                readOnly={saving}
                onValue={(text) => {
                  setRow({ key: text });
                }}
              />
              {row.wasProperty && <span className="tag">Was a property</span>}
            </div>
            {row.editable ? (
              row.text.includes('\n') ? (
                <textarea
                  aria-label={`Value of ${valueName}`}
                  value={row.text}
                  readOnly={saving}
                  onChange={(event) => {
                    setRow({ text: event.target.value });
                  }}
                />
              ) : (
                <ValueField
                  aria-label={`Value of ${valueName}`}
                  value={row.text}
                  values={key === '' ? noValues : props.valuesOf(key)}
                  label={key}
                  readOnly={saving}
                  onValue={(text) => {
                    setRow({ text });
                  }}
                />
              )
            ) : (
              <div
                className="kept-value"
                tabIndex={0}
                role="group"
                aria-label={`Value of ${valueName}, kept as is`}
              >
                <small>
                  {Array.isArray(row.original) ? 'List, kept as is' : 'Object, kept as is'}
                </small>
                <pre>{JSON.stringify(row.original, null, 2)}</pre>
              </div>
            )}
            <button
              type="button"
              className="icon-btn danger-hover"
              aria-label={key === '' ? 'Remove the new field' : `Remove ${key}`}
              title="Remove"
              disabled={saving}
              onClick={() => {
                removeRow(index);
              }}
            >
              <Icon name="trash" />
            </button>
            <div className="meta-error">{props.renderError(slot)}</div>
          </div>
        );
      })}
      <button
        type="button"
        id={props.addId}
        className="linkbtn add-field"
        disabled={saving}
        onClick={() => {
          const row = customRow('', '');
          props.onAdd([...rows, row], slotId(`row:${row.id}`));
        }}
      >
        <Icon name="plus" size="sm" />
        Add field
      </button>
    </fieldset>
  );
}

import type { ReactNode } from 'react';
import { Icon } from '../icons';
import { customRow, type CustomRow } from './draft';
import { ValueField } from './ValueField';

interface CustomMetadataFieldsProps {
  rows: readonly CustomRow[];
  saving: boolean;
  /**
   * The "Add field" button's id: focus goes there when the last row is removed. Without Add field
   * (`canAdd` false), the id of what takes focus then.
   */
  addId: string;
  /**
   * Whether new keys can be added (Add field) and keys renamed. On elements and relationships the
   * keys are fixed: an Admin defines properties, and a row's value can only change or go.
   */
  canAdd?: boolean;
  /** What a fixed key is shown as (an element's standard property: its label); the key itself. */
  keyLabel?: (key: string) => string;
  /** Whether a row is tagged "Was a property" (worked out from its key); else the row's own mark. */
  isWasProperty?: (key: string) => boolean;
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
  const canAdd = props.canAdd ?? true;
  const keyCounts = new Map<string, number>();
  for (const row of rows) {
    const key = row.key.trim();
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const valueId = (row: CustomRow): string => slotId(`value:${row.id}`);
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
        // A stored key is blank only when an earlier import left it so: it is named, not typed.
        const blankStored = !canAdd || (row.storedKey !== undefined && row.key === row.storedKey);
        const shownKey = props.keyLabel?.(row.key) ?? row.key;
        const valueName =
          key !== '' ? shownKey.trim() : blankStored ? 'the blank key' : 'the new field';
        const wasProperty = props.isWasProperty?.(row.key) ?? row.wasProperty === true;
        const keyField = canAdd && (
          <ValueField
            id={slotId(slot)}
            aria-label="Key"
            spellCheck={false}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errorId(slot) : undefined}
            value={row.key}
            // A name another row already has would only be refused as used twice.
            values={props.names.filter((name) => name === key || (keyCounts.get(name) ?? 0) === 0)}
            label="Key"
            readOnly={saving}
            onValue={(text) => {
              setRow({ key: text });
            }}
          />
        );
        const removeButton = (
          <button
            type="button"
            className="icon-btn danger-hover"
            aria-label={`Remove ${valueName}`}
            title="Remove"
            disabled={saving}
            onClick={() => {
              removeRow(index);
            }}
          >
            <Icon name="trash" />
          </button>
        );
        // With fixed keys, the value field takes the slot's id, so errors and focus find it.
        const valueFieldId = canAdd ? valueId(row) : slotId(slot);
        return (
          <div className="meta-row" key={row.id}>
            <div className="meta-key">
              {!canAdd ? (
                <span className="meta-key-text" title={row.key}>
                  {key === '' ? <em>Blank</em> : shownKey}
                </span>
              ) : (
                keyField
              )}
              {wasProperty && <span className="tag">Was a property</span>}
            </div>
            {row.editable ? (
              row.text.includes('\n') ? (
                <textarea
                  id={valueFieldId}
                  aria-label={`Value of ${valueName}`}
                  aria-invalid={(!canAdd && invalid) || undefined}
                  aria-describedby={!canAdd && invalid ? errorId(slot) : undefined}
                  value={row.text}
                  readOnly={saving}
                  onChange={(event) => {
                    setRow({ text: event.target.value });
                  }}
                />
              ) : (
                <ValueField
                  id={valueFieldId}
                  aria-label={`Value of ${valueName}`}
                  aria-invalid={(!canAdd && invalid) || undefined}
                  aria-describedby={!canAdd && invalid ? errorId(slot) : undefined}
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
                id={valueFieldId}
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
            {removeButton}
            <div className="meta-error">{props.renderError(slot)}</div>
          </div>
        );
      })}
      {canAdd && (
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
      )}
    </fieldset>
  );
}

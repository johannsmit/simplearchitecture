import {
  elementPropertyKeyProblem,
  elementPropertyNameProblem,
  keyFromName,
  propertyKeyProblem,
  propertyNameProblem,
  propertyOptionsProblems,
  type ElementFieldIssue,
  type ElementPropertyDefinition,
  type ElementPropertyKind,
  type ElementPropertyUsage,
  type PropertyList,
  type RelationshipPropertyDefinition,
  type RelationshipPropertyUsage,
} from '@simplearchitecture/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ApiRequestError, createProperty, deleteProperty, updateProperty } from '../api';
import { Icon } from '../icons';
import { Modal } from '../modelling/dialogs';
import { counted, formatNumber } from '../words';

/** A definition of either list. */
export type AnyDefinition = RelationshipPropertyDefinition | ElementPropertyDefinition;
/** How a key of either list is used in the models. */
export type AnyUsage = RelationshipPropertyUsage | ElementPropertyUsage;

/** The number of values under a key: relationships (Relations and Contains), or elements. */
export function valueCount(usage: AnyUsage | undefined): number {
  if (usage === undefined) return 0;
  return 'elements' in usage ? usage.elements : usage.relations + usage.contains;
}

/** How many values in how many models: "48 values in 3 models". */
export function valuesInModels(usage: AnyUsage | undefined): string {
  return `${counted(valueCount(usage), 'value')} in ${counted(usage?.models ?? 0, 'model')}`;
}

/** The list's word: "element property" or "relation property". */
export const listWord = (list: PropertyList): string =>
  list === 'element' ? 'element property' : 'relation property';

const kindWords: Record<ElementPropertyKind, string> = {
  text: 'Text',
  choice: 'Choice',
  reference: 'Reference',
};

/**
 * The note under Kind when an element property changes to or from Reference with values that
 * then don't fit: how many, and how they show. Undefined when there are none.
 */
export function kindChangeNote(
  from: ElementPropertyKind,
  to: ElementPropertyKind,
  usage: ElementPropertyUsage | undefined,
): string | undefined {
  if (usage === undefined || from === to) return undefined;
  const models = counted(usage.models, 'model');
  if (to === 'reference') {
    const count = usage.shapes.text + usage.shapes.other;
    if (count === 0) return undefined;
    return `${counted(count, 'value')} in ${models} ${count === 1 ? 'is' : 'are'} text, not elements. ${count === 1 ? 'It stays' : 'They stay'} as ${count === 1 ? 'it is' : 'they are'} and show${count === 1 ? 's' : ''} as “not a reference” until someone changes ${count === 1 ? 'it' : 'them'}.`;
  }
  if (from === 'reference') {
    const count = usage.shapes.reference;
    if (count === 0) return undefined;
    const shown = to === 'choice' ? 'not a choice' : 'not text';
    return `${counted(count, 'value')} in ${models} ${count === 1 ? 'is' : 'are'} elements. ${count === 1 ? 'It stays' : 'They stay'} as ${count === 1 ? 'it is' : 'they are'} and show${count === 1 ? 's' : ''} as “${shown}” until someone changes ${count === 1 ? 'it' : 'them'}.`;
  }
  return undefined;
}

/** The fields of a 422 body, if it has them. */
function fieldsOf(error: unknown): ElementFieldIssue[] | undefined {
  if (!(error instanceof ApiRequestError) || error.status !== 422) return undefined;
  const fields = (error.body as { fields?: unknown } | undefined)?.fields;
  return Array.isArray(fields) ? (fields as ElementFieldIssue[]) : undefined;
}

interface OptionRow {
  id: number;
  text: string;
}

let nextOptionId = 1;
const optionRow = (text: string): OptionRow => ({ id: nextOptionId++, text });

interface PropertyDialogProps {
  /** The list it is in: element properties, or relation properties. */
  list: PropertyList;
  /** The property to edit; undefined for a new one. */
  property: AnyDefinition | undefined;
  /** Every property of the list, for the dialog's own checks of names and keys. */
  all: readonly AnyDefinition[];
  /** How the key is used in the models (Admin), when known. */
  usage: AnyUsage | undefined;
  onCancel: () => void;
  onSaved: (property: AnyDefinition, created: boolean) => void;
  /** Someone else deleted the property meanwhile. */
  onGone: () => void;
  onAnnounce: (text: string) => void;
}

/**
 * New property and Edit property: name, key (following the name in camel case until typed in;
 * read-only once values use it), kind, and a choice's options. Checks what the server checks, and
 * shows the server's refusals at their fields.
 */
export function PropertyDialog(props: PropertyDialogProps) {
  const { property, usage, list } = props;
  const editing = property !== undefined;
  const forElements = list === 'element';
  const nameProblem = forElements ? elementPropertyNameProblem : propertyNameProblem;
  const keyProblem = forElements ? elementPropertyKeyProblem : propertyKeyProblem;
  const kinds: readonly ElementPropertyKind[] = forElements
    ? ['text', 'choice', 'reference']
    : ['text', 'choice'];
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(property?.name ?? '');
  const [key, setKey] = useState(property?.key ?? '');
  // A new property's key follows the name until the Admin types in it.
  const [keyTyped, setKeyTyped] = useState(editing);
  const [kind, setKind] = useState<ElementPropertyKind>(property?.kind ?? 'text');
  const [options, setOptions] = useState<OptionRow[]>(() =>
    (property?.options ?? []).map(optionRow),
  );
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [alert, setAlert] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [keyLocked, setKeyLocked] = useState(editing && valueCount(usage) > 0);
  const [saving, setSaving] = useState(false);
  const focusTarget = useRef<string | null>(null);
  // Whether Kind was last changed from the keyboard (arrow keys) rather than by a click.
  const kindByKeyboard = useRef(false);

  useEffect(() => {
    if (focusTarget.current === null) return;
    const target = document.getElementById(focusTarget.current);
    if (target === null) return;
    target.focus();
    focusTarget.current = null;
  });

  const others = props.all.filter((other) => other.key !== property?.key);
  // A key left as it was is no change, even one an import left with spaces around it.
  const keyChanged = !editing || (key !== property.key && key.trim() !== property.key);
  const countOf = (text: string): number =>
    usage?.values.find((value) => value.value === text)?.count ?? 0;
  const listed = options.map((row) => row.text.trim()).filter((text) => text !== '');
  const unlisted = (usage?.values ?? []).filter((value) => !listed.includes(value.value));

  const setField = (field: string, message: string | undefined) => {
    setErrors((current) => {
      const next = new Map(current);
      if (message === undefined) next.delete(field);
      else next.set(field, message);
      return next;
    });
  };

  const changeOptions = (next: OptionRow[], focusId?: string) => {
    setOptions(next);
    if (focusId !== undefined) focusTarget.current = focusId;
    setErrors((current) => {
      const rest = new Map([...current].filter(([field]) => !field.startsWith('options')));
      return rest;
    });
  };
  const optionId = (row: OptionRow) => `property-option-${String(row.id)}`;
  const optionLabel = (row: OptionRow, index: number) =>
    row.text.trim() === '' ? `option ${String(index + 1)}` : row.text.trim();

  const addOption = (after?: number) => {
    const row = optionRow('');
    const at = after === undefined ? options.length : after + 1;
    changeOptions([...options.slice(0, at), row, ...options.slice(at)], optionId(row));
  };

  const moveOption = (index: number, by: -1 | 1) => {
    const next = [...options];
    const [row] = next.splice(index, 1);
    if (row === undefined) return;
    next.splice(index + by, 0, row);
    const to = index + by;
    // Focus stays on the button, or the other arrow when this one is now disabled.
    const stays = by === -1 ? to > 0 : to < next.length - 1;
    const button = `${optionId(row)}-${stays === (by === -1) ? 'up' : 'down'}`;
    changeOptions(next, button);
    props.onAnnounce(
      `${optionLabel(row, to)} moved ${by === -1 ? 'up' : 'down'}, now ${String(to + 1)} of ${String(next.length)}.`,
    );
  };

  const removeOption = (index: number) => {
    const next = options.filter((_, at) => at !== index);
    const neighbour = next[index] ?? next[index - 1];
    changeOptions(next, neighbour === undefined ? 'property-add-option' : optionId(neighbour));
  };

  /**
   * The dialog's own checks, by field (as the server's 422 names them). In Edit, as at the server,
   * the name and the key are checked only when they change: properties added from models may keep
   * keys that differ only in case.
   */
  const check = (): Map<string, string> => {
    const found = new Map<string, string>();
    if (!editing || name.trim() !== property.name) {
      const problem = nameProblem(name, others);
      if (problem !== undefined) found.set('name', problem);
    }
    if (!keyLocked && keyChanged) {
      const problem = keyProblem(key, others);
      if (problem !== undefined) found.set('key', problem);
    }
    if (kind === 'choice') {
      const kept = options.filter((row) => row.text.trim() !== '');
      for (const issue of propertyOptionsProblems(kept.map((row) => row.text))) {
        const index = /^options\.(\d+)$/.exec(issue.field)?.[1];
        const row = index === undefined ? undefined : kept[Number(index)];
        found.set(row === undefined ? 'options' : `option:${String(row.id)}`, issue.message);
      }
    }
    return found;
  };

  const focusFirst = (found: Map<string, string>) => {
    const first = [...found.keys()][0];
    const id =
      first === 'name'
        ? 'property-name'
        : first === 'key'
          ? 'property-key'
          : first?.startsWith('option:')
            ? `property-option-${first.slice('option:'.length)}`
            : 'property-add-option';
    document.getElementById(id)?.focus();
  };

  const save = () => {
    if (saving || stale) return;
    const found = check();
    setErrors(found);
    setAlert(null);
    if (found.size > 0) {
      focusFirst(found);
      return;
    }
    const kept = options.filter((row) => row.text.trim() !== '');
    const choiceOptions = kind === 'choice' ? kept.map((row) => row.text.trim()) : undefined;
    setSaving(true);
    const call = editing
      ? updateProperty(
          property.key,
          {
            version: property.version,
            name: name.trim(),
            ...(keyLocked || !keyChanged ? {} : { key: key.trim() }),
            kind,
            ...(choiceOptions === undefined ? {} : { options: choiceOptions }),
          },
          list,
        )
      : createProperty(
          {
            name: name.trim(),
            key: key.trim(),
            kind,
            ...(choiceOptions === undefined ? {} : { options: choiceOptions }),
          },
          list,
        );
    call
      .then((saved) => {
        props.onSaved(saved, !editing);
      })
      .catch((error: unknown) => {
        setSaving(false);
        const status = error instanceof ApiRequestError ? error.status : 0;
        const fields = fieldsOf(error);
        if (fields !== undefined) {
          const next = new Map<string, string>();
          for (const issue of fields) {
            const index = /^options\.(\d+)$/.exec(issue.field)?.[1];
            const row = index === undefined ? undefined : kept[Number(index)];
            const slot =
              row !== undefined
                ? `option:${String(row.id)}`
                : ['name', 'key', 'options'].includes(issue.field)
                  ? issue.field
                  : '';
            next.set(slot, issue.message);
            if (issue.field === 'key' && issue.message.startsWith("The key can't change")) {
              setKeyLocked(true);
              setKey(property?.key ?? key);
            }
          }
          setErrors(next);
          if (next.has('')) setAlert(next.get('') ?? null);
          focusFirst(next);
        } else if (status === 409) {
          setStale(true);
          setAlert(
            'Someone else changed this property since you opened it. Close and open it again to see the changes.',
          );
        } else if (status === 404) {
          props.onGone();
        } else {
          setAlert("The property wasn't saved. Check your connection and try again.");
        }
      });
  };

  const enterSaves = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    save();
  };

  const fieldError = (field: string, id: string) =>
    errors.has(field) ? (
      <p className="field-error" id={id}>
        <Icon name="alert" size="sm" />
        {errors.get(field)}
      </p>
    ) : null;

  const nameChanged = editing && name.trim() !== property.name;
  const labels = usage !== undefined && 'labels' in usage ? usage.labels : 0;
  const kindNote =
    forElements && editing
      ? kindChangeNote(property.kind, kind, usage as ElementPropertyUsage | undefined)
      : undefined;
  const describe = (...ids: (string | false | undefined)[]) =>
    ids.filter(Boolean).join(' ') || undefined;

  return (
    <Modal
      id="property"
      className="new-model-dialog property-dialog"
      onCancel={props.onCancel}
      busy={saving}
      initialFocus={nameInput}
      describedBy="property-text"
    >
      <form
        noValidate
        aria-busy={saving || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div className="property-dialog-body">
          <h2 id="property-title">
            {editing ? 'Edit' : 'New'} {listWord(list)}
          </h2>
          <p id="property-text">
            {editing
              ? "Changes show in every model. Values in models don't change."
              : forElements
                ? 'Shows on every element, in every model.'
                : 'Shows on every Relation, in every model.'}
          </p>
          {alert !== null && (
            <p className="alert" role="alert">
              {alert}
            </p>
          )}
          <div className="field">
            <label htmlFor="property-name">
              Name <span className="req">Required</span>
            </label>
            <input
              ref={nameInput}
              id="property-name"
              autoComplete="off"
              aria-required="true"
              aria-invalid={errors.has('name') || undefined}
              aria-describedby={describe(
                errors.has('name') && 'property-name-error',
                'property-name-hint',
                nameChanged && labels > 0 && 'property-name-labels',
              )}
              value={name}
              readOnly={saving}
              onKeyDown={enterSaves}
              onChange={(event) => {
                setName(event.target.value);
                setField('name', undefined);
                if (!keyTyped) setKey(keyFromName(event.target.value));
              }}
            />
            {fieldError('name', 'property-name-error')}
            <p className="hint" id="property-name-hint">
              {forElements ? (
                "Shown on every element's form and panel and in the catalog."
              ) : (
                <>
                  Shown on the relationship form and panel and in Show Viewpoints, and used in
                  labels as {`{${name.trim() || 'Name'}}`}.
                </>
              )}
            </p>
            {nameChanged && labels > 0 && (
              <p className="hint" id="property-name-labels">
                <Icon name="info" size="sm" />
                Labels that use {`{${property.name}}`} need the new name.
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="property-key">
              Key <span className="req">Required</span>
            </label>
            <div className="key-wrap">
              <input
                id="property-key"
                autoComplete="off"
                spellCheck={false}
                aria-required="true"
                aria-invalid={errors.has('key') || undefined}
                aria-describedby={describe(
                  errors.has('key') && 'property-key-error',
                  'property-key-hint',
                )}
                value={key}
                readOnly={saving || keyLocked}
                onKeyDown={enterSaves}
                onChange={(event) => {
                  setKey(event.target.value);
                  setKeyTyped(true);
                  setField('key', undefined);
                }}
              />
              {keyLocked && <Icon name="lock" size="sm" />}
            </div>
            {fieldError('key', 'property-key-error')}
            <p className="hint" id="property-key-hint">
              {keyLocked
                ? `Can't change: ${valuesInModels(usage)} use this key.`
                : editing
                  ? 'How models and JGF files store it.'
                  : 'How models and JGF files store it. Filled in from the name.'}
            </p>
          </div>
          <fieldset className="state-segs">
            <legend>Kind</legend>
            <div
              className="seg-radios"
              role="radiogroup"
              aria-label="Kind"
              aria-describedby={kind === 'reference' ? 'property-reference-hint' : undefined}
              onKeyDown={() => {
                kindByKeyboard.current = true;
              }}
              onPointerDown={() => {
                kindByKeyboard.current = false;
              }}
            >
              {kinds.map((each) => (
                <label key={each} className={kind === each ? 'is-checked' : undefined}>
                  <input
                    type="radio"
                    className="vh"
                    name="property-kind"
                    value={each}
                    checked={kind === each}
                    disabled={saving}
                    onChange={() => {
                      setKind(each);
                      // Switching to Choice with no options gives two empty rows. A click focuses
                      // the first; with the arrow keys focus stays on Kind, as in any radio group.
                      if (each === 'choice' && options.length === 0) {
                        const first = optionRow('');
                        changeOptions(
                          [first, optionRow('')],
                          kindByKeyboard.current ? undefined : optionId(first),
                        );
                      }
                    }}
                  />
                  {kindWords[each]}
                </label>
              ))}
            </div>
            {kind === 'reference' && (
              <p className="hint" id="property-reference-hint">
                <Icon name="info" size="sm" />
                Other elements of the same model, picked with @ on the element&apos;s form. Not
                offered in Group by or the filters.
              </p>
            )}
            <div aria-live="polite">
              {kindNote !== undefined && (
                <p className="type-note">
                  <Icon name="info" />
                  <span>{kindNote}</span>
                </p>
              )}
            </div>
          </fieldset>
          {kind === 'choice' && (
            <div className="field property-options">
              <span className="field-label" id="property-options-label">
                Options <span className="req">Required</span>
              </span>
              <ol aria-labelledby="property-options-label">
                {options.map((row, index) => {
                  const slot = `option:${String(row.id)}`;
                  const label = optionLabel(row, index);
                  const count = editing ? countOf(row.text.trim()) : 0;
                  return (
                    <li key={row.id}>
                      <span className="option-n" aria-hidden="true">
                        {index + 1}
                      </span>
                      <input
                        id={optionId(row)}
                        autoComplete="off"
                        aria-label={`Option ${String(index + 1)} of ${String(options.length)}`}
                        aria-invalid={errors.has(slot) || undefined}
                        aria-describedby={errors.has(slot) ? `${optionId(row)}-error` : undefined}
                        value={row.text}
                        readOnly={saving}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          addOption(index);
                        }}
                        onChange={(event) => {
                          changeOptions(
                            options.map((other) =>
                              other.id === row.id ? { ...row, text: event.target.value } : other,
                            ),
                          );
                        }}
                      />
                      {editing && count > 0 && (
                        <span className="muted option-count">
                          · {formatNumber(count)}
                          <span className="vh"> {counted(count, 'value')}</span>
                        </span>
                      )}
                      <button
                        id={`${optionId(row)}-up`}
                        type="button"
                        className="icon-btn"
                        aria-label={`Move ${label} up`}
                        disabled={saving || index === 0}
                        onClick={() => {
                          moveOption(index, -1);
                        }}
                      >
                        <Icon name="arrow-up" />
                      </button>
                      <button
                        id={`${optionId(row)}-down`}
                        type="button"
                        className="icon-btn"
                        aria-label={`Move ${label} down`}
                        disabled={saving || index === options.length - 1}
                        onClick={() => {
                          moveOption(index, 1);
                        }}
                      >
                        <Icon name="arrow-down" />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger-hover"
                        aria-label={`Remove ${label}`}
                        disabled={saving}
                        onClick={() => {
                          removeOption(index);
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                      {fieldError(slot, `${optionId(row)}-error`)}
                    </li>
                  );
                })}
              </ol>
              <button
                id="property-add-option"
                type="button"
                className="linkbtn"
                disabled={saving}
                onClick={() => {
                  addOption();
                }}
              >
                <Icon name="plus" size="sm" />
                Add option
              </button>
              {fieldError('options', 'property-options-error')}
              {editing && unlisted.length > 0 && (
                <div className="unlisted">
                  <p>In use, not in the list:</p>
                  <ul className="chips">
                    {unlisted.slice(0, 10).map((value) => (
                      <li className="chip" key={value.value}>
                        <span className="chip-text" title={value.value}>
                          {value.value}
                        </span>{' '}
                        <span className="muted">· {formatNumber(value.count)}</span>
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={`Add ${value.value} to the list`}
                          disabled={saving}
                          onClick={() => {
                            changeOptions([
                              ...options.filter((row) => row.text.trim() !== ''),
                              optionRow(value.value),
                            ]);
                          }}
                        >
                          <Icon name="plus" size="sm" />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {unlisted.length > 10 && (
                    <p className="muted">and {formatNumber(unlisted.length - 10)} more</p>
                  )}
                  <button
                    type="button"
                    className="linkbtn"
                    disabled={saving}
                    onClick={() => {
                      changeOptions([
                        ...options.filter((row) => row.text.trim() !== ''),
                        ...unlisted.map((value) => optionRow(value.value)),
                      ]);
                    }}
                  >
                    Add all
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="row">
          <button
            className="btn"
            type="button"
            aria-disabled={saving || undefined}
            onClick={() => {
              if (!saving) props.onCancel();
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            aria-disabled={saving || stale || undefined}
            disabled={stale}
          >
            {saving && <span className="spinner sm" aria-hidden="true" />}
            {editing ? (saving ? 'Saving…' : 'Save') : saving ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface DeletePropertyDialogProps {
  list: PropertyList;
  property: AnyDefinition;
  usage: AnyUsage | undefined;
  onCancel: () => void;
  onDeleted: (values: number, models: number) => void;
  onGone: () => void;
}

/** Delete a property: says what goes, and deletes only once the Admin has typed its name. */
export function DeletePropertyDialog(props: DeletePropertyDialogProps) {
  const { property, usage, list } = props;
  const input = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim().toLowerCase() === property.name.trim().toLowerCase();
  const values = valueCount(usage);
  const referenceNote =
    property.kind === 'reference'
      ? ' The elements in them no longer show these under Referenced by.'
      : '';

  const confirm = () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    deleteProperty(property.key, list)
      .then((result) => {
        props.onDeleted(result.values, result.models);
      })
      .catch((failure: unknown) => {
        setBusy(false);
        if (failure instanceof ApiRequestError && failure.status === 404) {
          props.onGone();
          return;
        }
        setError("The property wasn't deleted. Nothing in the models changed. Try again.");
      });
  };

  return (
    <Modal
      id="delete-property"
      className="new-model-dialog"
      onCancel={props.onCancel}
      busy={busy}
      initialFocus={input}
      describedBy="delete-property-text"
    >
      <h2 id="delete-property-title">
        Delete the {listWord(list)} {property.name}?
      </h2>
      <p id="delete-property-text">
        {values > 0
          ? `This deletes ${property.name} and its ${counted(values, 'value')} from ${counted(usage?.models ?? 0, 'model')}.${referenceNote} It can't be undone.`
          : `No ${list === 'element' ? 'element' : 'relationship'} has a value for it. It can't be undone.`}
      </p>
      <div className="field">
        <label htmlFor="delete-property-name">Type {property.name} to confirm</label>
        <input
          ref={input}
          id="delete-property-name"
          autoComplete="off"
          value={typed}
          readOnly={busy}
          aria-describedby={matches ? undefined : 'delete-property-hint'}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            confirm();
          }}
        />
        {!matches && (
          <p className="hint" id="delete-property-hint">
            Type the name to delete.
          </p>
        )}
      </div>
      {error !== null && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="btn" type="button" disabled={busy} onClick={props.onCancel}>
          Cancel
        </button>
        <button
          className="btn danger"
          type="button"
          aria-disabled={!matches || busy || undefined}
          aria-describedby={matches ? undefined : 'delete-property-hint'}
          onClick={confirm}
        >
          {busy ? 'Deleting…' : 'Delete property'}
        </button>
      </div>
    </Modal>
  );
}

import {
  elementMetadataNames,
  elementPropertyValues,
  isIsoCountryCode,
  isStandardPropertyOf,
  nodeTypes,
  standardProperties,
  type DeletedElementResult,
  type ElementChangeResult,
  type ElementFieldIssue,
  type ModelElement,
  type ModelGraph,
} from '@simplearchitecture/shared';
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { ApiRequestError, deleteElement, getElement, updateElement } from '../api';
import { Icon } from '../icons';
import { TypeMark } from '../metamodel-ui';
import { CustomMetadataFields } from './CustomMetadataFields';
import { DetailsPanel, type RelationshipTools } from '../viewing/explorer/DetailsPanel';
import {
  changesOf,
  clientErrors,
  draftOf,
  elementOfNode,
  fieldKeys,
  sameNameCount,
  sameNameNote,
  serverErrors,
  typeChangeNote,
  withType,
  type Draft,
  type ErrorSlot,
  type FieldKey,
} from './draft';
import { deleteSummary, DeleteElementDialog, UnsavedDialog } from './dialogs';
import { versionToSave } from './save';
import { ValueField } from './ValueField';

/** How long "Saved" shows where the footer was. */
export const savedNoteMillis = 3000;

/** What the explorer shows about the open form in the unsaved changes dialog. */
export interface EditorState {
  dirty: boolean;
  name: string;
  canSave: boolean;
  /** Which form: the unsaved changes dialog words it (default element). */
  subject?: 'element' | 'relationship';
  /** An open catalog cell: switching to the canvas drops it, so that asks too. */
  cell?: boolean;
}

/** What the explorer needs from the open form, for the unsaved changes dialog. */
export interface EditorHandle {
  /** Saves the changes; true when saved (or nothing to save). */
  save: () => Promise<boolean>;
  /** Drops the changes. */
  discard: () => void;
  name: string;
  canSave: boolean;
}

interface ElementEditorProps {
  modelId: string;
  graph: ModelGraph;
  /** The element as in the explorer's model (saved values). */
  element: ModelElement;
  /** The element's version, once read from the server. */
  version: number | undefined;
  link: string;
  onFocusElement: (id: string) => void;
  focusHeading: boolean;
  onHeadingFocused: () => void;
  /** Put focus in Name (after New element). */
  focusName: boolean;
  onNameFocused: () => void;
  handle: Ref<EditorHandle>;
  /** Told whenever the form gets or loses unsaved changes; null when it closes. */
  onState: (state: EditorState | null) => void;
  /** The server's copy after a save or reload: the explorer updates its model. */
  onStored: (result: ElementChangeResult) => void;
  /** The element is gone: deleted here (with the result) or by someone else. */
  onRemoved: (id: string, result: DeletedElementResult | undefined) => void;
  onAnnounce: (text: string) => void;
  /** Add relationship and the rows' Open buttons. */
  relationships?: RelationshipTools;
  /** Show on canvas in the head while the catalog shows. */
  headExtra?: ReactNode;
}

type Conflict = 'changed' | 'deleted' | null;

interface TopAlert {
  title: string;
  messages: string[];
}

interface DeleteState {
  deleting: boolean;
  error: string | null;
  stale: boolean;
}

/** Ids of the form's controls, so errors can move focus to them. */
const slotId = (slot: ErrorSlot): string =>
  `ef-${slot.replace(/[^A-Za-z0-9_-]/g, '-')}${slot.startsWith('row:') ? '-key' : ''}`;
const errorId = (slot: ErrorSlot): string => `${slotId(slot)}-error`;

function describedBy(...ids: (string | false | undefined)[]): string | undefined {
  const list = ids.filter((id): id is string => typeof id === 'string' && id !== '');
  return list.length > 0 ? list.join(' ') : undefined;
}

function FieldError({ slot, errors }: { slot: ErrorSlot; errors: ReadonlyMap<ErrorSlot, string> }) {
  const message = errors.get(slot);
  if (message === undefined) return null;
  return (
    <p className="field-error" id={errorId(slot)}>
      <Icon name="alert" size="sm" />
      <span className="pre-wrap">{message}</span>
    </p>
  );
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    return undefined;
  }
})();

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The rejected fields of a 422 body, if it has them. */
function rejectedFields(body: unknown): ElementFieldIssue[] | undefined {
  const fields = (body as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return undefined;
  return fields.filter(
    (f): f is ElementFieldIssue =>
      typeof (f as ElementFieldIssue | null)?.field === 'string' &&
      typeof (f as ElementFieldIssue).message === 'string',
  );
}

/**
 * The details panel of Modelling with editing on: always the in-place form. The footer shows only
 * while there are unsaved changes.
 */
export function ElementEditor(props: ElementEditorProps) {
  const { element, graph } = props;
  const [base, setBase] = useState(element);
  const [initial, setInitial] = useState(() => draftOf(element));
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<ReadonlyMap<ErrorSlot, string>>(new Map());
  const [alert, setAlert] = useState<TopAlert | null>(null);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  const [deleting, setDeleting] = useState<DeleteState | null>(null);
  // Where keyboard focus goes after the next render (an error, a new row, the heading).
  const focusTarget = useRef<string | null>(null);
  const setFocusTarget = (id: string | null) => {
    focusTarget.current = id;
  };
  const trash = useRef<HTMLButtonElement>(null);

  const change = changesOf(initial, draft);
  const dirty = change !== undefined;
  const canSave = conflict === null && !forbidden;

  /** A fresh start from the server's copy (after a save, a reload, or a change elsewhere). */
  const reset = (next: ModelElement) => {
    const fresh = draftOf(next);
    setBase(next);
    setInitial(fresh);
    setDraft(fresh);
    setErrors(new Map());
    setAlert(null);
  };

  // The explorer's copy changed (e.g. read again from the server): follow it unless the user has
  // changes, which are never thrown away without asking.
  if (element !== base && !dirty && !saving && JSON.stringify(element) !== JSON.stringify(base)) {
    reset(element);
  }

  const { onState } = props;
  const savedName = base.name;
  useEffect(() => {
    onState({ dirty, name: savedName, canSave });
  }, [dirty, savedName, canSave, onState]);
  useEffect(
    () => () => {
      onState(null);
    },
    [onState],
  );

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => {
      setSaved(false);
    }, savedNoteMillis);
    return () => {
      clearTimeout(timer);
    };
  }, [saved]);

  useEffect(() => {
    if (focusTarget.current === null) return;
    document.getElementById(focusTarget.current)?.focus();
    focusTarget.current = null;
  });

  const { focusName, onNameFocused } = props;
  useEffect(() => {
    if (!focusName) return;
    const input = document.getElementById(slotId('name'));
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
    onNameFocused();
  }, [focusName, onNameFocused]);

  const edit = (slot: ErrorSlot, next: Draft) => {
    setDraft(next);
    setSaved(false);
    if (errors.has(slot)) {
      const rest = new Map(errors);
      rest.delete(slot);
      setErrors(rest);
    }
  };

  const slotOrder = (d: Draft): ErrorSlot[] => [
    'name',
    'type',
    'description',
    ...fieldKeys(d.type).map((key) => `field:${key}`),
    ...d.custom.map((row) => `row:${row.id}`),
  ];

  const refuse = (found: ReadonlyMap<ErrorSlot, string>, top: TopAlert | null) => {
    setErrors(found);
    setAlert(top);
    const first = slotOrder(draft).find((slot) => found.has(slot));
    setFocusTarget(first !== undefined ? slotId(first) : top ? 'ef-alert' : null);
  };

  const headingFocus = () => {
    setFocusTarget('ef-heading');
  };

  const stored = (result: ElementChangeResult) => {
    reset(elementOfNode(result.element.id, result.element.node));
    props.onStored(result);
  };

  // Not read yet: read it now, and treat a change made meanwhile as a conflict.
  const currentVersion = () => versionToSave(props.modelId, base, props.version);

  const save = async (): Promise<boolean> => {
    if (!change) return true;
    if (!canSave || saving) return false;
    const found = clientErrors(draft);
    if (found.size > 0) {
      refuse(found, null);
      return false;
    }
    setSaving(true);
    setAlert(null);
    try {
      const version = await currentVersion();
      const result = await updateElement(props.modelId, element.id, { version, ...change });
      stored(result);
      setSaved(true);
      headingFocus();
      props.onAnnounce('Saved');
      return true;
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0;
      const body = error instanceof ApiRequestError ? error.body : undefined;
      const fields = status === 422 ? rejectedFields(body) : undefined;
      if (fields) {
        const mapped = serverErrors(draft, fields);
        const general = mapped.get('');
        mapped.delete('');
        const messages = general?.split('\n') ?? [];
        refuse(
          mapped,
          messages.length > 0 ? { title: "The change wasn't saved.", messages } : null,
        );
      } else if (status === 409) {
        setConflict('changed');
        setFocusTarget('ef-conflict');
      } else if (
        status === 404 &&
        (body as { missing?: unknown } | undefined)?.missing !== 'model'
      ) {
        setConflict('deleted');
        setFocusTarget('ef-conflict');
      } else if (status === 403) {
        setForbidden(true);
        refuse(new Map(), { title: 'You can no longer edit this model.', messages: [] });
      } else if (status === 0 || status >= 500) {
        refuse(new Map(), {
          title: "The change wasn't saved. Check your connection and try again.",
          messages: [],
        });
      } else {
        const message = error instanceof Error ? error.message : '';
        refuse(new Map(), {
          title: "The change wasn't saved.",
          messages: message ? [message] : [],
        });
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    setDraft(initial);
    setErrors(new Map());
    setAlert(null);
  };

  useImperativeHandle(props.handle, () => ({ save, discard, name: base.name, canSave }));

  const reload = async (focus: 'heading' | 'trash') => {
    try {
      const latest = await getElement(props.modelId, element.id);
      setConflict(null);
      stored(latest);
      setDeleting(null);
      if (focus === 'heading') headingFocus();
      else setFocusTarget('ef-delete');
      props.onAnnounce('Reloaded. Showing the latest version.');
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        setDeleting(null);
        setConflict('deleted');
        setFocusTarget('ef-conflict');
      } else {
        setAlert({ title: "The element couldn't be reloaded. Try again.", messages: [] });
      }
    }
  };

  const confirmDelete = async () => {
    if (!deleting || deleting.deleting) return;
    setDeleting({ ...deleting, deleting: true, error: null });
    const name = base.name.trim() || 'the element';
    try {
      const version = await currentVersion();
      const result = await deleteElement(props.modelId, element.id, version);
      props.onAnnounce(
        result.deletedRelationshipCount > 0
          ? `Deleted “${name}” and ${result.deletedRelationshipCount} relationship${result.deletedRelationshipCount === 1 ? '' : 's'}.`
          : `Deleted “${name}”.`,
      );
      props.onRemoved(element.id, result);
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0;
      if (status === 409) {
        setDeleting({
          deleting: false,
          stale: true,
          error:
            'Someone else changed this element since you opened it. Reload to see the changes, then delete again.',
        });
      } else if (status === 404) {
        props.onAnnounce('This element was already deleted.');
        props.onRemoved(element.id, undefined);
      } else {
        const message = error instanceof Error ? ` ${error.message}` : '';
        setDeleting({
          deleting: false,
          stale: false,
          error: `The element wasn't deleted.${message}`,
        });
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    } else if (event.key === 'Enter' && target instanceof HTMLInputElement) {
      // Enter in a one-line field doesn't save: Ctrl/⌘+Enter does.
      event.preventDefault();
    } else if (event.key === 'Escape' && dirty && !saving) {
      event.preventDefault();
      setAskDiscard(true);
    }
  };

  const fieldCount = [...errors.keys()].filter((slot) => slot !== '').length;
  const status = saving
    ? 'Saving…'
    : fieldCount > 0
      ? `Not saved. ${fieldCount} field${fieldCount === 1 ? ' needs' : 's need'} a fix.`
      : 'Unsaved changes';
  const nameNote = sameNameNote(
    sameNameCount(graph, draft.type, draft.name, element.id),
    draft.type,
    draft.name,
  );
  const typeNote = typeChangeNote(initial, base, draft.type);
  const keys = fieldKeys(draft.type);
  const shortcut = isMac ? '⌘+Enter' : 'Ctrl+Enter';

  const valuesOf = (key: string) => elementPropertyValues(graph).get(key) ?? [];
  const setField = (key: FieldKey, value: string) => {
    edit(`field:${key}`, { ...draft, fields: { ...draft.fields, [key]: value } });
  };

  const fieldControl = (key: FieldKey): ReactNode => {
    const slot = `field:${key}`;
    const id = slotId(slot);
    const value = draft.fields[key] ?? '';
    const definition = standardProperties[key];
    const invalid = errors.has(slot);
    const common = {
      id,
      'aria-invalid': invalid || undefined,
    };
    const kind = definition.value;
    if (kind.kind === 'choice') {
      const unknown = value !== '' && !(kind.options as readonly string[]).includes(value);
      return (
        <div className="select-wrap">
          <select
            {...common}
            aria-describedby={describedBy(invalid && errorId(slot))}
            value={value}
            disabled={saving}
            onChange={(event) => {
              setField(key, event.target.value);
            }}
          >
            {unknown && <option value={value}>“{value}” (not valid)</option>}
            <option value="">Not set</option>
            {kind.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <Icon name="chev-down" size="sm" />
        </div>
      );
    }
    if (kind.kind === 'text-list') {
      return (
        <textarea
          {...common}
          className="fn-field"
          aria-describedby={describedBy(invalid && errorId(slot), `${id}-hint`)}
          value={value}
          readOnly={saving}
          onChange={(event) => {
            setField(key, event.target.value);
          }}
        />
      );
    }
    if (kind.kind === 'country') {
      const code = value.trim();
      const iso = code === '' || isIsoCountryCode(code);
      const country = iso && code !== '' ? regionNames?.of(code) : undefined;
      return (
        <div className="country-row">
          <ValueField
            {...common}
            className={code.length > 2 ? 'wide' : 'country'}
            aria-describedby={describedBy(invalid && errorId(slot), code !== '' && `${id}-note`)}
            autoCapitalize="characters"
            spellCheck={false}
            value={value}
            values={valuesOf(key)}
            label={definition.label}
            normalise={(text) => text.toUpperCase()}
            readOnly={saving}
            onValue={(text) => {
              setField(key, text);
            }}
          />
          {code !== '' &&
            (iso ? (
              <span className="country-name" id={`${id}-note`}>
                {country && country !== code ? country : ''}
              </span>
            ) : (
              <span className="country-warn" id={`${id}-note`}>
                <Icon name="alert" size="sm" />
                Not an ISO 3166-1 alpha-2 code, such as NL.
              </span>
            ))}
        </div>
      );
    }
    return (
      <div className="value-anchor">
        <ValueField
          {...common}
          aria-describedby={describedBy(invalid && errorId(slot))}
          value={value}
          values={valuesOf(key)}
          label={definition.label}
          readOnly={saving}
          onValue={(text) => {
            setField(key, text);
          }}
        />
      </div>
    );
  };

  const form = (
    <form
      className="d-form"
      aria-label={`Edit ${base.name.trim() || 'element'}`}
      aria-busy={saving || undefined}
      noValidate
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {conflict !== null && (
        <div className={`conflict${conflict === 'deleted' ? ' is-deleted' : ''}`} role="alert">
          <Icon name="alert" />
          <div>
            <h3 id="ef-conflict" tabIndex={-1}>
              {conflict === 'changed'
                ? 'Someone else changed this element'
                : 'Someone else deleted this element'}
            </h3>
            <p id="ef-conflict-text">
              {conflict === 'changed'
                ? "Your changes aren't saved. Reload to see the latest version; this discards your changes, so copy anything you want to keep first."
                : "Your changes can't be saved. Copy anything you want to keep, then close the form."}
            </p>
            <button
              type="button"
              className="btn"
              aria-describedby="ef-conflict-text"
              onClick={() => {
                if (conflict === 'changed') void reload('heading');
                else props.onRemoved(element.id, undefined);
              }}
            >
              {conflict === 'changed' ? 'Reload' : 'Close form'}
            </button>
          </div>
        </div>
      )}
      {alert && (
        <div className="form-alert" role="alert">
          <Icon name="alert" />
          <div>
            <p id="ef-alert" tabIndex={-1} className="form-alert-title">
              {alert.title}
            </p>
            {alert.messages.length > 0 && (
              <ul>
                {alert.messages.slice(0, 5).map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
                {alert.messages.length > 5 && <li>and {alert.messages.length - 5} more</li>}
              </ul>
            )}
          </div>
        </div>
      )}

      <section className="form-block">
        <div className="field">
          <label htmlFor={slotId('name')}>
            Name <span className="req">Required</span>
          </label>
          <input
            id={slotId('name')}
            required
            aria-required="true"
            aria-invalid={errors.has('name') || undefined}
            aria-describedby={describedBy(
              errors.has('name') && errorId('name'),
              nameNote && 'ef-name-note',
            )}
            value={draft.name}
            readOnly={saving}
            onChange={(event) => {
              edit('name', { ...draft, name: event.target.value });
            }}
          />
          <FieldError slot="name" errors={errors} />
          {nameNote && (
            <p className="hint dup-note" id="ef-name-note">
              <Icon name="info" size="sm" />
              {nameNote}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor={slotId('type')}>Type</label>
          <div className="select-wrap has-mark">
            <TypeMark type={draft.type} />
            <select
              id={slotId('type')}
              aria-invalid={errors.has('type') || undefined}
              aria-describedby={describedBy(
                errors.has('type') && errorId('type'),
                typeNote && 'ef-type-note',
              )}
              value={draft.type}
              disabled={saving}
              onChange={(event) => {
                const type = nodeTypes.find((t) => t === event.target.value);
                if (type) edit('type', withType(draft, type));
              }}
            >
              {nodeTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <Icon name="chev-down" size="sm" />
          </div>
          <FieldError slot="type" errors={errors} />
          <div aria-live="polite">
            {typeNote && (
              <p className="type-note" id="ef-type-note">
                <Icon name="info" />
                <span>{typeNote}</span>
              </p>
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor={slotId('description')}>Description</label>
          <textarea
            id={slotId('description')}
            className="desc-field"
            aria-invalid={errors.has('description') || undefined}
            aria-describedby={describedBy(errors.has('description') && errorId('description'))}
            value={draft.description}
            readOnly={saving}
            onChange={(event) => {
              edit('description', { ...draft, description: event.target.value });
            }}
          />
          <FieldError slot="description" errors={errors} />
        </div>
      </section>

      {keys.length > 0 && (
        <section className="form-block">
          <h3>Properties</h3>
          {keys.map((key) => (
            <div className="field" key={key}>
              <label htmlFor={slotId(`field:${key}`)}>{standardProperties[key].label}</label>
              {fieldControl(key)}
              <FieldError slot={`field:${key}`} errors={errors} />
              {key === 'functions' && (
                <p className="hint" id={`${slotId('field:functions')}-hint`}>
                  One function per line.
                </p>
              )}
            </div>
          ))}
        </section>
      )}

      <section className="form-block">
        <CustomMetadataFields
          rows={draft.custom}
          saving={saving}
          addId="ef-add-field"
          slotId={slotId}
          errorId={errorId}
          renderError={(slot) => <FieldError slot={slot} errors={errors} />}
          invalid={(slot) => errors.has(slot)}
          valuesOf={(key) => (isStandardPropertyOf(draft.type, key) ? [] : valuesOf(key))}
          names={elementMetadataNames(graph)}
          onEdit={(slot, rows) => {
            edit(slot, { ...draft, custom: rows });
          }}
          onAdd={(rows, focusId) => {
            setDraft({ ...draft, custom: rows });
            setFocusTarget(focusId);
          }}
          onRemoved={setFocusTarget}
        />
      </section>

      {dirty || saving ? (
        <div className="d-form-foot">
          <p className={`foot-status${fieldCount > 0 ? ' is-error' : ''}`} role="status">
            {fieldCount > 0 && !saving && <Icon name="alert" size="sm" />}
            {status}
          </p>
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={() => {
              setAskDiscard(true);
            }}
          >
            Discard changes
          </button>
          <button
            type="submit"
            className="btn primary save-btn"
            title={`Save (${shortcut})`}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            aria-disabled={saving || undefined}
            disabled={!canSave}
          >
            {saving && <span className="spinner sm" aria-hidden="true" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : saved ? (
        <div className="d-form-foot is-saved">
          <p className="foot-status">
            <Icon name="check" size="sm" />
            Saved
          </p>
        </div>
      ) : null}
    </form>
  );

  const headActions = (
    <button
      ref={trash}
      id="ef-delete"
      type="button"
      className="icon-btn delete-element-btn"
      aria-label="Delete element"
      title="Delete element"
      onClick={() => {
        setDeleting({ deleting: false, error: null, stale: false });
      }}
    >
      <Icon name="trash" />
    </button>
  );

  return (
    <>
      <DetailsPanel
        graph={graph}
        element={base}
        link={props.link}
        onFocusElement={props.onFocusElement}
        focusHeading={props.focusHeading}
        onHeadingFocused={props.onHeadingFocused}
        headingId="ef-heading"
        edit={{ headActions, form }}
        headExtra={props.headExtra}
        {...(props.relationships ? { relationships: props.relationships } : {})}
      />
      {askDiscard && (
        <UnsavedDialog
          kind="discard"
          name={base.name}
          saving={false}
          canSave={canSave}
          onKeep={() => {
            setAskDiscard(false);
          }}
          onDiscard={() => {
            setAskDiscard(false);
            discard();
            setFocusTarget(slotId('name'));
          }}
          onSave={() => {
            setAskDiscard(false);
          }}
        />
      )}
      {deleting && (
        <DeleteElementDialog
          name={base.name}
          summary={deleteSummary(graph, base)}
          deleting={deleting.deleting}
          error={deleting.error}
          stale={deleting.stale}
          onCancel={() => {
            setDeleting(null);
            trash.current?.focus();
          }}
          onConfirm={() => {
            void confirmDelete();
          }}
          onReload={() => {
            void reload('trash');
          }}
        />
      )}
    </>
  );
}

import {
  elementPropertyValues,
  isElementStandardKey,
  isIsoCountryCode,
  nodeTypes,
  sortElementDefinitions,
  standardProperties,
  type DeletedElementResult,
  type ElementChangeResult,
  type ElementFieldIssue,
  type ElementPropertyDefinition,
  type ModelElement,
  type ModelGraph,
} from '@simplearchitecture/shared';
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { ApiRequestError, deleteElement, getElement, updateElement } from '../api';
import { Icon } from '../icons';
import { choiceValues, TypeMark } from '../metamodel-ui';
import { CustomMetadataFields } from './CustomMetadataFields';
import { DefinedElementField } from './DefinedElementField';
import { DetailsPanel, type RelationshipTools } from '../viewing/explorer/DetailsPanel';
import {
  changesOf,
  clientErrors,
  draftOf,
  elementOfNode,
  fieldKeys,
  propertySlot,
  rowKey,
  rowOfKey,
  sameNameCount,
  sameNameNote,
  serverErrors,
  typeChangeNote,
  withDefinedReferences,
  withDefinedText,
  storedDraft,
  withKeyOf,
  withOriginalsOf,
  withoutInvalid,
  withoutKey,
  withType,
  type Draft,
  type ErrorSlot,
  type FieldKey,
} from './draft';
import { deleteSummary, DeleteElementDialog } from './dialogs';
import { versionToSave } from './save';
import { fixReason, SaveStatus } from './SaveStatus';
import { useAutoSave, type SaveOutcome, type SaveRun } from './useAutoSave';
import { ValueField } from './ValueField';

/** What the explorer shows about the open form in the unsaved changes dialog. */
export interface EditorState {
  /** Changes not saved yet: waiting, being sent, or refused. */
  dirty: boolean;
  name: string;
  canSave: boolean;
  /** Which form: the unsaved changes dialog words it (default element). */
  subject?: 'element' | 'relationship';
  /** An open catalog cell: switching to the canvas drops it, so that asks too. */
  cell?: boolean;
  /**
   * The details panel's form, which saves as you go: leaving saves what is waiting without
   * asking, and asks only when a change couldn't be saved.
   */
  autoSave?: boolean;
}

/** What the explorer needs from the open form, for the unsaved changes dialog. */
export interface EditorHandle {
  /** Saves the changes; true when saved (or nothing to save). */
  save: () => Promise<boolean>;
  /** Drops the changes. */
  discard: () => void;
  name: string;
  canSave: boolean;
  /** Why the last change couldn't be saved (a form that saves as you go). */
  failed?: string | undefined;
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
  /** The "Used in views" section. */
  usedIn?: ReactNode;
  /** The element properties couldn't be read: their values aren't saved until they are. */
  propertiesFailed?: boolean;
  /** A save was refused for a property an Admin deleted: read the definitions again. */
  onPropertiesStale?: () => void;
}

const noDefinitions: readonly ElementPropertyDefinition[] = [];

type Conflict = 'changed' | 'deleted' | null;

interface TopAlert {
  title: string;
  messages: string[];
  /** The connection failed: Try again sends the change again. */
  retry?: boolean;
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
 * The details panel of Modelling with editing on: always the in-place form, which saves as you
 * go (see `useAutoSave`).
 */
export function ElementEditor(props: ElementEditorProps) {
  const { element, graph } = props;
  // The server's copy, as last read or saved.
  const [base, setBase] = useState(element);
  // The draft as stored: what the last save sent, or what was read. Changes are measured from it.
  const [initial, setInitial] = useState(() => draftOf(element));
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<ReadonlyMap<ErrorSlot, string>>(new Map());
  const [alert, setAlert] = useState<TopAlert | null>(null);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [forbidden, setForbidden] = useState(false);
  const [deleting, setDeleting] = useState<DeleteState | null>(null);
  // The version the last save or reload gave: the next save sends it.
  const lastVersion = useRef<number | undefined>(undefined);
  // Where keyboard focus goes after the next render (a removed field, the heading).
  const focusTarget = useRef<string | null>(null);
  const setFocusTarget = (id: string | null) => {
    focusTarget.current = id;
  };
  const trash = useRef<HTMLButtonElement>(null);
  // An element property a save was refused for, because an Admin deleted it meanwhile.
  const [deletedProperty, setDeletedProperty] = useState<string | null>(null);
  const propertiesFailed = props.propertiesFailed === true;
  // Every element type has every element property, by name.
  const definitions = useMemo(
    () => (propertiesFailed ? noDefinitions : sortElementDefinitions(graph.elementProperties)),
    [propertiesFailed, graph.elementProperties],
  );
  const definedKeys = new Set(definitions.map((definition) => definition.key));
  /** An element property's control id, by its place in the list (keys may hold any character). */
  const propertyId = (key: string): string =>
    `ef-prop-${String(definitions.findIndex((definition) => definition.key === key))}`;

  const change = changesOf(initial, draft);
  const canSave = conflict === null && !forbidden;

  /** The newest version known: the last save's, or the one the explorer read. */
  const knownVersion = (): number | undefined => {
    const known = [lastVersion.current, props.version].filter((v) => v !== undefined);
    return known.length > 0 ? Math.max(...known) : undefined;
  };

  /** A fresh start from the server's copy (after a reload, or a change elsewhere). */
  const reset = (next: ModelElement) => {
    const fresh = draftOf(next);
    setBase(next);
    setInitial(fresh);
    setDraft(fresh);
    setErrors(new Map());
    setAlert(null);
  };

  const failed = (reason: string): SaveOutcome => ({ kind: 'failed', reason });

  /** Saves what the draft holds now, apart from fields that fail the checks. */
  const run: SaveRun = async (sending) => {
    if (conflict === 'changed') return failed('someone else changed this element');
    if (conflict === 'deleted') return failed('someone else deleted this element');
    if (forbidden) return failed('you can no longer edit this model');
    if (changesOf(initial, draft) === undefined) {
      setErrors(new Map());
      setAlert(null);
      return { kind: 'none' };
    }
    const found = clientErrors(
      draft,
      base.metadata,
      { ownId: element.id, isElement: (id) => graph.elements.has(id) },
      definitions,
    );
    setErrors(found);
    const fix = found.size > 0 ? failed(fixReason(found.size)) : undefined;
    const send = withoutInvalid(initial, draft, found);
    if (send === undefined) return fix ?? { kind: 'none' };
    let sent = changesOf(initial, send);
    // Until the element properties are read, metadata isn't sent: only the other fields.
    if (propertiesFailed && sent?.metadata !== undefined) {
      const rest = { ...sent };
      delete rest.metadata;
      if (Object.keys(rest).length === 0) {
        setAlert({
          title: "Couldn't load the defined properties. Reload to try again.",
          messages: [],
        });
        return failed("couldn't load the defined properties");
      }
      sent = rest;
    }
    if (sent === undefined) {
      setAlert(null);
      return fix ?? { kind: 'none' };
    }
    sending();
    setAlert(null);
    try {
      const version = await versionToSave(props.modelId, base, knownVersion());
      const result = await updateElement(props.modelId, element.id, { version, ...sent });
      lastVersion.current = result.element.version;
      const node = elementOfNode(result.element.id, result.element.node);
      setBase(node);
      // What was sent is now stored. The draft stays as typed (no trimming under the cursor), and
      // only what changed since is sent next time.
      if (propertiesFailed) {
        setInitial({ ...draftOf(node), name: send.name, description: send.description });
      } else {
        const now = storedDraft(send);
        setInitial(now);
        setDraft((current) => withOriginalsOf(now, current));
      }
      props.onStored(result);
      return fix ?? { kind: 'saved' };
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0;
      const body = error instanceof ApiRequestError ? error.body : undefined;
      const fields = status === 422 ? rejectedFields(body) : undefined;
      // An Admin deleted a property filled in here: its value can't be saved. The definitions
      // are read again, so its field goes, and the other changes are sent again at once.
      const gone = fields?.find((issue) => {
        const key = issue.field.startsWith('metadata.')
          ? issue.field.slice('metadata.'.length)
          : undefined;
        return (
          key !== undefined && definedKeys.has(key) && issue.message.includes("isn't a property")
        );
      });
      if (gone !== undefined) {
        const key = gone.field.slice('metadata.'.length);
        setDeletedProperty(definitions.find((definition) => definition.key === key)?.name ?? key);
        // A value the element didn't hold goes with the field; one it held stays to remove.
        setDraft((current) => withKeyOf(initial, current, key));
        props.onPropertiesStale?.();
        return { kind: 'again' };
      }
      if (fields) {
        const mapped = serverErrors(send, fields, definitions);
        const general = mapped.get('');
        mapped.delete('');
        const messages = general?.split('\n') ?? [];
        const all = new Map([...found, ...mapped]);
        setErrors(all);
        setAlert(messages.length > 0 ? { title: "The change wasn't saved.", messages } : null);
        return failed(
          all.size > 0 ? fixReason(all.size) : (messages[0] ?? "the change wasn't accepted"),
        );
      }
      if (status === 409) {
        setConflict('changed');
        return failed('someone else changed this element');
      }
      if (status === 404 && (body as { missing?: unknown } | undefined)?.missing !== 'model') {
        setConflict('deleted');
        return failed('someone else deleted this element');
      }
      if (status === 403) {
        setForbidden(true);
        setAlert({ title: 'You can no longer edit this model.', messages: [] });
        return failed('you can no longer edit this model');
      }
      if (status === 0 || status >= 500) {
        setAlert({
          title: "The change wasn't saved. Check your connection and try again.",
          messages: [],
          retry: true,
        });
        return failed('check your connection');
      }
      const message = error instanceof Error ? error.message : '';
      setAlert({ title: "The change wasn't saved.", messages: message ? [message] : [] });
      return failed(message || "the change wasn't accepted");
    }
  };
  const saver = useAutoSave(run);
  const dirty = change !== undefined || saver.busy;
  const failedReason = saver.phase === 'failed' ? saver.reason : undefined;

  // The explorer's copy changed (e.g. read again from the server): follow it unless the user has
  // changes, which are never thrown away without asking.
  if (
    element !== base &&
    change === undefined &&
    !saver.busy &&
    JSON.stringify(element) !== JSON.stringify(base)
  ) {
    reset(element);
  }

  const { onState } = props;
  const savedName = base.name;
  useEffect(() => {
    onState({ dirty, name: savedName, canSave, autoSave: true });
  }, [dirty, savedName, canSave, onState]);
  useEffect(
    () => () => {
      onState(null);
    },
    [onState],
  );

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

  /** A change to the draft: a text field's waits for the typing pause, a pick's goes now. */
  const edit = (slot: ErrorSlot, next: Draft, when: 'later' | 'now' = 'later') => {
    setDraft(next);
    setDeletedProperty(null);
    if (errors.has(slot)) {
      const rest = new Map(errors);
      rest.delete(slot);
      setErrors(rest);
    }
    if (when === 'now') saver.now();
    else saver.later();
  };

  const headingFocus = () => {
    setFocusTarget('ef-heading');
  };

  const stored = (result: ElementChangeResult) => {
    lastVersion.current = result.element.version;
    reset(elementOfNode(result.element.id, result.element.node));
    props.onStored(result);
  };

  // Read when the explorer leaves the form: true once everything is stored.
  const clean = useRef(true);
  useLayoutEffect(() => {
    clean.current = change === undefined;
  });

  const discard = () => {
    setDraft(initial);
    setErrors(new Map());
    setAlert(null);
  };

  useImperativeHandle(props.handle, () => ({
    save: async () => {
      await saver.flush();
      return clean.current;
    },
    discard,
    name: base.name,
    canSave,
    failed: failedReason,
  }));

  const reload = async (focus: 'heading' | 'trash') => {
    try {
      const latest = await getElement(props.modelId, element.id);
      setConflict(null);
      stored(latest);
      saver.clear();
      setDeleting(null);
      if (focus === 'heading') headingFocus();
      else setFocusTarget('ef-delete');
      props.onAnnounce('Reloaded. Showing the latest version.');
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        setDeleting(null);
        setConflict('deleted');
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
      // A change still being saved goes first, so the delete sends the version it gave.
      await saver.flush();
      const version = await versionToSave(props.modelId, base, knownVersion());
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
      // Save now: what waits for the typing pause goes at once.
      event.preventDefault();
      saver.now();
    } else if (event.key === 'Enter' && target instanceof HTMLInputElement) {
      // Enter in a one-line field doesn't save: Ctrl/⌘+Enter does.
      event.preventDefault();
    }
  };

  const nameNote = sameNameNote(
    sameNameCount(graph, draft.type, draft.name, element.id),
    draft.type,
    draft.name,
  );
  const typeNote = typeChangeNote(initial, base, draft.type);
  const keys = fieldKeys(draft.type);

  const valuesOf = (key: string) => elementPropertyValues(graph).get(key) ?? [];
  // Custom metadata: what the element holds under no element property (Was a property values).
  const storedKeys = new Set(initial.custom.map((row) => rowKey(row)));
  const customRows = draft.custom.filter((row) => !definedKeys.has(rowKey(row)));
  const shownCustomRows = customRows.filter(
    (row) => storedKeys.has(rowKey(row)) || row.wasProperty === true,
  );
  const setField = (key: FieldKey, value: string, when: 'later' | 'now' = 'later') => {
    edit(`field:${key}`, { ...draft, fields: { ...draft.fields, [key]: value } }, when);
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
      // The value the field opened with for this type: Kind not set offers Human for it.
      const opened = initial.type === draft.type ? (initial.fields[key] ?? '') : '';
      return (
        <div className="select-wrap">
          <select
            {...common}
            aria-describedby={describedBy(invalid && errorId(slot))}
            value={value}
            onChange={(event) => {
              setField(key, event.target.value, 'now');
            }}
          >
            {choiceValues(key, unknown ? value : opened).map((choice) => (
              <option key={choice.label} value={choice.value}>
                {choice.label}
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
            onValue={(text) => {
              setField(key, text);
            }}
            onPick={(text) => {
              setField(key, text, 'now');
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
          onValue={(text) => {
            setField(key, text);
          }}
          onPick={(text) => {
            setField(key, text, 'now');
          }}
        />
      </div>
    );
  };

  const standardField = (key: FieldKey): ReactNode => (
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
  );

  const form = (
    <form
      className="d-form"
      aria-label={`Edit ${base.name.trim() || 'element'}`}
      noValidate
      onKeyDown={onKeyDown}
      onBlur={saver.blur}
      onSubmit={(event) => {
        event.preventDefault();
        saver.now();
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
            {alert.retry === true && (
              <button type="button" className="btn" onClick={saver.now}>
                Try again
              </button>
            )}
          </div>
        </div>
      )}

      {deletedProperty !== null && (
        <div className="form-alert" role="alert">
          <Icon name="alert" />
          <div>
            <p id="ef-deleted-property" tabIndex={-1}>
              An Admin deleted {deletedProperty}, so its value wasn&apos;t saved. Your other changes
              are saved.
            </p>
          </div>
        </div>
      )}
      {propertiesFailed && (
        <div className="form-alert" role="alert">
          <Icon name="alert" />
          <div>
            <p>Couldn&apos;t load the defined properties. Reload to try again.</p>
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
            <TypeMark type={draft.type} metadata={draft.fields} />
            <select
              id={slotId('type')}
              aria-invalid={errors.has('type') || undefined}
              aria-describedby={describedBy(
                errors.has('type') && errorId('type'),
                typeNote && 'ef-type-note',
              )}
              value={draft.type}
              onChange={(event) => {
                const type = nodeTypes.find((t) => t === event.target.value);
                if (type) edit('type', withType(draft, type), 'now');
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
            onChange={(event) => {
              edit('description', { ...draft, description: event.target.value });
            }}
          />
          <FieldError slot="description" errors={errors} />
        </div>
      </section>

      {(keys.length > 0 || definitions.length > 0) && (
        <section className="form-block">
          <h3>Properties</h3>
          {keys.filter((key) => key !== 'functions').map((key) => standardField(key))}
          {definitions.map((definition) => {
            const slot = propertySlot(definition.key);
            const id = propertyId(definition.key);
            const invalid = errors.has(slot);
            return (
              <DefinedElementField
                key={definition.key}
                id={id}
                definition={definition}
                row={rowOfKey(draft, definition.key)}
                stored={
                  Object.hasOwn(base.metadata, definition.key)
                    ? base.metadata[definition.key]
                    : undefined
                }
                graph={graph}
                ownId={element.id}
                suggestions={valuesOf(definition.key)}
                readOnly={false}
                error={
                  invalid ? (
                    <p className="field-error" id={`${id}-error`}>
                      <Icon name="alert" size="sm" />
                      <span className="pre-wrap">{errors.get(slot)}</span>
                    </p>
                  ) : null
                }
                errorId={invalid ? `${id}-error` : undefined}
                onText={(text, now) => {
                  edit(slot, withDefinedText(draft, definition.key, text), now ? 'now' : 'later');
                }}
                onReferences={(ids) => {
                  edit(slot, withDefinedReferences(draft, definition.key, ids), 'now');
                }}
                onRemove={() => {
                  edit(slot, withoutKey(draft, definition.key), 'now');
                  setFocusTarget(id);
                }}
              />
            );
          })}
          {keys.filter((key) => key === 'functions').map((key) => standardField(key))}
        </section>
      )}

      {shownCustomRows.length > 0 && (
        <section className="form-block">
          <CustomMetadataFields
            rows={shownCustomRows}
            canAdd={false}
            saving={propertiesFailed}
            addId="ef-new-properties"
            slotId={slotId}
            errorId={errorId}
            renderError={(slot) => <FieldError slot={slot} errors={errors} />}
            invalid={(slot) => errors.has(slot)}
            valuesOf={(key) => (isElementStandardKey(key) ? [] : valuesOf(key))}
            names={[]}
            keyLabel={(key) => (isElementStandardKey(key) ? standardProperties[key].label : key)}
            isWasProperty={isElementStandardKey}
            onEdit={(slot, rows, now) => {
              // The rows shown are the custom ones: the others (element properties) stay.
              const shown = new Set(shownCustomRows);
              edit(
                slot,
                { ...draft, custom: [...draft.custom.filter((row) => !shown.has(row)), ...rows] },
                now === true ? 'now' : 'later',
              );
            }}
            onAdd={() => undefined}
            onRemoved={setFocusTarget}
          />
        </section>
      )}

      <p className="hint new-properties-hint" id="ef-new-properties" tabIndex={-1}>
        <Icon name="info" size="sm" />
        New properties are added by an Admin, in Admin → Properties.
      </p>
    </form>
  );

  const headActions = (
    <>
      <SaveStatus saver={saver} />
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
    </>
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
        usedIn={props.usedIn}
        {...(props.relationships ? { relationships: props.relationships } : {})}
      />
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

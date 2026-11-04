import {
  canBeTwoWay,
  canHaveInformationFlow,
  containerOf,
  containsType,
  edgeTypes,
  informationFlowKey,
  relationshipOfEdge,
  relationshipProblems,
  relationshipPropertyValues,
  type ArchitectureState,
  type DeletedRelationshipResult,
  type EdgeType,
  type JgfEdge,
  type ModelGraph,
  type ModelRelationship,
  type RelationshipChangeResult,
  type RelationshipProblem,
  type UpdateRelationshipRequest,
} from '@simplearchitecture/shared';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { ApiRequestError, deleteRelationship, getRelationship, updateRelationship } from '../api';
import { Icon } from '../icons';
import { EdgeSample, relationshipTypeLine, TypeMark } from '../metamodel-ui';
import { MetadataValue } from '../viewing/explorer/DetailsPanel';
import { CustomMetadataFields } from './CustomMetadataFields';
import { Modal, UnsavedDialog } from './dialogs';
import { customRow, customRowErrors, customValues, metadataChanges, type CustomRow } from './draft';
import type { EditorHandle, EditorState } from './ElementEditor';
import { savedNoteMillis } from './ElementEditor';
import { relationshipVersionToSave } from './save';
import {
  containsNote,
  DirectionSegments,
  InformationFlowBox,
  nameOf,
  refusalOf,
  relationshipSentence,
  StateSegments,
  TypeNote,
  TypeSegments,
} from './relationships';

interface RelationshipEditorProps {
  modelId: string;
  graph: ModelGraph;
  /** The relationship as in the explorer's model (saved values). */
  relationship: ModelRelationship;
  /** The element the panel goes back to. */
  focusId: string;
  nest: boolean;
  onBack: () => void;
  onFocusElement: (id: string) => void;
  onShow: (relationshipId: string) => void;
  handle: Ref<EditorHandle>;
  onState: (state: EditorState | null) => void;
  /** The server's copy after a read or save: the explorer updates its model. */
  onStored: (result: RelationshipChangeResult, saved: boolean) => void;
  /** Gone: deleted here (with the result) or by someone else. */
  onRemoved: (id: string, result: DeletedRelationshipResult | undefined, words: string) => void;
  onAnnounce: (text: string) => void;
  focusHeading: boolean;
  onHeadingFocused: () => void;
}

interface Draft {
  type: EdgeType;
  state: ArchitectureState;
  description: string;
  label: string;
  reversed: boolean;
  /** Both ways; always false for a type that can't be two-way. */
  twoWay: boolean;
  /** Information flow; always false for a type that can't have it. */
  informationFlow: boolean;
  custom: CustomRow[];
}

/** Metadata with a field of its own on the form, so it has no custom row. */
const ownFields = new Set(['architectureState', 'description', informationFlowKey]);

type Conflict = 'changed' | 'deleted' | { end: string } | null;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function draftOf(relationship: ModelRelationship): Draft {
  const description = relationship.metadata.description;
  return {
    type: relationship.type,
    state: relationship.architectureState,
    description: typeof description === 'string' ? description : '',
    label: relationship.label ?? '',
    reversed: false,
    twoWay: relationship.twoWay === true,
    informationFlow: relationship.informationFlow === true,
    custom: Object.entries(relationship.metadata)
      .filter(([key]) => !ownFields.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => customRow(key, value)),
  };
}

const rowInputId = (slot: string): string => `rf-${slot.replace(/[^A-Za-z0-9_-]/g, '-')}-key`;

/** Why a key can't be a custom row here, if so. */
function reservedKeyWord(key: string): string | undefined {
  if (key === 'type' || key === informationFlowKey) return `“${key}” is reserved.`;
  return ownFields.has(key) ? `“${key}” has its own field above.` : undefined;
}

/** The relationship in the details panel: always the form. */
export function RelationshipEditor(props: RelationshipEditorProps) {
  const { graph, relationship, modelId } = props;
  // The copy the draft started from: what the user's changes are measured against.
  const [startedFrom, setStartedFrom] = useState(relationship);
  const [base, setBase] = useState(() => draftOf(relationship));
  const [draft, setDraft] = useState<Draft>(base);
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [duplicateOf, setDuplicateOf] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<Conflict>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const [deleting, setDeleting] = useState<{
    busy: boolean;
    error: string | null;
    stale: boolean;
  } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const trash = useRef<HTMLButtonElement>(null);
  const editable = !relationship.id.startsWith('edges[');
  // Where keyboard focus goes after the next render: a new or neighbouring custom row.
  const focusTarget = useRef<string | null>(null);

  const self = relationship.source === relationship.target;
  const source = draft.reversed ? relationship.target : relationship.source;
  const target = draft.reversed ? relationship.source : relationship.target;
  const savedSentence = relationshipSentence(graph, relationship);
  const customChange = metadataChanges(customValues(base.custom), customValues(draft.custom));
  const dirty =
    draft.type !== base.type ||
    draft.state !== base.state ||
    draft.description.trim() !== base.description.trim() ||
    draft.label.trim() !== base.label.trim() ||
    draft.twoWay !== base.twoWay ||
    draft.informationFlow !== base.informationFlow ||
    Object.keys(customChange).length > 0 ||
    draft.reversed;

  /** A fresh start from the server's copy (after a save, a reload, or a change elsewhere). */
  const reset = (next: ModelRelationship) => {
    const fresh = draftOf(next);
    setStartedFrom(next);
    setBase(fresh);
    setDraft(fresh);
    setErrors(new Map());
    setDuplicateOf(undefined);
  };

  // The explorer's copy changed (e.g. read again from the server): follow it unless the user has
  // changes, which are never thrown away without asking. Those are sent as changes to the copy they
  // started from, so a change made elsewhere to anything else stays.
  if (
    relationship !== startedFrom &&
    !dirty &&
    !saving &&
    JSON.stringify(relationship) !== JSON.stringify(startedFrom)
  ) {
    reset(relationship);
  }

  const copyOf = (edge: JgfEdge): ModelRelationship => relationshipOfEdge(edge) ?? relationship;
  const touchesEnds = draft.reversed || draft.type !== base.type;
  const ignore = { ignore: relationship.id };
  // Refused types for the (possibly reversed) ends; the saved type stays allowed unless reversed.
  const problems = new Map<EdgeType, RelationshipProblem | undefined>(
    edgeTypes.map((type) => [
      type,
      type === base.type && !draft.reversed
        ? undefined
        : relationshipProblems(graph, { source, target, type, ...ignore })[0],
    ]),
  );
  const reverseProblem = draft.reversed ? problems.get(draft.type) : undefined;
  const clientProblem = touchesEnds ? problems.get(draft.type) : undefined;
  const canSave = editable && conflict === null && clientProblem === undefined;

  useEffect(() => {
    if (!props.focusHeading) return;
    heading.current?.focus();
    props.onHeadingFocused();
  });

  useEffect(() => {
    if (focusTarget.current === null) return;
    // Not there yet: an earlier render's effect ran first, so wait for the next one.
    const target = document.getElementById(focusTarget.current);
    if (target === null) return;
    target.focus();
    focusTarget.current = null;
  });

  // Read the version (and the server's copy) when it opens.
  useEffect(() => {
    if (!editable) return;
    const controller = new AbortController();
    getRelationship(modelId, relationship.id, controller.signal)
      .then((result) => {
        setVersion(result.relationship.version);
        props.onStored(result, false);
      })
      .catch(() => {
        // Saving reads it again and reports what went wrong there.
      });
    return () => {
      controller.abort();
    };
    // Once per relationship.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, relationship.id, editable]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => {
      setSaved(false);
    }, savedNoteMillis);
    return () => {
      clearTimeout(timer);
    };
  }, [saved]);

  const onState = props.onState;
  useEffect(() => {
    onState({ dirty, name: savedSentence, canSave, subject: 'relationship' });
  }, [dirty, savedSentence, canSave, onState]);
  useEffect(
    () => () => {
      onState(null);
    },
    [onState],
  );

  const discard = () => {
    setDraft(base);
    setErrors(new Map());
    setDuplicateOf(undefined);
  };

  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    if (!canSave || saving) {
      if (clientProblem)
        document.getElementById(draft.reversed ? 'rf-reverse' : 'rf-type')?.focus();
      return false;
    }
    // A key already stored can't block the form: the server has the last word if it is changed.
    const storedKeys = new Set(base.custom.map((row) => row.key.trim()));
    const rowErrors = customRowErrors(draft.custom, (key) =>
      storedKeys.has(key) ? undefined : reservedKeyWord(key),
    );
    const firstBad = draft.custom.find((row) => rowErrors.has(`row:${row.id}`));
    if (firstBad) {
      setErrors(rowErrors);
      document.getElementById(rowInputId(`row:${firstBad.id}`))?.focus();
      return false;
    }
    setSaving(true);
    setErrors(new Map());
    setDuplicateOf(undefined);
    try {
      const current = await relationshipVersionToSave(modelId, startedFrom, version);
      const change: UpdateRelationshipRequest = { version: current };
      if (draft.type !== base.type) change.type = draft.type;
      if (draft.state !== base.state) change.architectureState = draft.state;
      if (draft.description.trim() !== base.description.trim()) {
        change.description = draft.description.trim() === '' ? null : draft.description.trim();
      }
      if (draft.label.trim() !== base.label.trim()) {
        change.label = draft.label.trim() === '' ? null : draft.label.trim();
      }
      if (draft.reversed) change.reverse = true;
      if (draft.twoWay !== base.twoWay) change.twoWay = draft.twoWay;
      if (draft.informationFlow !== base.informationFlow) {
        change.informationFlow = draft.informationFlow;
      }
      if (Object.keys(customChange).length > 0) change.metadata = customChange;
      const result = await updateRelationship(modelId, relationship.id, change);
      setSaving(false);
      setVersion(result.relationship.version);
      reset(copyOf(result.relationship.edge));
      setSaved(true);
      props.onStored(result, true);
      heading.current?.focus();
      return true;
    } catch (failure) {
      setSaving(false);
      const status = failure instanceof ApiRequestError ? failure.status : 0;
      if (status === 409) {
        setConflict('changed');
      } else if (status === 404) {
        const missing = (failure as ApiRequestError).body as { missing?: unknown } | undefined;
        const end =
          missing?.missing === 'source' || missing?.missing === 'target'
            ? nameOf(graph, missing.missing === 'source' ? source : target)
            : undefined;
        setConflict(end === undefined ? 'deleted' : { end });
      } else {
        const refusal = refusalOf(failure);
        const next = new Map<string, string>();
        // A message about a custom key goes under its row, or at the top if the row is gone.
        const customSlot = (field: string): string => {
          const key = field.startsWith('metadata.') ? field.slice('metadata.'.length) : undefined;
          const row = draft.custom.find((candidate) => candidate.key.trim() === key);
          return row ? `row:${row.id}` : '';
        };
        for (const issue of refusal.fields) {
          const slot = [
            'type',
            'architectureState',
            'description',
            'label',
            'reverse',
            'twoWay',
            informationFlowKey,
          ].includes(issue.field)
            ? issue.field
            : customSlot(issue.field);
          next.set(slot, [next.get(slot), issue.message].filter(Boolean).join(' '));
        }
        if (refusal.fields.length === 0) next.set('', refusal.message);
        setErrors(next);
        if (refusal.duplicateOf !== undefined) setDuplicateOf(refusal.duplicateOf);
      }
      return false;
    }
  };

  useImperativeHandle(props.handle, () => ({ save, discard, name: savedSentence, canSave }));

  const reload = async () => {
    try {
      const result = await getRelationship(modelId, relationship.id);
      setVersion(result.relationship.version);
      setConflict(null);
      props.onStored(result, false);
      reset(copyOf(result.relationship.edge));
      heading.current?.focus();
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.status === 404) setConflict('deleted');
    }
  };

  const nestedNow =
    relationship.type === containsType &&
    containerOf(graph, relationship.target) === relationship.source;
  const confirmDelete = async () => {
    if (!deleting) return;
    setDeleting({ ...deleting, busy: true, error: null });
    try {
      const current = await relationshipVersionToSave(modelId, startedFrom, version);
      const result = await deleteRelationship(modelId, relationship.id, current);
      setDeleting(null);
      props.onRemoved(relationship.id, result, `Deleted: ${savedSentence}.`);
    } catch (failure) {
      const status = failure instanceof ApiRequestError ? failure.status : 0;
      if (status === 404) {
        setDeleting(null);
        props.onRemoved(relationship.id, undefined, 'This relationship was already deleted.');
      } else if (status === 409) {
        setDeleting({
          busy: false,
          stale: true,
          error:
            'Someone else changed this relationship since you opened it. Reload to see the changes, then delete again.',
        });
      } else {
        const message = failure instanceof Error ? failure.message : '';
        setDeleting({
          busy: false,
          stale: false,
          error: `The relationship wasn't deleted. ${message}`.trim(),
        });
      }
    }
  };

  const typeNote =
    draft.type === containsType && touchesEnds
      ? containsNote(graph, source, target, props.nest)
      : draft.type !== containsType && base.type === containsType && nestedNow
        ? {
            kind: 'info' as const,
            text: `After saving, ${nameOf(graph, relationship.target)} is no longer nested in ${nameOf(graph, relationship.source)} and the canvas tidies up.`,
          }
        : undefined;
  const sourceElement = graph.elements.get(relationship.source);
  const targetElement = graph.elements.get(relationship.target);
  const [first, second] = draft.twoWay ? ['Between', 'And'] : ['From', 'To'];
  const shownEnds = draft.reversed
    ? [
        [first, targetElement],
        [second, sourceElement],
      ]
    : [
        [first, sourceElement],
        [second, targetElement],
      ];
  const shortcut = isMac ? '⌘+Enter' : 'Ctrl+Enter';
  const fieldError = (slot: string) =>
    errors.has(slot) ? (
      <p className="field-error" id={`rf-${slot || 'alert'}-error`}>
        <Icon name="alert" size="sm" />
        {errors.get(slot)}
        {duplicateOf !== undefined && slot !== '' && (
          <>
            {' '}
            <ShowIt id={duplicateOf} onShow={props.onShow} />
          </>
        )}
      </p>
    ) : null;

  return (
    <>
      <div className="d-head rel-head">
        <div className="rel-top">
          <button
            type="button"
            className="linkbtn"
            aria-label={`Back to ${nameOf(graph, props.focusId)}`}
            onClick={props.onBack}
          >
            <Icon name="back" size="sm" />
            {nameOf(graph, props.focusId)}
          </button>
          {editable && (
            <button
              ref={trash}
              type="button"
              className="icon-btn delete-element-btn"
              aria-label="Delete relationship"
              title="Delete relationship"
              onClick={() => {
                setDeleting({ busy: false, error: null, stale: false });
              }}
            >
              <Icon name="trash" />
            </button>
          )}
        </div>
        <div className="d-type">
          <EdgeSample type={relationship.type} twoWay={relationship.twoWay === true} />
          {relationshipTypeLine(relationship)}
        </div>
        <h2 ref={heading} tabIndex={-1}>
          {savedSentence}
        </h2>
      </div>

      <section aria-label="Ends">
        <h3>Ends</h3>
        <ul className="rel-ends-list">
          {shownEnds.map(([caption, end]) =>
            end && typeof end === 'object' ? (
              <li key={caption as string}>
                <button
                  type="button"
                  className="rel rel-endrow"
                  aria-label={`${caption as string}: ${end.name || '(unnamed)'}, ${end.type}. Go to element`}
                  onClick={() => {
                    props.onFocusElement(end.id);
                  }}
                >
                  <span className="rcap">{caption as string}</span>
                  <TypeMark type={end.type} />
                  <span className="rname">{end.name || '(unnamed)'}</span>
                  <span className="rtype">{end.type}</span>
                  <Icon name="chev-right" size="sm" />
                </button>
              </li>
            ) : null,
          )}
        </ul>
        {/* Reverse changes nothing on a two-way relationship. */}
        {editable && !draft.twoWay && (
          <div className="reverse-row">
            <button
              id="rf-reverse"
              type="button"
              className="btn"
              aria-pressed={draft.reversed}
              disabled={self || saving}
              aria-describedby={
                reverseProblem || errors.has('reverse') ? 'rf-reverse-error' : undefined
              }
              onClick={() => {
                setDraft({ ...draft, reversed: !draft.reversed });
              }}
            >
              <Icon name="arrow-left-right" size="sm" />
              Reverse direction
            </button>
            {draft.reversed && <span className="tag">Reversed</span>}
          </div>
        )}
        {self && editable && <p className="hint">Both ends are the same element.</p>}
        {reverseProblem && !errors.has('reverse') && (
          <p className="field-error" id="rf-reverse-error">
            <Icon name="alert" size="sm" />
            {reverseProblem.message}
            {reverseProblem.kind === 'duplicate' && (
              <>
                {' '}
                <ShowIt id={reverseProblem.duplicateOf} onShow={props.onShow} />
              </>
            )}
          </p>
        )}
        {fieldError('reverse')}
        {relationship.label && (
          <p className="rel-label">
            <span className="muted">Label</span> “{relationship.label}”
            <span className="muted"> · from the import</span>
          </p>
        )}
      </section>

      {!editable ? (
        <>
          <p className="editing-off">
            This relationship has no id, so it can&apos;t be edited here.
          </p>
          {base.custom.length > 0 && (
            <section>
              <h3>
                Custom metadata <span className="count">{base.custom.length}</span>
              </h3>
              <dl className="props">
                {base.custom.map((row) => (
                  <div key={row.key}>
                    <dt>{row.key}</dt>
                    <dd>
                      <MetadataValue name={row.key} value={row.original} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </>
      ) : (
        <form
          className="d-form"
          aria-label={`Relationship ${savedSentence}`}
          aria-busy={saving || undefined}
          noValidate
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void save();
            } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
              // Enter in a one-line field doesn't save, as on the element form.
              event.preventDefault();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {conflict !== null && (
            <div className={`conflict${conflict === 'changed' ? '' : ' is-deleted'}`} role="alert">
              <Icon name="alert" />
              <div>
                <h3 tabIndex={-1}>
                  {conflict === 'changed'
                    ? 'Someone else changed this relationship'
                    : conflict === 'deleted'
                      ? 'Someone else deleted this relationship'
                      : `Someone else deleted ${conflict.end}`}
                </h3>
                <p>
                  {conflict === 'changed'
                    ? "Your changes aren't saved. Reload to see the latest version; this discards your changes, so copy anything you want to keep first."
                    : conflict === 'deleted'
                      ? "Your changes can't be saved. Copy anything you want to keep, then close the form."
                      : 'This relationship went with it.'}
                </p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (conflict === 'changed') void reload();
                    else props.onRemoved(relationship.id, undefined, '');
                  }}
                >
                  {conflict === 'changed' ? 'Reload' : 'Close form'}
                </button>
              </div>
            </div>
          )}
          {errors.has('') && (
            <div className="form-alert" role="alert">
              <Icon name="alert" />
              <div>
                <p className="form-alert-title">The changes weren&apos;t saved.</p>
                <p>{errors.get('')}</p>
              </div>
            </div>
          )}
          <section className="form-block">
            <div className="field">
              <label htmlFor="rf-label">Label</label>
              <input
                id="rf-label"
                value={draft.label}
                readOnly={saving}
                aria-invalid={errors.has('label') || undefined}
                onChange={(event) => {
                  setDraft({ ...draft, label: event.target.value });
                }}
              />
              {fieldError('label')}
            </div>
            <div className="field" id="rf-type" tabIndex={-1}>
              <TypeSegments
                name="rf-type"
                value={draft.type}
                problems={problems}
                onShow={props.onShow}
                disabled={saving}
                onChange={(type) => {
                  // Contains is always one way, and never an Information flow.
                  setDraft({
                    ...draft,
                    type,
                    twoWay: canBeTwoWay(type) && draft.twoWay,
                    informationFlow: canHaveInformationFlow(type) && draft.informationFlow,
                  });
                }}
              >
                <div aria-live="polite">
                  <TypeNote note={typeNote} />
                  {base.informationFlow && !canHaveInformationFlow(draft.type) && (
                    <TypeNote
                      note={{ kind: 'info', text: 'Information flow is removed when you save.' }}
                    />
                  )}
                </div>
              </TypeSegments>
              {fieldError('type')}
              {canHaveInformationFlow(draft.type) && (
                <InformationFlowBox
                  checked={draft.informationFlow}
                  disabled={saving}
                  onChange={(informationFlow) => {
                    setDraft({ ...draft, informationFlow });
                  }}
                />
              )}
              {fieldError(informationFlowKey)}
            </div>
            {canBeTwoWay(draft.type) && (
              <div className="field">
                <DirectionSegments
                  name="rf-direction"
                  twoWay={draft.twoWay}
                  disabled={saving}
                  onChange={(twoWay) => {
                    // Reverse means nothing both ways: it is dropped.
                    setDraft({ ...draft, twoWay, reversed: twoWay ? false : draft.reversed });
                  }}
                />
                {fieldError('twoWay')}
              </div>
            )}
            <div className="field">
              <StateSegments
                name="rf-state"
                value={draft.state}
                disabled={saving}
                onChange={(state) => {
                  setDraft({ ...draft, state });
                }}
              />
              {fieldError('architectureState')}
            </div>
            <div className="field">
              <label htmlFor="rf-description">Description</label>
              <textarea
                id="rf-description"
                className="desc-field"
                value={draft.description}
                readOnly={saving}
                aria-invalid={errors.has('description') || undefined}
                onChange={(event) => {
                  setDraft({ ...draft, description: event.target.value });
                }}
              />
              {fieldError('description')}
            </div>
          </section>
          <section className="form-block">
            <CustomMetadataFields
              rows={draft.custom}
              saving={saving}
              addId="rf-add-field"
              slotId={rowInputId}
              errorId={(slot) => `rf-${slot || 'alert'}-error`}
              renderError={fieldError}
              invalid={(slot) => errors.has(slot)}
              valuesOf={(key) => relationshipPropertyValues(graph).get(key) ?? []}
              onEdit={(slot, rows) => {
                setDraft({ ...draft, custom: rows });
                if (errors.has(slot)) {
                  const rest = new Map(errors);
                  rest.delete(slot);
                  setErrors(rest);
                }
              }}
              onAdd={(rows, focusId) => {
                focusTarget.current = focusId;
                setDraft({ ...draft, custom: rows });
              }}
              onRemoved={(focusId) => {
                focusTarget.current = focusId;
              }}
            />
          </section>
          {dirty || saving ? (
            <div className="d-form-foot">
              <p className="foot-status" role="status">
                Unsaved changes
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
      )}

      <div className="d-foot">
        <span>ID</span>
        <code>{relationship.id}</code>
        <button
          type="button"
          className="icon-btn"
          aria-label="Copy relationship ID"
          title="Copy relationship ID"
          onClick={() => {
            void navigator.clipboard.writeText(relationship.id).then(
              () => {
                props.onAnnounce('Relationship ID copied');
              },
              () => undefined,
            );
          }}
        >
          <Icon name="copy" size="sm" />
        </button>
      </div>

      {askDiscard && (
        <UnsavedDialog
          kind="discard"
          subject="relationship"
          name={savedSentence}
          saving={false}
          canSave={canSave}
          onKeep={() => {
            setAskDiscard(false);
          }}
          onDiscard={() => {
            setAskDiscard(false);
            discard();
          }}
          onSave={() => {
            setAskDiscard(false);
          }}
        />
      )}
      {deleting && (
        <DeleteRelationshipDialog
          sentence={savedSentence}
          nestNote={
            nestedNow
              ? `${nameOf(graph, relationship.target)} is no longer nested in ${nameOf(graph, relationship.source)}. It stays in the model and on the canvas, and the canvas tidies up.`
              : undefined
          }
          dirty={dirty}
          busy={deleting.busy}
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
            setDeleting(null);
            void reload().then(() => trash.current?.focus());
          }}
        />
      )}
    </>
  );
}

function ShowIt({ id, onShow }: { id: string; onShow: (id: string) => void }) {
  return (
    <button
      type="button"
      className="linkbtn"
      onClick={() => {
        onShow(id);
      }}
    >
      Show it
    </button>
  );
}

function DeleteRelationshipDialog(props: {
  sentence: string;
  nestNote: string | undefined;
  dirty: boolean;
  busy: boolean;
  error: string | null;
  stale: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onReload: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Modal
      id="delete-rel"
      onCancel={props.onCancel}
      busy={props.busy}
      initialFocus={cancel}
      describedBy="delete-rel-text"
    >
      <h2 id="delete-rel-title">Delete this relationship?</h2>
      <p id="delete-rel-text">
        {props.sentence}. This deletes it for everyone. It can&apos;t be undone.
      </p>
      {props.nestNote && (
        <p className="type-note">
          <Icon name="info" />
          <span>{props.nestNote}</span>
        </p>
      )}
      {props.dirty && <p className="hint">Your unsaved changes to it are discarded.</p>}
      {props.error !== null && (
        <p className="alert" role="alert">
          {props.error}
        </p>
      )}
      <div className="row">
        <button
          ref={cancel}
          type="button"
          className="btn"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </button>
        {props.stale ? (
          <button type="button" className="btn" onClick={props.onReload}>
            Reload
          </button>
        ) : (
          <button
            type="button"
            className="btn danger"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? 'Deleting…' : 'Delete relationship'}
          </button>
        )}
      </div>
    </Modal>
  );
}

import {
  canBeTwoWay,
  containerOf,
  containsType,
  dataValuesOf,
  displayLabel,
  edgeTypes,
  hasStandardEdgeProperty,
  isRelationDataProperty,
  isRelationProperty,
  relationProperties,
  relationshipOfEdge,
  relationshipProblems,
  relationshipMetadataNames,
  relationshipPropertyValues,
  retiredDataKey,
  type ArchitectureState,
  type DeletedRelationshipResult,
  type EdgeType,
  type JgfEdge,
  type LabelSubject,
  type ModelGraph,
  type ModelRelationship,
  type RelationshipChangeResult,
  type RelationshipProblem,
  type RelationDataProperty,
  type RelationProperty,
  standardProperties,
  type UpdateRelationshipRequest,
  withDataValue,
} from '@simplearchitecture/shared';
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { ApiRequestError, deleteRelationship, getRelationship, updateRelationship } from '../api';
import { Icon } from '../icons';
import { EdgeSample, relationshipTypeLine, TypeMark } from '../metamodel-ui';
import { MetadataValue } from '../viewing/explorer/DetailsPanel';
import { CustomMetadataFields } from './CustomMetadataFields';
import { Modal, UnsavedDialog } from './dialogs';
import { EndPicker } from './EndPicker';
import { customRow, customRowErrors, customValues, metadataChanges, type CustomRow } from './draft';
import type { EditorHandle, EditorState } from './ElementEditor';
import { savedNoteMillis } from './ElementEditor';
import { LabelField } from './LabelField';
import { relationshipVersionToSave } from './save';
import { ValueField } from './ValueField';
import { ValueListField } from './ValueListField';
import {
  containsNote,
  DirectionSegments,
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

/** A relationship's two ends: the element ids. */
interface Ends {
  source: string;
  target: string;
}

type End = keyof Ends;

interface Draft {
  /** The ends as picked with Change, before Reverse: Reverse swaps them when saved. */
  ends: Ends;
  type: EdgeType;
  state: ArchitectureState;
  description: string;
  label: string;
  reversed: boolean;
  /** Both ways; always false for a type that can't be two-way. */
  twoWay: boolean;
  /** Identity and Identity Context, as typed. */
  texts: Record<TextProperty, string>;
  /** Request Data and Response Data: the values, and what is typed but not yet added. */
  data: Record<RelationDataProperty, { values: readonly string[]; text: string }>;
  custom: CustomRow[];
}

/** A Relation's text properties: Identity and Identity Context. */
type TextProperty = Exclude<RelationProperty, RelationDataProperty>;
const textProperties = relationProperties.filter(
  (key): key is TextProperty => !isRelationDataProperty(key),
);
const dataProperties = relationProperties.filter(isRelationDataProperty);
const noData: Draft['data'][RelationDataProperty] = { values: [], text: '' };

/** One entry per Data field. */
const perDataField = <T,>(
  make: (key: RelationDataProperty) => T,
): Record<RelationDataProperty, T> => ({
  requestData: make('requestData'),
  responseData: make('responseData'),
});

/** The values a Data field saves: those added, and what is typed if it is a new one. */
const dataOf = (draft: Draft, key: RelationDataProperty): readonly string[] =>
  withDataValue(draft.data[key].values, draft.data[key].text);

const sameValues = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** Whether the draft holds a value for a Relation property. */
const hasValue = (draft: Draft, key: RelationProperty): boolean =>
  isRelationDataProperty(key) ? dataOf(draft, key).length > 0 : draft.texts[key].trim() !== '';

/** Metadata with a field of its own on the form, so it has no custom row. */
const ownFields = new Set<string>(['architectureState', 'description', ...relationProperties]);

const noValues: readonly string[] = [];

/** A stored Identity or Identity Context as text: what the field shows. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

const fits = (type: EdgeType, key: RelationProperty): boolean => hasStandardEdgeProperty(key, type);

type Conflict = 'changed' | 'deleted' | { end: string } | null;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function draftOf(relationship: ModelRelationship): Draft {
  const description = relationship.metadata.description;
  return {
    ends: { source: relationship.source, target: relationship.target },
    type: relationship.type,
    state: relationship.architectureState,
    description: typeof description === 'string' ? description : '',
    label: relationship.label ?? '',
    reversed: false,
    twoWay: relationship.twoWay === true,
    texts: Object.fromEntries(
      textProperties.map((key) => [key, textOf(relationship.metadata[key])]),
    ) as Draft['texts'],
    data: perDataField((key) => ({ values: dataValuesOf(relationship.metadata[key]), text: '' })),
    custom: Object.entries(relationship.metadata)
      // On a Contains these keys aren't fields, so a stored value shows as a custom row.
      .filter(
        ([key]) =>
          !ownFields.has(key) || (isRelationProperty(key) && !fits(relationship.type, key)),
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => customRow(key, value)),
  };
}

const rowInputId = (slot: string): string => `rf-${slot.replace(/[^A-Za-z0-9_-]/g, '-')}-key`;

/** Why a key can't be a custom row here, if so. */
function reservedKeyWord(key: string): string | undefined {
  if (key === 'type' || key === 'informationFlow') return `“${key}” is reserved.`;
  if (key === retiredDataKey)
    return `“${key}” is reserved: Data is now Request Data and Response Data.`;
  if (isRelationProperty(key)) return `“${key}” is a standard property of a Relation.`;
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

  // The ends as they will be saved: Reverse swaps the ends picked.
  const source = draft.reversed ? draft.ends.target : draft.ends.source;
  const target = draft.reversed ? draft.ends.source : draft.ends.target;
  const endsChanged =
    draft.ends.source !== base.ends.source || draft.ends.target !== base.ends.target;
  const self = source === target;
  // The Change box open for an end (as the form shows it: source first), if any.
  const [picking, setPicking] = useState<End | null>(null);
  // Which shown end was changed with Change: one that Reverse alone wouldn't show.
  const reversedOnly: Ends = draft.reversed
    ? { source: base.ends.target, target: base.ends.source }
    : base.ends;
  const changedEnds: Record<End, boolean> = {
    source: source !== reversedOnly.source,
    target: target !== reversedOnly.target,
  };
  const changedEnd = (): End => (changedEnds.target ? 'target' : 'source');
  const savedSentence = relationshipSentence(graph, relationship);
  const savedLabel = displayLabel(relationship, graph);
  // The relationship as the form holds it: what the Label's `{Name}` is filled in from.
  const labelSubject: LabelSubject = {
    type: draft.type,
    architectureState: draft.state,
    metadata: {
      ...Object.fromEntries(customValues(draft.custom)),
      description: draft.description,
      ...Object.fromEntries(
        relationProperties
          .filter((key) => fits(draft.type, key))
          .map((key) => [key, isRelationDataProperty(key) ? dataOf(draft, key) : draft.texts[key]]),
      ),
    },
  };
  const customChange = metadataChanges(customValues(base.custom), customValues(draft.custom));
  const dirty =
    draft.type !== base.type ||
    draft.state !== base.state ||
    draft.description.trim() !== base.description.trim() ||
    draft.label.trim() !== base.label.trim() ||
    draft.twoWay !== base.twoWay ||
    textProperties.some((key) => draft.texts[key].trim() !== base.texts[key].trim()) ||
    dataProperties.some((key) => !sameValues(dataOf(draft, key), dataOf(base, key))) ||
    Object.keys(customChange).length > 0 ||
    draft.reversed ||
    endsChanged;

  /** A fresh start from the server's copy (after a save, a reload, or a change elsewhere). */
  const reset = (next: ModelRelationship) => {
    const fresh = draftOf(next);
    setStartedFrom(next);
    setBase(fresh);
    setDraft(fresh);
    setErrors(new Map());
    setDuplicateOf(undefined);
    setPicking(null);
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
  const movesEnds = draft.reversed || endsChanged;
  const touchesEnds = movesEnds || draft.type !== base.type;
  const ignore = { ignore: relationship.id };
  // Both ends picked as the same element: said at the ends, not at every type.
  const pickedSelf = endsChanged && self;
  // Refused types for the (possibly reversed or changed) ends; the saved type stays allowed while
  // the ends stay.
  const problems = new Map<EdgeType, RelationshipProblem | undefined>(
    edgeTypes.map((type) => [
      type,
      (type === base.type && !movesEnds) || pickedSelf
        ? undefined
        : relationshipProblems(graph, { source, target, type, ...ignore })[0],
    ]),
  );
  const endsProblem: RelationshipProblem | undefined = pickedSelf
    ? { kind: 'self', message: 'Both ends are the same element.' }
    : movesEnds
      ? problems.get(draft.type)
      : undefined;
  const clientProblem = endsProblem ?? (touchesEnds ? problems.get(draft.type) : undefined);
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
      if (clientProblem) {
        const at = !endsProblem
          ? 'rf-type'
          : endsChanged
            ? `rf-change-${changedEnd()}`
            : 'rf-reverse';
        document.getElementById(at)?.focus();
      }
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
      // New ends go as the ends to save, already reversed; Reverse alone goes as `reverse`.
      if (endsChanged) {
        if (source !== base.ends.source) change.source = source;
        if (target !== base.ends.target) change.target = target;
      } else if (draft.reversed) {
        change.reverse = true;
      }
      if (draft.twoWay !== base.twoWay) change.twoWay = draft.twoWay;
      for (const key of textProperties) {
        const text = draft.texts[key].trim();
        if (text !== base.texts[key].trim()) change[key] = text === '' ? null : text;
      }
      for (const key of dataProperties) {
        const values = dataOf(draft, key);
        if (!sameValues(values, dataOf(base, key))) {
          change[key] = values.length === 0 ? null : [...values];
        }
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
          const slot = ['source', 'target', 'reverse'].includes(issue.field)
            ? 'ends'
            : [
                  'type',
                  'architectureState',
                  'description',
                  'label',
                  'twoWay',
                  ...relationProperties,
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

  /** Ctrl+Enter (⌘+Enter on a Mac) saves, anywhere on the form and in Ends; true when it did. */
  const saveKey = (event: KeyboardEvent): boolean => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return false;
    event.preventDefault();
    void save();
    return true;
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
    draft.type === containsType && touchesEnds && !self
      ? containsNote(graph, source, target, props.nest)
      : draft.type !== containsType && base.type === containsType && nestedNow
        ? {
            kind: 'info' as const,
            text: `After saving, ${nameOf(graph, relationship.target)} is no longer nested in ${nameOf(graph, relationship.source)}; Tidy up redraws the canvas.`,
          }
        : undefined;
  const [first, second] = draft.twoWay ? ['Between', 'And'] : ['From', 'To'];
  const shownEnds: { end: End; caption: string; id: string }[] = [
    { end: 'source', caption: first, id: source },
    { end: 'target', caption: second, id: target },
  ];
  /** A picked element becomes this shown end: the end it is before Reverse swaps them. */
  const pickEnd = (end: End, picked: string) => {
    const slot: End = draft.reversed ? (end === 'source' ? 'target' : 'source') : end;
    setDraft({ ...draft, ends: { ...draft.ends, [slot]: picked } });
    if (errors.has('ends')) {
      const rest = new Map(errors);
      rest.delete('ends');
      setErrors(rest);
      setDuplicateOf(undefined);
    }
  };
  const closePicker = (end: End, refocus: boolean) => {
    setPicking(null);
    if (refocus) requestAnimationFrame(() => document.getElementById(`rf-change-${end}`)?.focus());
  };
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

      {/* Outside the form, so Ctrl+Enter is handled here too. */}
      <section aria-label="Ends" onKeyDown={editable ? saveKey : undefined}>
        <h3>Ends</h3>
        <ul className="rel-ends-list">
          {shownEnds.map(({ end, caption, id }) => {
            const shown = graph.elements.get(id);
            const name = shown?.name || '(unnamed)';
            return (
              <li key={end}>
                <div className="end-row">
                  {shown ? (
                    <button
                      type="button"
                      className="rel rel-endrow"
                      aria-label={`${caption}: ${name}, ${shown.type}${changedEnds[end] ? ', changed, not saved yet' : ''}. Go to element`}
                      onClick={() => {
                        props.onFocusElement(shown.id);
                      }}
                    >
                      <span className="rcap">{caption}</span>
                      <TypeMark type={shown.type} />
                      <span className="rname">{name}</span>
                      <span className="rtype">{shown.type}</span>
                      <Icon name="chev-right" size="sm" />
                    </button>
                  ) : (
                    <span className="rel rel-endrow">
                      <span className="rcap">{caption}</span>
                    </span>
                  )}
                  {editable && changedEnds[end] && (
                    <span className="tag" aria-hidden="true">
                      Changed
                    </span>
                  )}
                  {editable && (
                    <button
                      id={`rf-change-${end}`}
                      type="button"
                      className="btn sm end-change"
                      aria-label={`Change ${caption}: ${name}`}
                      aria-expanded={picking === end}
                      aria-describedby={
                        endsProblem || errors.has('ends') ? 'rf-ends-error' : undefined
                      }
                      disabled={saving}
                      onMouseDown={(event) => {
                        // An open box stays focused, so this click closes it (no blur first).
                        if (picking === end) event.preventDefault();
                      }}
                      onClick={(event) => {
                        if (picking === end) event.currentTarget.focus();
                        setPicking(picking === end ? null : end);
                      }}
                    >
                      Change
                    </button>
                  )}
                </div>
                {picking === end && (
                  <EndPicker
                    graph={graph}
                    caption={caption}
                    current={id}
                    other={end === 'source' ? target : source}
                    onPick={(picked) => {
                      pickEnd(end, picked.id);
                      closePicker(end, true);
                      props.onAnnounce(
                        picked.id === id
                          ? `${caption} stays ${name}.`
                          : `${caption}: ${picked.name || '(unnamed)'}. Save to keep it.`,
                      );
                    }}
                    onClose={(refocus) => {
                      closePicker(end, refocus);
                    }}
                  />
                )}
              </li>
            );
          })}
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
              aria-describedby={endsProblem || errors.has('ends') ? 'rf-ends-error' : undefined}
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
        {self && editable && !pickedSelf && <p className="hint">Both ends are the same element.</p>}
        {endsProblem && !errors.has('ends') && (
          <p className="field-error" id="rf-ends-error">
            <Icon name="alert" size="sm" />
            {endsProblem.message}
            {endsProblem.kind === 'duplicate' && (
              <>
                {' '}
                <ShowIt id={endsProblem.duplicateOf} onShow={props.onShow} />
              </>
            )}
          </p>
        )}
        {fieldError('ends')}
        {savedLabel !== undefined && (
          <p className="rel-label">
            <span className="muted">Label</span> “{savedLabel}”
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
            if (saveKey(event)) return;
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
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
              <LabelField
                id="rf-label"
                value={draft.label}
                subject={labelSubject}
                names={relationshipMetadataNames(graph)}
                readOnly={saving}
                invalid={errors.has('label')}
                errorId={errors.has('label') ? 'rf-label-error' : undefined}
                onValue={(text) => {
                  setDraft({ ...draft, label: text });
                }}
              />
              {fieldError('label')}
            </div>
            {relationProperties
              .filter((key) => fits(draft.type, key))
              .map((key) =>
                isRelationDataProperty(key) ? (
                  <div className="field" key={key}>
                    <label htmlFor={`rf-${key}`}>{standardProperties[key].label}</label>
                    <ValueListField
                      id={`rf-${key}`}
                      label={standardProperties[key].label}
                      values={draft.data[key].values}
                      text={draft.data[key].text}
                      suggestions={relationshipPropertyValues(graph).get(key) ?? noValues}
                      readOnly={saving}
                      aria-invalid={errors.has(key) || undefined}
                      aria-describedby={errors.has(key) ? `rf-${key}-error` : undefined}
                      onChange={(values, text) => {
                        setDraft({ ...draft, data: { ...draft.data, [key]: { values, text } } });
                      }}
                    />
                    {fieldError(key)}
                  </div>
                ) : (
                  <div className="field" key={key}>
                    <label htmlFor={`rf-${key}`}>{standardProperties[key].label}</label>
                    <div className="value-anchor">
                      <ValueField
                        id={`rf-${key}`}
                        value={draft.texts[key]}
                        values={relationshipPropertyValues(graph).get(key) ?? noValues}
                        label={standardProperties[key].label}
                        readOnly={saving}
                        aria-invalid={errors.has(key) || undefined}
                        aria-describedby={errors.has(key) ? `rf-${key}-error` : undefined}
                        onValue={(text) => {
                          setDraft({ ...draft, texts: { ...draft.texts, [key]: text } });
                        }}
                      />
                    </div>
                    {fieldError(key)}
                  </div>
                ),
              )}
            <div className="field" id="rf-type" tabIndex={-1}>
              <TypeSegments
                name="rf-type"
                value={draft.type}
                problems={problems}
                onShow={props.onShow}
                disabled={saving}
                onChange={(type) => {
                  // Contains is always one way, and has none of a Relation's text properties.
                  setDraft({
                    ...draft,
                    type,
                    twoWay: canBeTwoWay(type) && draft.twoWay,
                    texts: Object.fromEntries(
                      textProperties.map((key) => [key, fits(type, key) ? draft.texts[key] : '']),
                    ) as Draft['texts'],
                    data: perDataField((key) => (fits(type, key) ? draft.data[key] : noData)),
                  });
                }}
              >
                <div aria-live="polite">
                  <TypeNote note={typeNote} />
                  {draft.type !== base.type &&
                    relationProperties.some(
                      (key) => hasValue(base, key) && !fits(draft.type, key),
                    ) && (
                      <TypeNote
                        note={{
                          kind: 'info',
                          text: 'Identity, Identity Context, Request Data and Response Data are removed when you save.',
                        }}
                      />
                    )}
                </div>
              </TypeSegments>
              {fieldError('type')}
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
              names={relationshipMetadataNames(graph)}
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
              ? `${nameOf(graph, relationship.target)} is no longer nested in ${nameOf(graph, relationship.source)}. It stays in the model and on the canvas; Tidy up redraws the canvas.`
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

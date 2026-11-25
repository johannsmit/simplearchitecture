import {
  canBeTwoWay,
  containerOf,
  containsType,
  dataListNames,
  dataValuesOf,
  definedPropertiesOf,
  edgeTypes,
  hasStandardEdgeProperty,
  isRelationDataProperty,
  isRelationProperty,
  relationProperties,
  relationshipOfEdge,
  relationshipProblems,
  relationshipMetadataNames,
  relationshipPropertyValues,
  type ArchitectureState,
  type DeletedRelationshipResult,
  type EdgeType,
  type JgfEdge,
  type LabelSubject,
  type ModelGraph,
  type ModelRelationship,
  type RelationshipChangeResult,
  type RelationshipProblem,
  type RelationshipPropertyDefinition,
  type RelationDataProperty,
  type RelationProperty,
  standardProperties,
  type UpdateRelationshipRequest,
  withDataValue,
} from '@simplearchitecture/shared';
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { ApiRequestError, deleteRelationship, getRelationship, updateRelationship } from '../api';
import { Icon } from '../icons';
import { EdgeSample, relationshipTypeLine } from '../metamodel-ui';
import { MetadataValue } from '../viewing/explorer/DetailsPanel';
import { EndLinks } from '../viewing/explorer/RelationshipDetails';
import { CustomMetadataFields } from './CustomMetadataFields';
import { Modal } from './dialogs';
import { EndField } from './EndField';
import { customRow, metadataChanges, type CustomRow } from './draft';
import type { EditorHandle, EditorState } from './ElementEditor';
import { LabelField } from './LabelField';
import { relationshipVersionToSave } from './save';
import { fixReason, SaveStatus } from './SaveStatus';
import { useAutoSave, type SaveOutcome, type SaveRun } from './useAutoSave';
import { ValueField } from './ValueField';
import { DataListLabel } from './DataListLabel';
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
  /**
   * The defined properties couldn't be read: a Relation's metadata can't be edited or saved until
   * they are (the form says so at the top).
   */
  propertiesFailed?: boolean;
  /** A save was refused for a defined property that is gone: read the definitions again. */
  onPropertiesStale?: () => void;
}

/** A relationship's two ends: the element ids. */
interface Ends {
  source: string;
  target: string;
}

type End = keyof Ends;

/** The field of an end as the form shows it: From for the source as it will be saved. */
const fieldIdOf = (end: End): string => (end === 'source' ? 'rf-from' : 'rf-to');

interface Draft {
  /** The ends as picked with From and To, before Reverse: Reverse swaps them when saved. */
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
  /**
   * The lists of data: the values, and what is typed but not yet added. Named by direction, so
   * Reverse swaps them (`withReversed`).
   */
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
  sourceToTargetData: make('sourceToTargetData'),
  targetToSourceData: make('targetToSourceData'),
});

/** The two lists swapped: what flowed from the source now flows to it, as the ends swap. */
const swappedData = (data: Draft['data']): Draft['data'] => ({
  sourceToTargetData: data.targetToSourceData,
  targetToSourceData: data.sourceToTargetData,
});

/**
 * The draft reversed or not. Reverse swaps the two lists with the ends, typed text included, so
 * each list stays with its direction and the same data flows between the same two elements.
 */
const withReversed = (draft: Draft, reversed: boolean): Draft =>
  reversed === draft.reversed ? draft : { ...draft, reversed, data: swappedData(draft.data) };

/** The draft with Reverse folded into its ends, as it stands once saved. */
const settled = (draft: Draft): Draft =>
  draft.reversed
    ? { ...draft, ends: { source: draft.ends.target, target: draft.ends.source }, reversed: false }
    : draft;

/**
 * The draft after a Reverse was saved: the ends picked swap and Reverse flips, so the ends it
 * stands for (and the lists named after them) stay as they are. A Reverse still pressed is then
 * saved; one undone meanwhile becomes a Reverse to send.
 */
const rebasedOnReverse = (draft: Draft): Draft => ({
  ...draft,
  ends: { source: draft.ends.target, target: draft.ends.source },
  reversed: !draft.reversed,
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

/** A metadata value as the field shows it. */
function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * The metadata (beyond the fields of its own) the draft stands for, as a PATCH compares it: the
 * rows of keys the relationship had (`stored`) and of the type's defined properties. A defined
 * property's typed text is trimmed, and an empty one has no value. A row for any other key (one
 * whose definition an Admin deleted meanwhile) counts for nothing: it can't be added.
 */
function metadataValues(
  rows: readonly CustomRow[],
  defined: ReadonlySet<string>,
  stored: ReadonlySet<string>,
): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const row of rows) {
    // Keys here are never typed: each is exactly as stored or defined, even blank or padded.
    const key = row.key;
    if (!defined.has(key) && !stored.has(key)) continue;
    const changed = row.editable && row.text !== asText(row.original);
    // Not set: an empty defined property has no value, whatever the row started from.
    if (defined.has(key) && row.editable && row.text.trim() === '') continue;
    if (!changed) {
      values.set(key, row.original);
    } else {
      values.set(key, defined.has(key) ? row.text.trim() : row.text);
    }
  }
  return values;
}

/** "A", "A and B", "A, B and C". */
function andList(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`;
}

const noDefinitions: readonly RelationshipPropertyDefinition[] = [];

/** The relationship in the details panel: always the form. */
export function RelationshipEditor(props: RelationshipEditorProps) {
  const { graph, relationship, modelId } = props;
  const propertiesFailed = props.propertiesFailed === true;
  const definitions = propertiesFailed ? noDefinitions : graph.relationshipProperties;
  // The copy the draft started from: what the user's changes are measured against.
  const [startedFrom, setStartedFrom] = useState(relationship);
  const [base, setBase] = useState(() => draftOf(relationship));
  const [draft, setDraft] = useState<Draft>(base);
  // The draft as the form opened (or reloaded): the type notes say what changed since.
  const [opened, setOpened] = useState(base);
  const [version, setVersion] = useState<number | undefined>(undefined);
  // The version the last save or reload gave: the next save sends it.
  const lastVersion = useRef<number | undefined>(undefined);
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [duplicateOf, setDuplicateOf] = useState<string | undefined>(undefined);
  const [conflict, setConflict] = useState<Conflict>(null);
  // The person may no longer edit the model (403): nothing more is sent.
  const [forbidden, setForbidden] = useState(false);
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
  // A defined property a save was refused for, because an Admin deleted it meanwhile.
  const [deletedProperty, setDeletedProperty] = useState<string | null>(null);
  // A Relation's defined properties, by name: each has a field of its own, always.
  const defined = definedPropertiesOf(draft.type, definitions);
  const definedKeys = new Set(defined.map((definition) => definition.key));
  // The keys the relationship has: their values can change or go, but no other key can be added.
  // Exactly as stored: a key an import left blank or padded with spaces is a key like any other.
  const storedKeys = new Set(base.custom.map((row) => row.key));
  const customRows = draft.custom.filter(
    (row) => !definedKeys.has(row.key) && storedKeys.has(row.key),
  );
  const rowOf = (key: string): CustomRow | undefined => draft.custom.find((row) => row.key === key);

  // The ends as they will be saved: Reverse swaps the ends picked.
  const source = draft.reversed ? draft.ends.target : draft.ends.source;
  const target = draft.reversed ? draft.ends.source : draft.ends.target;
  const endsChanged =
    draft.ends.source !== base.ends.source || draft.ends.target !== base.ends.target;
  const self = source === target;
  // The lists of data, named after the ends as they will be saved.
  const listNames = dataListNames(graph, source, target);
  // The end whose list is open (as the form shows it: source first), with what its search started
  // with, if any.
  const [picking, setPicking] = useState<{ end: End; initial: string } | null>(null);
  // Which shown end was picked with its field: one that Reverse alone wouldn't show.
  const reversedOnly: Ends = draft.reversed
    ? { source: base.ends.target, target: base.ends.source }
    : base.ends;
  const changedEnds: Record<End, boolean> = {
    source: source !== reversedOnly.source,
    target: target !== reversedOnly.target,
  };
  const savedSentence = relationshipSentence(graph, relationship);
  /** The newest version known: the last save's, or the one read when the form opened. */
  const knownVersion = (): number | undefined => {
    const known = [lastVersion.current, version].filter((v) => v !== undefined);
    return known.length > 0 ? Math.max(...known) : undefined;
  };
  // The relationship as the form holds it: what the Label's `{Name}` is filled in from.
  const labelSubject: LabelSubject = {
    type: draft.type,
    architectureState: draft.state,
    metadata: {
      ...Object.fromEntries(metadataValues(draft.custom, definedKeys, storedKeys)),
      description: draft.description,
      ...Object.fromEntries(
        relationProperties
          .filter((key) => fits(draft.type, key))
          .map((key) => [key, isRelationDataProperty(key) ? dataOf(draft, key) : draft.texts[key]]),
      ),
    },
  };
  const definedKeysOf = (type: EdgeType): Set<string> =>
    new Set(definedPropertiesOf(type, definitions).map((definition) => definition.key));
  const storedKeysOf = (from: Draft): Set<string> => new Set(from.custom.map((row) => row.key));

  /** What a PATCH sends to make `from` (a settled draft, as stored) into `to`; undefined if nothing. */
  const changeOf = (
    from: Draft,
    to: Draft,
  ): Omit<UpdateRelationshipRequest, 'version'> | undefined => {
    const change: Omit<UpdateRelationshipRequest, 'version'> = {};
    const toSource = to.reversed ? to.ends.target : to.ends.source;
    const toTarget = to.reversed ? to.ends.source : to.ends.target;
    if (to.type !== from.type) change.type = to.type;
    if (to.state !== from.state) change.architectureState = to.state;
    if (to.description.trim() !== from.description.trim()) {
      change.description = to.description.trim() === '' ? null : to.description.trim();
    }
    if (to.label.trim() !== from.label.trim()) {
      change.label = to.label.trim() === '' ? null : to.label.trim();
    }
    // New ends go as the ends to save, already reversed; Reverse alone goes as `reverse`.
    if (to.ends.source !== from.ends.source || to.ends.target !== from.ends.target) {
      if (toSource !== from.ends.source) change.source = toSource;
      if (toTarget !== from.ends.target) change.target = toTarget;
    } else if (to.reversed) {
      change.reverse = true;
    }
    if (to.twoWay !== from.twoWay) change.twoWay = to.twoWay;
    for (const key of textProperties) {
      const text = to.texts[key].trim();
      if (text !== from.texts[key].trim()) change[key] = text === '' ? null : text;
    }
    // With `reverse`, the server swaps the lists with the ends: a list goes only if it differs
    // from the swapped one. New ends go already reversed, so the lists go swapped as they are.
    const expected: Draft = change.reverse === true ? withReversed(from, true) : from;
    for (const key of dataProperties) {
      const values = dataOf(to, key);
      if (!sameValues(values, dataOf(expected, key))) {
        change[key] = values.length === 0 ? null : [...values];
      }
    }
    // Without the definitions, metadata isn't sent: the form can't tell what it may hold.
    const stored = storedKeysOf(from);
    const custom = metadataChanges(
      metadataValues(from.custom, definedKeysOf(from.type), stored),
      metadataValues(to.custom, definedKeysOf(to.type), stored),
    );
    if (Object.keys(custom).length > 0 && !propertiesFailed) change.metadata = custom;
    return Object.keys(change).length > 0 ? change : undefined;
  };
  const change = changeOf(base, draft);

  /** A fresh start from the server's copy (after a reload, or a change elsewhere). */
  const reset = (next: ModelRelationship) => {
    const fresh = draftOf(next);
    setStartedFrom(next);
    setOpened(fresh);
    setBase(fresh);
    setDraft(fresh);
    setErrors(new Map());
    setDuplicateOf(undefined);
    setPicking(null);
    setDeletedProperty(null);
  };

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
  const canSave = editable && conflict === null && !forbidden;

  /** `announced`: an alert box in the form says so already (see `SaveOutcome`). */
  const failed = (reason: string, announced = false): SaveOutcome => ({
    kind: 'failed',
    reason,
    announced,
  });
  const conflictReason = (): string =>
    conflict === 'changed'
      ? 'someone else changed this relationship'
      : conflict === 'deleted'
        ? 'someone else deleted this relationship'
        : `someone else deleted ${conflict?.end ?? 'an end'}`;

  /** Saves what the draft holds now; ends the checks refuse stay unsaved, the rest is saved. */
  const run: SaveRun = async (sending) => {
    if (!editable) return { kind: 'none' };
    if (conflict !== null) return failed(conflictReason(), true);
    if (forbidden) return failed('you can no longer edit this model', errors.has(''));
    if (changeOf(base, draft) === undefined) {
      setErrors(new Map());
      setDuplicateOf(undefined);
      return { kind: 'none' };
    }
    let send = draft;
    if (clientProblem !== undefined) {
      // A type change that the ends refuse: nothing goes until it is fixed.
      if (draft.type !== base.type) return failed(fixReason(1));
      send = { ...withReversed(draft, false), ends: base.ends };
    }
    const fix = clientProblem !== undefined ? failed(fixReason(1)) : undefined;
    const sent = changeOf(base, send);
    if (sent === undefined) return fix ?? { kind: 'none' };
    sending();
    setErrors(new Map());
    setDuplicateOf(undefined);
    try {
      const current = await relationshipVersionToSave(modelId, startedFrom, knownVersion());
      const result = await updateRelationship(modelId, relationship.id, {
        version: current,
        ...sent,
      });
      lastVersion.current = result.relationship.version;
      setStartedFrom(copyOf(result.relationship.edge));
      // What was sent is now stored. The draft stays as typed; a Reverse that was saved is folded
      // into the ends it shows.
      // Each row's original becomes the value it was saved with (see `metadataValues`).
      const values = metadataValues(send.custom, definedKeysOf(send.type), storedKeysOf(base));
      const now: Draft = {
        ...settled(send),
        custom: send.custom.map((row) =>
          row.editable && values.has(row.key) ? { ...row, original: values.get(row.key) } : row,
        ),
      };
      setBase(now);
      const originals = new Map(now.custom.map((row) => [row.id, row.original]));
      setDraft((current) => {
        const next = send.reversed ? rebasedOnReverse(current) : current;
        return {
          ...next,
          custom: next.custom.map((row) =>
            row.editable && originals.has(row.id)
              ? { ...row, original: originals.get(row.id) }
              : row,
          ),
        };
      });
      props.onStored(result, true);
      return fix ?? { kind: 'saved' };
    } catch (failure) {
      const status = failure instanceof ApiRequestError ? failure.status : 0;
      if (status === 409) {
        setConflict('changed');
        return failed('someone else changed this relationship', true);
      }
      if (status === 404) {
        const missing = (failure as ApiRequestError).body as { missing?: unknown } | undefined;
        const end =
          missing?.missing === 'source' || missing?.missing === 'target'
            ? nameOf(graph, missing.missing === 'source' ? source : target)
            : undefined;
        setConflict(end === undefined ? 'deleted' : { end });
        return failed(
          end === undefined
            ? 'someone else deleted this relationship'
            : `someone else deleted ${end}`,
          true,
        );
      }
      if (status === 403) {
        setForbidden(true);
        setErrors(new Map([['', 'You can no longer edit this model.']]));
        return failed('you can no longer edit this model', true);
      }
      const refusal = refusalOf(failure);
      // A message about a defined property goes under its field; about a custom key under its
      // row, or at the top if the row is gone.
      const customSlot = (field: string): string => {
        const key = field.startsWith('metadata.') ? field.slice('metadata.'.length) : undefined;
        if (key !== undefined && definedKeys.has(key)) return `prop:${key}`;
        const row = send.custom.find((candidate) => candidate.key === key);
        return row ? `row:${row.id}` : '';
      };
      // An Admin deleted a property filled in here: its value can't be saved. The definitions
      // are read again, so its field goes, and the other changes are sent again at once.
      const gone = refusal.fields.find((issue) => {
        const key = issue.field.startsWith('metadata.')
          ? issue.field.slice('metadata.'.length)
          : undefined;
        return (
          key !== undefined && definedKeys.has(key) && issue.message.includes("isn't a property")
        );
      });
      if (gone !== undefined) {
        const key = gone.field.slice('metadata.'.length);
        setDeletedProperty(defined.find((definition) => definition.key === key)?.name ?? key);
        setDraft((now) => ({
          ...now,
          custom: [
            ...now.custom.filter((row) => row.key !== key),
            ...base.custom.filter((row) => row.key === key),
          ],
        }));
        props.onPropertiesStale?.();
        return { kind: 'again' };
      }
      const next = new Map<string, string>();
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
      const count = [...next.keys()].filter((slot) => slot !== '').length;
      // A message for no field shows in the alert box at the top.
      const shown = next.has('');
      if (count > 0) return failed(fixReason(count), shown);
      if (status === 0 || status >= 500) return failed('check your connection', shown);
      return failed(refusal.message || "the change wasn't accepted", shown);
    }
  };
  const saver = useAutoSave(run);
  const dirty = change !== undefined || saver.busy;

  // The explorer's copy changed (e.g. read again from the server): follow it unless the user has
  // changes, which are never thrown away without asking. Those are sent as changes to the copy they
  // started from, so a change made elsewhere to anything else stays.
  if (
    relationship !== startedFrom &&
    change === undefined &&
    !saver.busy &&
    JSON.stringify(relationship) !== JSON.stringify(startedFrom)
  ) {
    reset(relationship);
  }

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

  const onState = props.onState;
  useEffect(() => {
    onState({ dirty, name: savedSentence, canSave, subject: 'relationship', autoSave: true });
  }, [dirty, savedSentence, canSave, onState]);
  useEffect(
    () => () => {
      onState(null);
    },
    [onState],
  );

  /** A change to the draft: a text field's waits for the typing pause, a pick's goes now. */
  const edit = (next: Draft, when: 'later' | 'now' = 'later') => {
    setDraft(next);
    setDeletedProperty(null);
    if (when === 'now') saver.now();
    else saver.later();
  };

  const discard = () => {
    setDraft(base);
    setErrors(new Map());
    setDuplicateOf(undefined);
  };

  /** Ctrl+Enter (⌘+Enter on a Mac) saves now, anywhere on the form and in Ends; true when it did. */
  const saveKey = (event: KeyboardEvent): boolean => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return false;
    event.preventDefault();
    saver.now();
    return true;
  };

  // Read when the explorer leaves the form: true once everything is stored.
  const clean = useRef(true);
  useLayoutEffect(() => {
    clean.current = change === undefined;
  });

  useImperativeHandle(props.handle, () => ({
    save: async () => {
      await saver.flush();
      return clean.current;
    },
    discard,
    name: savedSentence,
    canSave,
    failed: saver.phase === 'failed' ? saver.reason : undefined,
  }));

  const reload = async () => {
    try {
      const result = await getRelationship(modelId, relationship.id);
      lastVersion.current = result.relationship.version;
      setVersion(result.relationship.version);
      setConflict(null);
      saver.clear();
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
      // A change still being saved goes first, so the delete sends the version it gave.
      await saver.flush();
      const current = await relationshipVersionToSave(modelId, startedFrom, knownVersion());
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

  // A Relation's defined values stay as custom metadata on a Contains.
  const keptDefined =
    draft.type === containsType && opened.type !== containsType
      ? definedPropertiesOf(opened.type, definitions)
          .filter((definition) => {
            const row = rowOf(definition.key);
            return row !== undefined && (!row.editable || row.text.trim() !== '');
          })
          .map((definition) => definition.name)
      : [];
  const typeNote =
    draft.type === containsType && touchesEnds && !self
      ? containsNote(graph, source, target, props.nest)
      : draft.type !== containsType && base.type === containsType && nestedNow
        ? {
            kind: 'info' as const,
            text: `After saving, ${nameOf(graph, relationship.target)} is no longer nested in ${nameOf(graph, relationship.source)} when the canvas is opened again.`,
          }
        : undefined;
  // From and To always, also on a two-way relationship: From is the end saved as the source.
  const shownEnds: { end: End; caption: 'From' | 'To'; id: string }[] = [
    { end: 'source', caption: 'From', id: source },
    { end: 'target', caption: 'To', id: target },
  ];
  const endsError = endsProblem !== undefined || errors.has('ends');
  /** A picked element becomes this shown end: the end it is before Reverse swaps them. */
  const pickEnd = (end: End, picked: string) => {
    const slot: End = draft.reversed ? (end === 'source' ? 'target' : 'source') : end;
    edit({ ...draft, ends: { ...draft.ends, [slot]: picked } }, 'now');
    if (errors.has('ends')) {
      const rest = new Map(errors);
      rest.delete('ends');
      setErrors(rest);
      setDuplicateOf(undefined);
    }
  };
  const closePicker = (end: End, refocus: boolean) => {
    setPicking(null);
    if (refocus) requestAnimationFrame(() => document.getElementById(fieldIdOf(end))?.focus());
  };
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
            <div className="rel-top-actions">
              <SaveStatus saver={saver} />
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
            </div>
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

      {/* Outside the form, so Ctrl+Enter is handled here too. No visible heading: From and To
          follow the relationship's heading. */}
      <section className="end-section" aria-label="Ends" onKeyDown={editable ? saveKey : undefined}>
        {!editable ? (
          // Nothing can be picked without an id: the ends link to their elements, as in Viewing.
          <EndLinks
            graph={graph}
            relationship={relationship}
            onFocusElement={props.onFocusElement}
          />
        ) : (
          <>
            {shownEnds.map(({ end, caption, id }) => (
              <EndField
                key={end}
                graph={graph}
                id={fieldIdOf(end)}
                caption={caption}
                current={id}
                other={end === 'source' ? target : source}
                open={picking?.end === end ? picking.initial : null}
                changed={changedEnds[end]}
                invalid={endsError && changedEnds[end]}
                describedBy={endsError ? 'rf-ends-error' : undefined}
                disabled={false}
                onOpen={(initial) => {
                  setPicking(initial === null ? null : { end, initial });
                }}
                onPick={(picked) => {
                  pickEnd(end, picked.id);
                  closePicker(end, true);
                  props.onAnnounce(
                    picked.id === id
                      ? `${caption} stays ${nameOf(graph, id)}.`
                      : `${caption}: ${picked.name || '(unnamed)'}.`,
                  );
                }}
                onClose={(refocus) => {
                  closePicker(end, refocus);
                }}
              />
            ))}
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
            {self && !pickedSelf && <p className="hint">Both ends are the same element.</p>}
            {/* Reverse changes nothing on a two-way relationship. */}
            {!draft.twoWay && (
              <div className="reverse-row">
                <button
                  id="rf-reverse"
                  type="button"
                  className="btn"
                  aria-pressed={draft.reversed}
                  disabled={self}
                  aria-describedby={endsError ? 'rf-ends-error' : undefined}
                  onClick={() => {
                    edit(withReversed(draft, !draft.reversed), 'now');
                    if (dataProperties.some((key) => fits(draft.type, key))) {
                      props.onAnnounce(
                        draft.reversed
                          ? 'Reverse undone.'
                          : 'Reversed. The data lists follow their ends.',
                      );
                    }
                  }}
                >
                  <Icon name="arrow-left-right" size="sm" />
                  Reverse direction
                </button>
                {draft.reversed && <span className="tag">Reversed</span>}
              </div>
            )}
          </>
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
          noValidate
          onBlur={saver.blur}
          onKeyDown={(event) => {
            if (saveKey(event)) return;
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
              // Enter in a one-line field doesn't save, as on the element form.
              event.preventDefault();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            saver.now();
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
                {saver.phase === 'failed' && saver.reason === 'check your connection' && (
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
                <p>
                  An Admin deleted {deletedProperty}, so its value wasn&apos;t saved. Your other
                  changes are saved.
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
              <label htmlFor="rf-label">Label</label>
              <LabelField
                id="rf-label"
                value={draft.label}
                subject={labelSubject}
                names={relationshipMetadataNames(graph)}
                definitions={definitions}
                readOnly={false}
                invalid={errors.has('label')}
                errorId={errors.has('label') ? 'rf-label-error' : undefined}
                onValue={(text) => {
                  edit({ ...draft, label: text });
                }}
              />
              {fieldError('label')}
            </div>
            {textProperties
              .filter((key) => fits(draft.type, key))
              .map((key) => (
                <div className="field" key={key}>
                  <label htmlFor={`rf-${key}`}>{standardProperties[key].label}</label>
                  <div className="value-anchor">
                    <ValueField
                      id={`rf-${key}`}
                      value={draft.texts[key]}
                      values={relationshipPropertyValues(graph).get(key) ?? noValues}
                      label={standardProperties[key].label}
                      aria-invalid={errors.has(key) || undefined}
                      aria-describedby={errors.has(key) ? `rf-${key}-error` : undefined}
                      onValue={(text) => {
                        edit({ ...draft, texts: { ...draft.texts, [key]: text } });
                      }}
                      onPick={(text) => {
                        edit({ ...draft, texts: { ...draft.texts, [key]: text } }, 'now');
                      }}
                    />
                  </div>
                  {fieldError(key)}
                </div>
              ))}
            {dataProperties.some((key) => fits(draft.type, key)) && (
              // The lists are named after the ends as they will be saved; ids stay on the key, so
              // error links and focus survive a Change or a Reverse.
              <fieldset className="field-group">
                <legend>Data</legend>
                {dataProperties
                  .filter((key) => fits(draft.type, key))
                  .map((key) => (
                    <div className="field" key={key}>
                      <label htmlFor={`rf-${key}`}>
                        <DataListLabel name={listNames[key]} />
                      </label>
                      <ValueListField
                        id={`rf-${key}`}
                        label={listNames[key].full}
                        values={draft.data[key].values}
                        text={draft.data[key].text}
                        suggestions={relationshipPropertyValues(graph).get(key) ?? noValues}
                        aria-invalid={errors.has(key) || undefined}
                        aria-describedby={errors.has(key) ? `rf-${key}-error` : undefined}
                        onChange={(values, text) => {
                          // Adding or removing a value goes now; what is typed after the pause.
                          edit(
                            { ...draft, data: { ...draft.data, [key]: { values, text } } },
                            sameValues(values, draft.data[key].values) ? 'later' : 'now',
                          );
                        }}
                      />
                      {fieldError(key)}
                    </div>
                  ))}
              </fieldset>
            )}
            {defined.map((definition, index) => (
              <DefinedField
                key={definition.key}
                id={`rf-prop-${String(index)}`}
                definition={definition}
                row={rowOf(definition.key)}
                stored={base.custom.find((row) => row.key === definition.key)}
                suggestions={relationshipPropertyValues(graph).get(definition.key) ?? noValues}
                readOnly={false}
                error={fieldError(`prop:${definition.key}`)}
                invalid={errors.has(`prop:${definition.key}`)}
                onText={(text, now) => {
                  const row = rowOf(definition.key);
                  const custom = row
                    ? draft.custom.map((other) => (other === row ? { ...row, text } : other))
                    : [...draft.custom, { ...customRow(definition.key, ''), text }];
                  edit({ ...draft, custom }, now === true ? 'now' : 'later');
                }}
                onRemove={() => {
                  edit(
                    { ...draft, custom: draft.custom.filter((row) => row.key !== definition.key) },
                    'now',
                  );
                }}
              />
            ))}
            <div className="field" id="rf-type" tabIndex={-1}>
              <TypeSegments
                name="rf-type"
                value={draft.type}
                problems={problems}
                onShow={props.onShow}
                onChange={(type) => {
                  // Contains is always one way, and has none of a Relation's text properties.
                  edit(
                    {
                      ...draft,
                      type,
                      twoWay: canBeTwoWay(type) && draft.twoWay,
                      texts: Object.fromEntries(
                        textProperties.map((key) => [key, fits(type, key) ? draft.texts[key] : '']),
                      ) as Draft['texts'],
                      data: perDataField((key) => (fits(type, key) ? draft.data[key] : noData)),
                    },
                    'now',
                  );
                }}
              >
                <div aria-live="polite">
                  <TypeNote note={typeNote} />
                  {draft.type !== opened.type &&
                    relationProperties.some(
                      (key) => hasValue(opened, key) && !fits(draft.type, key),
                    ) && (
                      <TypeNote
                        note={{
                          kind: 'info',
                          text: 'Identity, Identity Context and the data in both directions were removed.',
                        }}
                      />
                    )}
                  {draft.type !== opened.type && keptDefined.length > 0 && (
                    <TypeNote
                      note={{
                        kind: 'info',
                        text: `${andList(keptDefined)} ${keptDefined.length === 1 ? 'is' : 'are'} kept as custom metadata.`,
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
                  onChange={(twoWay) => {
                    // Reverse means nothing both ways: it is dropped.
                    edit(
                      { ...withReversed(draft, twoWay ? false : draft.reversed), twoWay },
                      'now',
                    );
                  }}
                />
                {fieldError('twoWay')}
              </div>
            )}
            <div className="field">
              <StateSegments
                name="rf-state"
                value={draft.state}
                onChange={(state) => {
                  edit({ ...draft, state }, 'now');
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
                aria-invalid={errors.has('description') || undefined}
                onChange={(event) => {
                  edit({ ...draft, description: event.target.value });
                }}
              />
              {fieldError('description')}
            </div>
          </section>
          {customRows.length > 0 && (
            <section className="form-block">
              <CustomMetadataFields
                rows={customRows}
                canAdd={false}
                saving={propertiesFailed}
                addId="rf-new-properties"
                slotId={rowInputId}
                errorId={(slot) => `rf-${slot || 'alert'}-error`}
                renderError={fieldError}
                invalid={(slot) => errors.has(slot)}
                valuesOf={(key) => relationshipPropertyValues(graph).get(key) ?? []}
                names={noValues}
                onEdit={(slot, rows, now) => {
                  // The rows shown are the custom ones: the others (defined, or not stored) stay.
                  const shown = new Set(customRows);
                  edit(
                    {
                      ...draft,
                      custom: [...draft.custom.filter((row) => !shown.has(row)), ...rows],
                    },
                    now === true ? 'now' : 'later',
                  );
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
          )}
          <p className="hint" id="rf-new-properties" tabIndex={-1}>
            <Icon name="info" size="sm" />
            New properties are added by an Admin, in Admin → Properties.
          </p>
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

      {deleting && (
        <DeleteRelationshipDialog
          sentence={savedSentence}
          nestNote={
            nestedNow
              ? `${nameOf(graph, relationship.target)} is no longer nested in ${nameOf(graph, relationship.source)}. It stays in the model and on the canvas, and leaves its container when the canvas is opened again.`
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

/**
 * One defined property on a Relation's form: text (pick or type a value; a stored value with a line
 * break in a text area) or a choice ("Not set", then the options in their order). A choice value
 * outside the list, as stored, shows first as "not in the list" and stays until it is changed. A
 * list or an object under the key is kept as it is, and can only be removed.
 */
function DefinedField(props: {
  id: string;
  definition: RelationshipPropertyDefinition;
  /** The draft's row for the key, if it has one. */
  row: CustomRow | undefined;
  /** The row as the relationship was read, if it had the key. */
  stored: CustomRow | undefined;
  suggestions: readonly string[];
  readOnly: boolean;
  error: ReactNode;
  invalid: boolean;
  /** `now` for a pick (a choice, a suggestion), saved at once; not for typing. */
  onText: (text: string, now?: boolean) => void;
  onRemove: () => void;
}) {
  const { id, definition, row } = props;
  const text = row?.text ?? '';
  const errorId = props.invalid ? `rf-prop:${definition.key}-error` : undefined;
  if (row !== undefined && !row.editable) {
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
            <small id={`${id}-kept`}>
              {Array.isArray(row.original) ? 'List, kept as is' : 'Object, kept as is'}
            </small>
            <pre>{JSON.stringify(row.original, null, 2)}</pre>
          </div>
          <button
            type="button"
            className="icon-btn danger-hover"
            aria-label={`Remove ${definition.name}`}
            title="Remove"
            disabled={props.readOnly}
            onClick={props.onRemove}
          >
            <Icon name="trash" />
          </button>
        </div>
        {props.error}
      </div>
    );
  }
  if (definition.kind === 'choice') {
    const options = definition.options ?? [];
    const storedText = props.stored?.editable === true ? asText(props.stored.original) : '';
    // Kept while the value is still the stored one: once changed, only the list or Not set.
    const unlisted = text !== '' && !options.includes(text) && text === storedText;
    return (
      <div className="field">
        <label htmlFor={id}>{definition.name}</label>
        <div className="select-wrap">
          <select
            id={id}
            value={text}
            disabled={props.readOnly}
            aria-invalid={props.invalid || undefined}
            aria-describedby={errorId}
            onChange={(event) => {
              props.onText(event.target.value, true);
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
          readOnly={props.readOnly}
          aria-invalid={props.invalid || undefined}
          aria-describedby={errorId}
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
            readOnly={props.readOnly}
            aria-invalid={props.invalid || undefined}
            aria-describedby={errorId}
            onValue={(text) => {
              props.onText(text);
            }}
            onPick={(text) => {
              props.onText(text, true);
            }}
          />
        </div>
      )}
      {props.error}
    </div>
  );
}

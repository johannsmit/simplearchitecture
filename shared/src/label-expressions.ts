/**
 * Relationship labels that show property values: in a label such as
 * `{Identity} {Source to Target Data}`, each `{Name}` stands for the relationship's value of that
 * property. Pure functions, linear in the label's length, so the canvas, the details panel, the form
 * and the MCP tools fill in a label the same way. The stored label is always the expression as typed; nothing here changes it.
 */
import { dataValuesOf, dataValuesText } from './data-values.js';
import type { ModelGraph, ModelRelationship } from './graph.js';
import {
  hasStandardEdgeProperty,
  isOlderDataKey,
  isRelationDataProperty,
  olderDataKeys,
  isStandardPropertyKey,
  relationProperties,
  retiredDataKey,
  standardProperties,
  type ArchitectureState,
  type EdgeType,
  type StandardPropertyDefinition,
  type StandardPropertyKey,
} from './metamodel.js';
import {
  definedPropertiesOf,
  type RelationshipPropertyDefinition,
} from './relationship-properties.js';
import { relationshipMetadataNames } from './value-suggestions.js';

type Definitions = readonly RelationshipPropertyDefinition[];

/** What a label is filled in from: a relationship as stored, or a form's draft of one. */
export interface LabelSubject {
  type: EdgeType;
  architectureState: ArchitectureState;
  metadata: Readonly<Record<string, unknown>>;
}

export interface FilledLabel {
  /** The label with every known `{Name}` replaced; empty when nothing is left. */
  text: string;
  /** The names in braces that aren't properties of this relationship, as typed, once each. */
  unknown: string[];
}

/** The standard fields a relationship of this type has on its form, in the form's order. */
function fieldKeys(type: EdgeType): StandardPropertyKey[] {
  return [
    ...relationProperties.filter((key) => hasStandardEdgeProperty(key, type)),
    'architectureState',
    'description',
  ];
}

const ownFieldKeys = (type: EdgeType): ReadonlySet<string> => new Set<string>(fieldKeys(type));

/** Keys the server or app keeps for itself, e.g. `simplearchitecture:stored`. */
const internalPrefix = 'simplearchitecture:';

/**
 * The relationship's own custom metadata keys: what its form shows as custom rows. A Relation's
 * defined properties aren't custom: they have fields of their own.
 */
function customKeys(subject: LabelSubject, definitions: Definitions = []): string[] {
  const own = ownFieldKeys(subject.type);
  const defined = new Set(definedPropertiesOf(subject.type, definitions).map((d) => d.key));
  return Object.keys(subject.metadata).filter(
    (key) =>
      key !== 'type' && !own.has(key) && !defined.has(key) && !key.startsWith(internalPrefix),
  );
}

/** How a label writes a standard property: its label name, or its name. */
const labelNameOf = (key: StandardPropertyKey): string => {
  const definition: StandardPropertyDefinition = standardProperties[key];
  return definition.labelName ?? definition.label;
};

/** How names are compared: ignoring case, and runs of spaces count as one. */
const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * A value as one line of text, or undefined when it has none. Lists and objects have none, except
 * the two lists of data: their values joined by ", ".
 */
function valueText(key: string, value: unknown): string | undefined {
  return isRelationDataProperty(key) ? dataValuesText(dataValuesOf(value)) : textOf(value);
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

/**
 * What `{name}` stands for: `known` false for a name the relationship can't have; otherwise its
 * value, undefined when it has none.
 */
function lookUp(
  name: string,
  subject: LabelSubject,
  names: readonly string[],
  definitions: Definitions,
): { known: boolean; value?: string } {
  const wanted = nameKey(name);
  const found = (key: string): { known: boolean; value?: string } => {
    const value = valueText(key, subject.metadata[key]);
    return value === undefined ? { known: true } : { known: true, value };
  };
  for (const key of fieldKeys(subject.type)) {
    if (nameKey(standardProperties[key].label) !== wanted) continue;
    const value =
      key === 'architectureState'
        ? subject.architectureState
        : valueText(key, subject.metadata[key]);
    return value === undefined ? { known: true } : { known: true, value };
  }
  // A Relation's defined properties by name, then by key (labels written with an old key).
  const defined = definedPropertiesOf(subject.type, definitions);
  const byName = defined.find((definition) => nameKey(definition.name) === wanted);
  if (byName !== undefined) return found(byName.key);
  const byKey =
    defined.find((definition) => definition.key === name.trim()) ??
    defined.find((definition) => nameKey(definition.key) === wanted);
  if (byKey !== undefined) return found(byKey.key);
  const keys = customKeys(subject, definitions);
  // An exact match first, so `Owner` and `owner` can both be read.
  const key = keys.includes(name.trim())
    ? name.trim()
    : keys.find(
        (candidate) =>
          nameKey(candidate) === wanted ||
          (isStandardPropertyKey(candidate) &&
            nameKey(standardProperties[candidate].label) === wanted),
      );
  if (key !== undefined) return found(key);
  // A defined property's name or key on a Contains, or one this relationship has no value for.
  const knownNames = [
    ...names,
    ...definitions.flatMap((definition) => [definition.name, definition.key]),
  ];
  return { known: knownNames.some((other) => nameKey(other) === wanted) };
}

/** A piece of the filled-in label: text, or `null` for a property with no value. */
type Piece = string | null;

/**
 * Fills in a label: `{Name}` becomes the value of the property with that name, as the form shows it
 * (Identity, Identity Context, Source to Target Data, Target to Source Data, Architecture state,
 * Description) or a custom metadata name, ignoring case. The two lists of data give their values
 * joined by ", ". A standard key kept as custom metadata (Source to target data on a Contains)
 * answers to its standard name too. A property with no value gives nothing, and the spaces around it close up. A name
 * the relationship can't have stays as typed and is listed in `unknown`. `{{` and `}}` give literal
 * braces. `names` are custom metadata names other relationships in the model use: this one has no
 * value for them, so they give nothing rather than staying as typed. `definitions`: the properties
 * an Admin defined. On a Relation, `{Name}` is a defined property's name first, then its key, so a
 * label written with an old custom key keeps working; on a Contains the name gives nothing.
 */
export function fillLabel(
  label: string,
  subject: LabelSubject,
  names: readonly string[] = [],
  definitions: Definitions = [],
): FilledLabel {
  const pieces: Piece[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const length = label.length;
  let i = 0;
  while (i < length) {
    const char = label[i];
    if (char === '{' || char === '}') {
      if (label[i + 1] === char) {
        pieces.push(char);
        i += 2;
        continue;
      }
      if (char === '}') {
        pieces.push(char);
        i += 1;
        continue;
      }
      // A name runs to the next brace; it is one only if that brace closes it.
      let end = i + 1;
      while (end < length && label[end] !== '{' && label[end] !== '}') end++;
      const name = label.slice(i + 1, end);
      if (end >= length || label[end] === '{' || name.trim() === '') {
        pieces.push(label.slice(i, end));
        i = end;
        continue;
      }
      const found = lookUp(name, subject, names, definitions);
      if (!found.known) {
        pieces.push(label.slice(i, end + 1));
        const typed = name.trim();
        if (!seen.has(typed)) {
          seen.add(typed);
          unknown.push(typed);
        }
      } else {
        pieces.push(found.value ?? null);
      }
      i = end + 1;
      continue;
    }
    let end = i;
    while (end < length && label[end] !== '{' && label[end] !== '}') end++;
    pieces.push(label.slice(i, end));
    i = end;
  }
  return { text: joinPieces(pieces), unknown };
}

/** Joins the pieces, closing up the spaces around a property with no value to one at most. */
function joinPieces(pieces: readonly Piece[]): string {
  let text = '';
  let gap = false;
  let spaced = false;
  for (const piece of pieces) {
    if (piece === null) {
      if (!gap) {
        const trimmed = text.replace(/\s+$/, '');
        spaced = trimmed.length < text.length;
        text = trimmed;
        gap = true;
      }
      continue;
    }
    if (!gap) {
      text += piece;
      continue;
    }
    const rest = piece.replace(/^\s+/, '');
    if (rest.length < piece.length) spaced = true;
    if (rest === '') continue;
    text += (text !== '' && spaced ? ' ' : '') + rest;
    gap = false;
    spaced = false;
  }
  return text.trim();
}

/** The names in braces a label uses (`{Name}`; `{{` and `}}` are literal braces), trimmed. */
export function labelExpressionNames(label: string): string[] {
  const names: string[] = [];
  const length = label.length;
  let i = 0;
  while (i < length) {
    const char = label[i];
    if ((char === '{' || char === '}') && label[i + 1] === char) {
      i += 2;
      continue;
    }
    if (char !== '{') {
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < length && label[end] !== '{' && label[end] !== '}') end++;
    const name = label.slice(i + 1, end).trim();
    if (label[end] === '}' && name !== '') names.push(name);
    i = label[end] === '}' ? end + 1 : end;
  }
  return names;
}

/**
 * What a label now writes for an older name of a list of data (`Request Data` → `Source to Target
 * Data`), ignoring case and runs of spaces; undefined for any other name. The older names aren't
 * names any more: a form says what to write instead.
 */
export function newerLabelName(name: string): string | undefined {
  const wanted = nameKey(name);
  const older = Object.values(olderDataKeys).find((entry) => nameKey(entry.name) === wanted);
  return older === undefined ? undefined : labelNameOf(older.key);
}

/** Whether a label may hold something to fill in. */
export const isLabelExpression = (label: string): boolean => /[{}]/.test(label);

/**
 * The label a relationship shows: its label filled in, or undefined when it has none or it fills in
 * to nothing. With the model, a custom metadata name its other relationships use counts as known.
 */
export function displayLabel(
  relationship: Pick<ModelRelationship, 'label' | 'type' | 'architectureState' | 'metadata'>,
  graph?: ModelGraph,
): string | undefined {
  const { label } = relationship;
  if (label === undefined || !isLabelExpression(label)) return label;
  const names = graph === undefined ? [] : relationshipMetadataNames(graph);
  const definitions = graph?.relationshipProperties ?? [];
  const { text } = fillLabel(label, relationship, names, definitions);
  return text === '' ? undefined : text;
}

/**
 * The names a relationship's label can use, for suggesting: its standard fields in the form's order,
 * a Relation's defined properties by name, then its own custom metadata names (but leftover Data,
 * Request Data and Response Data) and those in `names`, once each, ignoring case.
 */
export function labelPropertyNames(
  subject: LabelSubject,
  names: readonly string[] = [],
  definitions: Definitions = [],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const key = nameKey(name);
    if (key === '' || /[{}]/.test(name) || seen.has(key)) return;
    seen.add(key);
    result.push(name);
  };
  for (const key of fieldKeys(subject.type)) add(labelNameOf(key));
  for (const definition of definedPropertiesOf(subject.type, definitions)) add(definition.name);
  // Data, Request Data and Response Data kept from before are only there to be moved or removed.
  for (const key of customKeys(subject, definitions)) {
    if (key !== retiredDataKey && !isOlderDataKey(key)) add(key);
  }
  for (const name of names) add(name);
  return result;
}

/**
 * The property name being typed at `caret`: after a `{` that isn't closed before it (and isn't
 * `{{`). Undefined when the caret isn't in one.
 */
export function labelNameAt(
  label: string,
  caret: number,
): { start: number; partial: string } | undefined {
  const end = Math.max(0, Math.min(caret, label.length));
  let open: number | undefined;
  let i = 0;
  while (i < end) {
    const char = label[i];
    if ((char === '{' || char === '}') && label[i + 1] === char && i + 1 < end) {
      i += 2;
      continue;
    }
    if (char === '{') open = i;
    else if (char === '}') open = undefined;
    i += 1;
  }
  if (open === undefined) return undefined;
  return { start: open, partial: label.slice(open + 1, end) };
}

/**
 * Puts `{name}` where the name at `caret` is being typed, in place of what is typed so far (and the
 * rest of that name up to its `}`, if it has one). Returns the label and where the caret goes: after
 * the `}`. Unchanged when the caret isn't in a name.
 */
export function insertLabelName(
  label: string,
  caret: number,
  name: string,
): { label: string; caret: number } {
  const at = labelNameAt(label, caret);
  if (at === undefined) return { label, caret };
  let end = Math.min(caret, label.length);
  let scan = end;
  while (scan < label.length && label[scan] !== '{' && label[scan] !== '}') scan++;
  if (label[scan] === '}') end = scan + 1;
  const before = `${label.slice(0, at.start)}{${name}}`;
  return { label: before + label.slice(end), caret: before.length };
}

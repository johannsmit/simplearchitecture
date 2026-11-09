/**
 * Relationship labels that show property values: in a label such as `{Identity} {Request Data}`,
 * each `{Name}` stands for the relationship's value of that property. Pure functions, linear in the
 * label's length, so the canvas, the details panel, the form and the MCP tools fill in a label the
 * same way. The stored label is always the expression as typed; nothing here changes it.
 */
import type { ModelGraph, ModelRelationship } from './graph.js';
import {
  hasStandardEdgeProperty,
  isStandardPropertyKey,
  relationTextProperties,
  standardProperties,
  type ArchitectureState,
  type EdgeType,
  type StandardPropertyKey,
} from './metamodel.js';
import { relationshipMetadataNames } from './value-suggestions.js';

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
    ...relationTextProperties.filter((key) => hasStandardEdgeProperty(key, type)),
    'architectureState',
    'description',
  ];
}

const ownFieldKeys = (type: EdgeType): ReadonlySet<string> => new Set<string>(fieldKeys(type));

/** Keys the server or app keeps for itself, e.g. `simplearchitecture:stored`. */
const internalPrefix = 'simplearchitecture:';

/** The relationship's own custom metadata keys: what its form shows as custom rows. */
function customKeys(subject: LabelSubject): string[] {
  const own = ownFieldKeys(subject.type);
  return Object.keys(subject.metadata).filter(
    (key) => key !== 'type' && !own.has(key) && !key.startsWith(internalPrefix),
  );
}

/** How names are compared: ignoring case, and runs of spaces count as one. */
const nameKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** A value as one line of text, or undefined when it has none (lists and objects have none). */
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
): { known: boolean; value?: string } {
  const wanted = nameKey(name);
  for (const key of fieldKeys(subject.type)) {
    if (nameKey(standardProperties[key].label) !== wanted) continue;
    const value =
      key === 'architectureState' ? subject.architectureState : textOf(subject.metadata[key]);
    return value === undefined ? { known: true } : { known: true, value };
  }
  const keys = customKeys(subject);
  // An exact match first, so `Owner` and `owner` can both be read.
  const key = keys.includes(name.trim())
    ? name.trim()
    : keys.find(
        (candidate) =>
          nameKey(candidate) === wanted ||
          (isStandardPropertyKey(candidate) &&
            nameKey(standardProperties[candidate].label) === wanted),
      );
  if (key !== undefined) {
    const value = textOf(subject.metadata[key]);
    return value === undefined ? { known: true } : { known: true, value };
  }
  return { known: names.some((other) => nameKey(other) === wanted) };
}

/** A piece of the filled-in label: text, or `null` for a property with no value. */
type Piece = string | null;

/**
 * Fills in a label: `{Name}` becomes the value of the property with that name, as the form shows it
 * (Identity, Identity Context, Request Data, Response Data, Architecture state, Description) or a
 * custom metadata name, ignoring case. A standard key kept as custom metadata (Request Data on a
 * Contains) answers to its standard name too. A property with no value gives nothing, and the spaces around it close up. A name
 * the relationship can't have stays as typed and is listed in `unknown`. `{{` and `}}` give literal
 * braces. `names` are custom metadata names other relationships in the model use: this one has no
 * value for them, so they give nothing rather than staying as typed.
 */
export function fillLabel(
  label: string,
  subject: LabelSubject,
  names: readonly string[] = [],
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
      const found = lookUp(name, subject, names);
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
  const { text } = fillLabel(label, relationship, names);
  return text === '' ? undefined : text;
}

/**
 * The names a relationship's label can use, for suggesting: its standard fields in the form's order,
 * then its own custom metadata names and those in `names`, once each, ignoring case.
 */
export function labelPropertyNames(subject: LabelSubject, names: readonly string[] = []): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    const key = nameKey(name);
    if (key === '' || /[{}]/.test(name) || seen.has(key)) return;
    seen.add(key);
    result.push(name);
  };
  for (const key of fieldKeys(subject.type)) add(standardProperties[key].label);
  for (const key of customKeys(subject)) add(key);
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

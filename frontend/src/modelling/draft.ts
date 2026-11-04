import {
  customMetadata,
  isNodeType,
  isStandardPropertyOf,
  keptAsCustomOnTypeChange,
  nodeTypeDefinitions,
  nodeTypeKey,
  normaliseForSearch,
  standardProperties,
  type ElementFieldIssue,
  type JgfNode,
  type ModelElement,
  type ModelGraph,
  type NodeType,
  type StandardPropertyKey,
  type UpdateElementRequest,
} from '@simplearchitecture/shared';

/**
 * The editing form's draft of one element, and how it becomes a PATCH.
 * Pure functions, so the rules are tested without the form.
 */

/** A standard property with its own field: every one but `description`, which has its own. */
export type FieldKey = Exclude<StandardPropertyKey, 'description'>;

export interface CustomRow {
  /** Stable for React keys and error lookup; never sent. */
  id: number;
  key: string;
  /** The value as read (or as moved from a field): sent back unchanged unless `text` changes. */
  original: unknown;
  /** What the value field shows; only used when `editable`. */
  text: string;
  /** Text, numbers and true/false can be edited (as text); lists and objects are kept as is. */
  editable: boolean;
  /** Moved here from a standard field by a type change. */
  wasProperty?: boolean;
}

export interface Draft {
  name: string;
  type: NodeType;
  description: string;
  /** The current type's standard fields, as typed (functions: one per line). */
  fields: Partial<Record<FieldKey, string>>;
  custom: CustomRow[];
}

let nextRowId = 1;
export const newRowId = (): number => nextRowId++;

const isEditableValue = (value: unknown): boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function fieldText(key: FieldKey, value: unknown): string {
  if (key === 'functions' && Array.isArray(value)) return value.map(asText).join('\n');
  return asText(value);
}

export function customRow(key: string, value: unknown, wasProperty = false): CustomRow {
  return {
    id: newRowId(),
    key,
    original: value,
    text: isEditableValue(value) ? asText(value) : '',
    editable: isEditableValue(value),
    ...(wasProperty ? { wasProperty: true } : {}),
  };
}

/** The values of custom rows: what they stand for, as stored (rows with no key don't count). */
export function customValues(rows: readonly CustomRow[]): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') continue;
    const changed = row.editable && row.text !== asText(row.original);
    values.set(key, changed ? row.text : row.original);
  }
  return values;
}

/** What differs between two sets of values, as a PATCH sends it: `null` removes a key. */
export function metadataChanges(
  before: ReadonlyMap<string, unknown>,
  after: ReadonlyMap<string, unknown>,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of after) {
    if (!before.has(key) || JSON.stringify(before.get(key)) !== JSON.stringify(value)) {
      metadata[key] = value;
    }
  }
  for (const key of before.keys()) if (!after.has(key)) metadata[key] = null;
  return metadata;
}

/**
 * The checks on custom rows before saving: a value needs a key, and a key is used once.
 * `reserved` says why a key can't be used here, if so.
 */
export function customRowErrors(
  rows: readonly CustomRow[],
  reserved: (key: string) => string | undefined,
): Map<string, string> {
  const errors = new Map<string, string>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    const slot = `row:${row.id}`;
    const hasValue = row.editable ? row.text !== '' : true;
    if (key === '') {
      if (hasValue) errors.set(slot, 'Enter a key.');
      continue;
    }
    const problem = seen.has(key) ? 'This key is used twice.' : reserved(key);
    if (problem !== undefined) errors.set(slot, problem);
    seen.add(key);
  }
  return errors;
}

/** The field keys of a type, in metamodel order, with Functions last. */
export function fieldKeys(type: NodeType): FieldKey[] {
  const keys = nodeTypeDefinitions[type].properties.filter(
    (key): key is FieldKey => key !== 'description',
  );
  return [...keys.filter((key) => key !== 'functions'), ...keys.filter((k) => k === 'functions')];
}

/** The draft of a stored element. */
export function draftOf(element: ModelElement): Draft {
  const fields: Partial<Record<FieldKey, string>> = {};
  for (const key of fieldKeys(element.type)) {
    fields[key] = fieldText(key, element.metadata[key]);
  }
  return {
    name: element.name,
    type: element.type,
    description: asText(element.metadata.description),
    fields,
    custom: customMetadata(element).map(([key, value]) => customRow(key, value)),
  };
}

/** A JGF node read from the API as an element of the explorer's graph. */
export function elementOfNode(id: string, node: JgfNode): ModelElement {
  const metadata = node.metadata ?? {};
  const type = metadata[nodeTypeKey];
  return {
    id,
    name: typeof node.label === 'string' ? node.label : '',
    type: isNodeType(type) ? type : 'Other',
    metadata,
  };
}

/**
 * Changes the type: a field the new type doesn't have, with a value, moves to Custom metadata
 * with its key; a custom key that is a field of the new type moves into that field.
 */
export function withType(draft: Draft, type: NodeType): Draft {
  if (type === draft.type) return draft;
  const fields: Partial<Record<FieldKey, string>> = {};
  const custom: CustomRow[] = [];
  for (const row of draft.custom) {
    const key = row.key.trim();
    if (key !== 'description' && isStandardPropertyOf(type, key)) {
      const value = row.editable && row.text !== asText(row.original) ? row.text : row.original;
      fields[key as FieldKey] = fieldText(key as FieldKey, value);
    } else {
      custom.push(row);
    }
  }
  for (const [key, text] of Object.entries(draft.fields) as [FieldKey, string][]) {
    if (isStandardPropertyOf(type, key)) fields[key] = text;
    else if (text.trim() !== '') {
      custom.push(customRow(key, key === 'functions' ? functionList(text) : text, true));
    }
  }
  for (const key of fieldKeys(type)) fields[key] ??= '';
  return { ...draft, type, fields, custom };
}

function functionList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The metadata (without type and description) the draft stands for, normalised as stored. */
function metadataOf(draft: Draft): Map<string, unknown> {
  const metadata = new Map<string, unknown>();
  for (const key of fieldKeys(draft.type)) {
    const text = draft.fields[key] ?? '';
    if (key === 'functions') {
      const list = functionList(text);
      if (list.length > 0) metadata.set(key, list);
    } else {
      const value = key === 'supplierHqCountry' ? text.trim().toUpperCase() : text.trim();
      if (value !== '') metadata.set(key, value);
    }
  }
  for (const [key, value] of customValues(draft.custom)) metadata.set(key, value);
  return metadata;
}

/**
 * What a PATCH sends: only what differs from the draft the form opened with. Values the user
 * didn't touch are left out, so they stay exactly as stored. Undefined when nothing changed.
 */
export function changesOf(
  initial: Draft,
  draft: Draft,
): Omit<UpdateElementRequest, 'version'> | undefined {
  const change: Omit<UpdateElementRequest, 'version'> = {};
  if (draft.name !== initial.name) change.name = draft.name.trim();
  if (draft.type !== initial.type) change.type = draft.type;
  if (draft.description !== initial.description) {
    change.description = draft.description.trim() === '' ? null : draft.description;
  }
  const metadata = metadataChanges(metadataOf(initial), metadataOf(draft));
  if (Object.keys(metadata).length > 0) change.metadata = metadata;
  return Object.keys(change).length > 0 ? change : undefined;
}

/** Where an error shows: 'name', 'type', 'description', `field:<key>`, `row:<id>` or '' (top). */
export type ErrorSlot = string;

/** The checks run on Save before anything is sent. */
export function clientErrors(draft: Draft): Map<ErrorSlot, string> {
  const errors = new Map<ErrorSlot, string>();
  if (draft.name.trim() === '') errors.set('name', 'Enter a name.');
  for (const key of fieldKeys(draft.type)) {
    const definition = standardProperties[key].value;
    const value = (draft.fields[key] ?? '').trim();
    if (
      definition.kind === 'choice' &&
      value !== '' &&
      !(definition.options as readonly string[]).includes(value)
    ) {
      errors.set(`field:${key}`, `Pick one of ${definition.options.join(', ')}.`);
    }
  }
  const rows = customRowErrors(draft.custom, (key) => {
    if (key === nodeTypeKey) return '“type” is reserved.';
    return isStandardPropertyOf(draft.type, key)
      ? `“${key}” is a property of ${draft.type}. Use its field above.`
      : undefined;
  });
  for (const [slot, message] of rows) errors.set(slot, message);
  return errors;
}

/** Puts the server's 422 messages at their fields; the rest go to the top. */
export function serverErrors(
  draft: Draft,
  issues: readonly ElementFieldIssue[],
): Map<ErrorSlot, string> {
  const errors = new Map<ErrorSlot, string>();
  const add = (slot: ErrorSlot, message: string) => {
    const before = errors.get(slot);
    errors.set(slot, before === undefined ? message : `${before}\n${message}`);
  };
  for (const { field, message } of issues) {
    if (field === 'name' || field === 'type' || field === 'description') {
      add(field, message);
      continue;
    }
    const key = field.startsWith('metadata.') ? field.slice('metadata.'.length) : undefined;
    if (key !== undefined && key !== 'description' && isStandardPropertyOf(draft.type, key)) {
      add(`field:${key}`, message);
      continue;
    }
    if (key === 'description') {
      add('description', message);
      continue;
    }
    const row = key === undefined ? undefined : draft.custom.find((r) => r.key.trim() === key);
    add(row ? `row:${row.id}` : '', message);
  }
  return errors;
}

/** "A, B or C". */
function orList(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1] ?? ''}`;
}

/** The note under Type after a type change, before saving; undefined when none. */
export function typeChangeNote(
  initial: Draft,
  base: ModelElement,
  type: NodeType,
): string | undefined {
  if (type === initial.type) return undefined;
  const withValues = Object.fromEntries(
    Object.entries(base.metadata).filter(([, value]) => asText(value).trim() !== ''),
  );
  const kept = keptAsCustomOnTypeChange(withValues, initial.type, type).map(
    (key) => standardProperties[key].label,
  );
  const now = customMetadata(base)
    .map(([key]) => key)
    .filter((key) => key !== 'description' && isStandardPropertyOf(type, key))
    .map((key) => standardProperties[key as FieldKey].label);
  const parts: string[] = [];
  if (kept.length > 0) {
    parts.push(
      `${type} doesn't have ${orList(kept)}. ${kept.length === 1 ? 'Its value is' : 'Their values are'} kept as custom metadata.`,
    );
  }
  if (now.length > 0) {
    parts.push(
      `${orList(now).replace(' or ', ' and ')} ${now.length === 1 ? 'is' : 'are'} now a property.`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/** How many other elements of the type have this name, trimmed and ignoring case. */
export function sameNameCount(
  graph: ModelGraph,
  type: NodeType,
  name: string,
  exceptId?: string,
): number {
  const needle = normaliseForSearch(name.trim());
  if (needle === '') return 0;
  let count = 0;
  for (const element of graph.elements.values()) {
    if (element.id !== exceptId && element.type === type) {
      if (normaliseForSearch(element.name.trim()) === needle) count++;
    }
  }
  return count;
}

const plural: Record<NodeType, string> = {
  Stakeholder: 'Stakeholders',
  Business: 'Businesses',
  Application: 'Applications',
  Infrastructure: 'Infrastructures',
  Other: 'Others',
};

export function sameNameNote(count: number, type: NodeType, name: string): string | undefined {
  if (count === 0) return undefined;
  const shown = name.trim();
  return count === 1
    ? `Another ${type} is called “${shown}”.`
    : `${count} other ${plural[type]} are called “${shown}”.`;
}

/**
 * One cell of the catalog: the name or a standard property. A cell is the panel's
 * draft with one field typed, so it sends, checks and normalises exactly as the panel does.
 */
export type CellKey = 'name' | StandardPropertyKey;

function withCell(draft: Draft, key: CellKey, text: string): Draft {
  if (key === 'name') return { ...draft, name: text };
  if (key === 'description') return { ...draft, description: text };
  return { ...draft, fields: { ...draft.fields, [key]: text } };
}

/** The text a cell's editor starts with, as the panel's field shows it (Functions: one a line). */
export function cellText(element: ModelElement, key: CellKey): string {
  const draft = draftOf(element);
  if (key === 'name') return draft.name;
  if (key === 'description') return draft.description;
  return draft.fields[key] ?? '';
}

/**
 * What a PATCH sends for one cell (without the version): only that field, as the panel sends it
 * (trimmed, country upper case, an empty value removed). Undefined when nothing changes, or for a
 * property the element's type doesn't have.
 */
export function cellChange(
  element: ModelElement,
  key: CellKey,
  text: string,
): Omit<UpdateElementRequest, 'version'> | undefined {
  const initial = draftOf(element);
  return changesOf(initial, withCell(initial, key, text));
}

/** The panel's check before saving, for this cell only (an empty name, an unknown choice). */
export function cellError(element: ModelElement, key: CellKey, text: string): string | undefined {
  const draft = withCell(draftOf(element), key, text);
  return clientErrors(draft).get(key === 'name' ? 'name' : `field:${key}`);
}

/**
 * The server's 422 messages for a cell: those at its field first, then any others (a cell has
 * nowhere else to show them, and none may be lost).
 */
export function cellServerErrors(key: CellKey, issues: readonly ElementFieldIssue[]): string[] {
  const field = key === 'name' || key === 'description' ? key : `metadata.${key}`;
  const own = issues.filter((issue) => issue.field === field).map((issue) => issue.message);
  const rest = issues.filter((issue) => issue.field !== field).map((issue) => issue.message);
  return [...own, ...rest];
}

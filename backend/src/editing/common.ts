import { isDeepStrictEqual } from 'node:util';
import {
  editingUnavailableMessage,
  elementConflictMessage,
  nodeTypeKey,
  storedModelKey,
  type ElementFieldIssue,
  type JgfDocument,
  type JgfValidationResult,
  type ModelAuthor,
} from '@simplearchitecture/shared';
import { z } from 'zod';
import { maxEchoLength, reservedKey } from '../jgf/validate.js';
import { maxMetadataKeyLength } from '../limits.js';
import type {
  ElementAuditAction,
  ElementWrite,
  PlannedElementChange,
} from '../storage/model-store.js';

/**
 * What the element and relationship editing services share: the errors the routes translate, the
 * input parsing and the plan handed to the store. Messages are user-safe and fixed.
 */

/** Editing needs PostgreSQL; the file store is read-only for editing. User-safe message. */
export class EditingUnavailableError extends Error {
  override name = 'EditingUnavailableError';
  constructor() {
    super(editingUnavailableMessage);
  }
}

export type Missing = 'model' | 'element' | 'relationship' | 'source' | 'target' | 'view';

const missingMessages: Record<Missing, string> = {
  model: 'Model not found',
  element: 'Element not found',
  relationship: 'Relationship not found',
  source: 'The source element is not in the model',
  target: 'The target element is not in the model',
  view: 'View not found',
};

/** There is no such model, or no such element or relationship in it. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
  constructor(readonly what: Missing) {
    super(missingMessages[what]);
  }
}

/** The version sent isn't the current one. Nothing was stored. */
export class ConflictError extends Error {
  override name = 'ConflictError';
  constructor(
    readonly currentVersion: number,
    message: string = elementConflictMessage,
  ) {
    super(message);
  }
}

export const rejectedMessage = 'The change is not valid. Nothing was saved.';

/**
 * The input or the resulting model has errors. Nothing was stored. `duplicateOf`: the existing
 * relationship a new one would repeat.
 */
export class RejectedError extends Error {
  override name = 'RejectedError';
  constructor(
    readonly fields: ElementFieldIssue[],
    readonly duplicateOf?: string,
  ) {
    super(rejectedMessage);
  }
}

/** Nothing would change: the result is returned as it is, and nothing is stored or audited. */
export class Unchanged<T> extends Error {
  constructor(readonly result: T) {
    super('unchanged');
  }
}

const versionMessage = 'Send the version you read (a whole number).';
export const versionSchema = z
  .number({ error: versionMessage })
  .int({ error: versionMessage })
  .min(1, { error: versionMessage });

/** The DELETE query: `?version=N`. */
export const deleteSchema = z.strictObject({
  version: z.coerce.number({ error: versionMessage }).pipe(versionSchema),
});

export type Entries = Record<string, unknown>;

/** What the server keeps for itself in metadata, e.g. `simplearchitecture:stored`. */
const internalPrefix = storedModelKey.slice(0, storedModelKey.indexOf(':') + 1);

/** Why a metadata key can't be used on an element or a relationship, or undefined. */
export function keyProblem(key: string): string | undefined {
  if (key.trim() === '') return 'Enter a name for the property.';
  if (key.length > maxMetadataKeyLength) {
    return `The property name must be at most ${maxMetadataKeyLength} characters.`;
  }
  if (key === nodeTypeKey || key === reservedKey || key.startsWith(internalPrefix)) {
    return 'This property name is reserved. Use another name.';
  }
  return undefined;
}

/** Own keys named `__proto__` would replace a prototype; refuse them before anything else. */
function reservedKeyIssues(input: unknown): ElementFieldIssue[] {
  if (typeof input !== 'object' || input === null) return [];
  const value = (input as Entries).metadata;
  return typeof value === 'object' && value !== null && Object.hasOwn(value, reservedKey)
    ? [{ field: `metadata.${reservedKey}`, message: 'This property name is reserved.' }]
    : [];
}

/** Parses a request, or throws RejectedError with one message per field. `noun`: "an element". */
export function parse<T>(schema: z.ZodType<T>, input: unknown, noun: string): T {
  const reserved = reservedKeyIssues(input);
  if (reserved.length > 0) throw new RejectedError(reserved);
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.flatMap((issue): ElementFieldIssue[] => {
    // A list value's own index isn't a field of the form.
    const path = issue.path.slice(0, 2).map(String).join('.');
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        field: path === '' ? key : `${path}.${key}`,
        message: `Is not a field of ${noun}.`,
      }));
    }
    if (issue.path.length === 0 && issue.code === 'invalid_type') {
      return [{ field: '', message: `Send ${noun.replace(/^an? /, 'the ')} as a JSON object.` }];
    }
    return [{ field: path, message: issue.message }];
  });
  throw new RejectedError(fields);
}

export function isEntries(value: unknown): value is Entries {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Key order doesn't count: PostgreSQL (jsonb) doesn't keep it inside an object.
export function sameValue(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

/** How the validation names a node or edge (ids are cut short in issues). */
export function issueId(id: string): string {
  return id.length > maxEchoLength ? `${id.slice(0, maxEchoLength)}…` : id;
}

function capitalised(text: string): string {
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?)]$/.test(sentence) ? sentence : `${sentence}.`;
}

/**
 * Refuses a change that gives the model an error. Errors about the subject (a node or edge) are
 * named by the request's field (`requestField`); any other error gets field ''.
 */
export function refuseErrors(
  validation: JgfValidationResult,
  subject: { kind: 'node' | 'edge'; id: string },
  requestField: (field: string) => string,
): void {
  if (validation.valid) return;
  const id = issueId(subject.id);
  const fields = validation.errors.map((issue): ElementFieldIssue => {
    const own = subject.kind === 'node' ? issue.nodeId === id : issue.edgeId === id;
    if (!own) return { field: '', message: issue.message };
    const name = subject.kind === 'node' ? 'Node' : 'Edge';
    const prefix = `${name} "${id}": ${issue.field === '' ? '' : `${issue.field} `}`;
    const problem = issue.message.startsWith(prefix)
      ? issue.message.slice(prefix.length)
      : issue.message;
    return { field: requestField(issue.field), message: capitalised(problem) };
  });
  throw new RejectedError(fields.length > 0 ? fields : [{ field: '', message: rejectedMessage }]);
}

/** Sets or removes one metadata value; records the field when it changes. */
export function apply(
  metadata: Entries,
  key: string,
  value: unknown,
  field: string,
  changed: string[],
): void {
  if (value === null) {
    if (Object.hasOwn(metadata, key)) {
      Reflect.deleteProperty(metadata, key);
      changed.push(field);
    }
  } else if (!Object.hasOwn(metadata, key) || !sameValue(metadata[key], value)) {
    metadata[key] = value;
    changed.push(field);
  }
}

/** The change handed to the store, with its audit row (field names only). */
export function plan(
  write: ElementWrite,
  document: JgfDocument,
  action: ElementAuditAction,
  actor: ModelAuthor,
  fields: string[],
): PlannedElementChange {
  return { write, document, audit: { action, actor: { id: actor.id, name: actor.name }, fields } };
}

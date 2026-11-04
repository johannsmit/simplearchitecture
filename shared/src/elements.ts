import type { ApiError } from './api.js';
import type { JgfNode, ValidationIssue } from './jgf.js';
import type { NodeType } from './metamodel.js';

/**
 * Editing one element of a stored model (Modelling). Editing needs PostgreSQL: without a database
 * the routes answer 501 with `editingUnavailableMessage`, and `GET /api/models` says
 * `editable: false`.
 */

export const editingUnavailableMessage =
  'Modelling is read-only without a database. Ask an Admin to set up PostgreSQL.';
export const elementConflictMessage =
  'Someone else changed this element after you opened it. Reload it to see their change. Nothing was saved.';

/** Body of `POST /api/models/:id/elements`. The server chooses the id. */
export interface NewElementRequest {
  type: NodeType;
  /** Trimmed; must not be empty. */
  name: string;
  description?: string;
  /** Standard properties and custom metadata, keyed as stored (see `ElementMetadataValue`). */
  metadata?: Record<string, ElementMetadataValue>;
}

/**
 * A value in `metadata`. A key is a standard property when it is one of the element type's
 * (`isStandardPropertyOf`): text, or a list of text for `functions`. Any other key is custom
 * metadata: text. A custom list or object read from the model may be sent back unchanged; any
 * other change to it is refused. `type` and `description` have their own fields.
 */
export type ElementMetadataValue = unknown;

/**
 * Body of `PATCH /api/models/:id/elements/:elementId`. Only the fields sent change. In
 * `description` and `metadata`, `null` removes a value; keys not sent stay as they
 * are. Renaming a custom key is removing the old one and adding the new one. The element must have
 * a name afterwards, even if it had none before.
 *
 * Changing `type` keeps every value: standard properties the new type doesn't have become custom
 * metadata (see `keptAsCustomOnTypeChange`).
 */
export interface UpdateElementRequest {
  /** The element's version as read (`StoredElement.version`). An older one gets 409. */
  version: number;
  name?: string;
  type?: NodeType;
  description?: string | null;
  /** `null` removes the key. */
  metadata?: Record<string, ElementMetadataValue>;
}

/** One element as stored, with its version for the next update or delete. */
export interface StoredElement {
  id: string;
  /** Starts at 1 and goes up by one with every change. */
  version: number;
  /** The JGF node: `label` is the name, `metadata` holds the type and every property. */
  node: JgfNode;
}

/**
 * Response body of `GET` (200), `POST` (201) and `PATCH` (200) on an element. `warnings` are the
 * model's validation warnings about this element (they never stop a change).
 */
export interface ElementChangeResult {
  element: StoredElement;
  warnings: ValidationIssue[];
}

/**
 * Response body (200) of `DELETE /api/models/:id/elements/:elementId?version=N`. Every
 * relationship from or to the element is deleted with it (contained elements stay, un-nested).
 */
export interface DeletedElementResult {
  id: string;
  deletedRelationshipCount: number;
  /** Ids of the deleted relationships that have one (JGF edge ids are optional). */
  deletedRelationshipIds: string[];
  /** Elements that were drawn inside the deleted one and now aren't nested at all. */
  unnestedElementIds: string[];
}

/** Response body (404): which one is missing, so a form can say the element was deleted. */
export interface ElementNotFound extends ApiError {
  missing: 'model' | 'element';
}

/** Query of the delete route, as sent. */
export interface DeleteElementRequest {
  version: number;
}

/**
 * One problem with a change, at the field of the request it is about: `name`, `type`,
 * `description`, `metadata.<key>`, `metadata`, `version`, or '' (no field: a general message).
 */
export interface ElementFieldIssue {
  field: string;
  message: string;
}

/** Response body (422) when a change is refused. Nothing was stored. */
export interface ElementRejected extends ApiError {
  fields: ElementFieldIssue[];
}

/** Response body (409) when the version sent is not the element's current one. */
export interface ElementConflict extends ApiError {
  currentVersion: number;
}

import type { ApiError } from './api.js';
import type { ElementFieldIssue, ElementRejected } from './elements.js';
import type { JgfEdge, ValidationIssue } from './jgf.js';
import type { ArchitectureState, EdgeType } from './metamodel.js';

/**
 * Editing one relationship (JGF edge) of a stored model (Modelling). Like elements, this needs
 * PostgreSQL: without a database the routes answer 501 with `editingUnavailableMessage`.
 *
 * Only relationships with an id can be addressed (JGF edge ids are optional; an imported edge
 * without one is read-only). Rules for changes made in Modelling (stored models are
 * never checked against them):
 * - an element can't be related to itself (any type), and a Contains change may not create a
 *   cycle (`relationshipProblems`);
 * - a second container is allowed, with a `multiple-containers` warning;
 * - the same Contains twice is refused, with `duplicateOf` in the 422 body. Several Relations may
 *   link the same two elements.
 */

export const relationshipConflictMessage =
  'Someone else changed this relationship after you opened it. Reload it to see their change. Nothing was saved.';

/** Body of `POST /api/models/:id/relationships`. The server chooses the id. */
export interface NewRelationshipRequest {
  /** Element ids; both must be in the model. */
  source: string;
  target: string;
  type: EdgeType;
  /** Stored on the edge as `metadata.architectureState`. Default: Current. */
  architectureState?: ArchitectureState;
  /** Stored as `metadata.description`. */
  description?: string;
}

/**
 * Body of `PATCH /api/models/:id/relationships/:relationshipId`. Only the fields sent change;
 * `description: null` and `label: null` (or a blank label) remove them. `reverse: true` swaps source and target (same id and
 * history); it can be sent with other changes.
 */
export interface UpdateRelationshipRequest {
  /** The relationship's version as read (`StoredRelationship.version`). An older one gets 409. */
  version: number;
  type?: EdgeType;
  architectureState?: ArchitectureState;
  description?: string | null;
  /** The line's text on the canvas, stored as JGF `label`. Trimmed. */
  label?: string | null;
  reverse?: boolean;
  /**
   * Both ways (stored as JGF `"directed": false`) or one way. Only a Relation can be
   * two-way; a change to Contains makes the relationship one-way.
   */
  twoWay?: boolean;
  /**
   * Relation only: free text stored as `metadata.identity`, `metadata.identityContext` and
   * `metadata.data`, trimmed. `null` or a blank removes it, and a change to Contains removes them.
   */
  identity?: string | null;
  identityContext?: string | null;
  data?: string | null;
  /**
   * Custom metadata: text. `null` removes a key, and keys not sent stay as they are. A custom list
   * or object read from the model may be sent back unchanged. Architecture state, description,
   * Identity, Identity Context and Data have their own fields.
   */
  metadata?: Record<string, unknown>;
}

/** Query of the delete route, as sent. */
export interface DeleteRelationshipRequest {
  version: number;
}

/** One relationship as stored, with its version for the next update or delete. */
export interface StoredRelationship {
  id: string;
  /** Starts at 1 and goes up by one with every change. */
  version: number;
  /** The JGF edge: `relation` is the type, `metadata` holds the Architecture state and the rest. */
  edge: JgfEdge & { id: string };
}

/** An element whose container changed: it is now drawn inside `containerId`, or (null) not nested. */
export interface NestingChange {
  elementId: string;
  containerId: string | null;
}

/**
 * Response body of `GET` (200), `POST` (201) and `PATCH` (200) on a relationship. `warnings` are
 * the model's validation warnings about this relationship and, for Contains, about its target
 * having several containers (they never stop a change). `nestingChanges` lists every element
 * drawn inside another container than before (always empty for `GET`).
 */
export interface RelationshipChangeResult {
  relationship: StoredRelationship;
  warnings: ValidationIssue[];
  nestingChanges: NestingChange[];
}

/** Response body (200) of `DELETE /api/models/:id/relationships/:relationshipId?version=N`. */
export interface DeletedRelationshipResult {
  id: string;
  nestingChanges: NestingChange[];
}

/**
 * Response body (404): which one is missing. `source` or `target`: an end of a new relationship
 * isn't (or is no longer) an element of the model.
 */
export interface RelationshipNotFound extends ApiError {
  missing: 'model' | 'relationship' | 'source' | 'target';
}

/**
 * One problem with a change: `source`, `target`, `type`, `architectureState`, `description`,
 * `label`, `version`, `reverse`, `identity`, `identityContext`, `data`, or '' (a general message).
 */
export type RelationshipFieldIssue = ElementFieldIssue;

/**
 * Response body (422) when a change is refused. Nothing was stored. `duplicateOf` is the id of
 * the existing Contains with the same source and target (`edges[3]` when it has no id, as in
 * `ModelRelationship.id`).
 */
export interface RelationshipRejected extends ElementRejected {
  duplicateOf?: string;
}

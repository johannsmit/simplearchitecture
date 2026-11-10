import type {
  JgfDocument,
  JgfEdge,
  JgfNode,
  JgfValidationResult,
  ModelAuthor,
  ModelSummary,
  ViewCardLayout,
  ViewLineRoute,
  ViewSummary,
} from '@simplearchitecture/shared';

/**
 * Where models live: JGF files (FileModelStore) or PostgreSQL (PostgresModelStore). The routes
 * use only this interface. Methods never trust their input: an id that isn't a model id is simply
 * not found.
 */
export interface ModelStore {
  /**
   * Summaries of every readable, valid model, newest first. Unreadable or damaged models are left
   * out (and logged).
   */
  list(): Promise<ModelSummary[]>;
  /**
   * Ids of the model files that can't be read or are damaged (left out of `list`), sorted. For
   * Admins, so they can delete them: never any content.
   */
  listDamaged(): Promise<string[]>;
  /** The stored model, or undefined when there is none. Throws ModelUnreadableError. */
  get(id: string): Promise<JgfDocument | undefined>;
  /**
   * Stores a validated model under a new id. The server-owned data (id, name, creation, counts)
   * replaces anything the document says about them; the document's own `graph.id` is kept as
   * `sourceId`. Throws ModelStoreFullError, ModelTooLargeError or ModelNotStorableError.
   */
  save(document: JgfDocument, createdBy: ModelAuthor): Promise<ModelSummary>;
  /**
   * Removes a model, or an entry with a model's name that isn't a model file. Undefined when there
   * is none. Throws ModelNotDeletableError when such an entry can't be removed.
   */
  delete(id: string): Promise<DeletedModel | undefined>;
  /**
   * Element and relationship editing (Modelling). Absent when the store can't edit (the file
   * store): editing needs PostgreSQL. The editing services hold the rules; the store only reads
   * and writes.
   */
  readonly elements?: ElementStore;
  /**
   * Views of a model. Absent when the store can't hold them (the file store): views need
   * PostgreSQL. The view service holds the rules; the store only reads and writes.
   */
  readonly views?: ViewStore;
}

/** The model as stored now, read under the model's lock, and fully validated. */
export interface EditableModel {
  document: JgfDocument;
  validation: JgfValidationResult;
  /** The element's version, or undefined when the model has no such element. */
  versionOf(elementId: string): number | undefined;
  /** The relationship's version, or undefined when the model has no relationship with this id. */
  relationshipVersionOf(relationshipId: string): number | undefined;
}

/**
 * One element written (added or replaced) or deleted with every relationship from or to it; or
 * one relationship (by id) written (added last, or replaced in place) or deleted. A relationship
 * whose ends moved (`endsIntoViews`) stays in every view that holds it: each of those views gets
 * the ends it lacks, without a position, in the same transaction (ViewFullError when one has no
 * room). A relationship written with other ends than before (a new end, or reversed) loses the
 * route its line was given in every view. A view that gains an end or loses a route gets a new
 * version, as for any other change to it.
 */
export type ElementWrite =
  | { kind: 'put'; elementId: string; node: JgfNode }
  | { kind: 'delete'; elementId: string }
  | { kind: 'put-relationship'; relationshipId: string; edge: JgfEdge; endsIntoViews?: boolean }
  | { kind: 'delete-relationship'; relationshipId: string };

export type ElementAuditAction =
  | 'element-added'
  | 'element-updated'
  | 'element-deleted'
  | 'relationship-added'
  | 'relationship-updated'
  | 'relationship-reversed'
  | 'relationship-deleted';

/** The change a plan asks for: already checked and validated by the editing service. */
export interface PlannedElementChange {
  write: ElementWrite;
  /** The whole model after the change (for the size and storable checks). */
  document: JgfDocument;
  audit: {
    action: ElementAuditAction;
    actor: ModelAuthor;
    /** Names of the changed fields, never their values. */
    fields: string[];
  };
}

export interface AppliedElementChange {
  /** The new version of the element or relationship written; undefined after a delete. */
  version: number | undefined;
  /** The relationships deleted with the element, in model order (`id` null when it has none). */
  deletedRelationships: { id: string | null }[];
  /**
   * The views a relationship's new end was added to (`endsIntoViews`), or whose route for it was
   * dropped, with their new versions.
   */
  viewsChanged?: { id: string; version: number }[];
}

export interface ElementStore {
  /** The model and its element versions, read consistently. Undefined when there is no model. */
  read(modelId: string): Promise<EditableModel | undefined>;
  /**
   * Runs `plan` on the model as stored, in one transaction that holds the model's row lock, and
   * applies the change it returns together with one audit row. `plan` refuses a change by
   * throwing: then nothing is stored. Undefined when there is no such model. Throws
   * ModelUnreadableError for a damaged model, ModelTooLargeError and ModelNotStorableError.
   */
  change(
    modelId: string,
    plan: (model: EditableModel) => PlannedElementChange,
  ): Promise<AppliedElementChange | undefined>;
}

/**
 * A view as stored: its summary and contents, element and relationship ids in model order, the
 * layout of its cards that have a position, and the routes of its lines that have one (both in
 * model order too).
 */
export interface ViewRecord {
  summary: ViewSummary;
  elementIds: string[];
  relationshipIds: string[];
  layout: ViewCardLayout[];
  routes: ViewLineRoute[];
}

/** The two ends of a relationship as stored (null when the edge has none). */
export interface RelationshipEnds {
  source: string | null;
  target: string | null;
}

/** What a view change's plan sees, read under the model's row lock. */
export interface ViewChangeState {
  /** The view the change is about, or undefined (a new view, or no such view in the model). */
  view: ViewRecord | undefined;
  /** Every view of the model, by id and name (for the count and the name rules). */
  views: readonly { id: string; name: string }[];
  /** Of the element ids asked about, those that are elements of the model. */
  elements: ReadonlySet<string>;
  /**
   * Of the relationship ids asked about and those in the view, the model's relationships with
   * their ends.
   */
  relationships: ReadonlyMap<string, RelationshipEnds>;
}

/**
 * One view created, renamed, given new contents or a new layout, or deleted. Ids are already
 * checked.
 */
export type ViewWrite =
  | {
      kind: 'create';
      viewId: string;
      name: string;
      elementIds: readonly string[];
      relationshipIds: readonly string[];
    }
  | { kind: 'rename'; viewId: string; name: string }
  | {
      kind: 'layout';
      viewId: string;
      cards: readonly ViewCardLayout[];
      routes: readonly ViewLineRoute[];
    }
  | {
      kind: 'replace';
      viewId: string;
      elementIds: readonly string[];
      relationshipIds: readonly string[];
    }
  | { kind: 'delete'; viewId: string };

export type ViewAuditAction = 'view-added' | 'view-renamed' | 'view-changed' | 'view-deleted';

/** The change a view plan asks for, with its audit row (field names only, never values). */
export interface PlannedViewChange {
  write: ViewWrite;
  audit: { action: ViewAuditAction; actor: ModelAuthor; fields: string[] };
}

/** The ids a view change needs to know about: the view, and the ids the request names. */
export interface ViewLookup {
  viewId?: string;
  elementIds: readonly string[];
  relationshipIds: readonly string[];
}

export interface ViewStore {
  /** The model's views, in no particular order. Undefined when there is no such model. */
  list(modelId: string): Promise<ViewSummary[] | undefined>;
  /** One view with its contents, or which of the two is missing. */
  get(modelId: string, viewId: string): Promise<ViewRecord | 'no-model' | 'no-view'>;
  /**
   * Runs `plan` on what `lookup` asks for, in one transaction that holds the model's row lock, and
   * applies the change it returns together with one audit row. `plan` refuses a change by
   * throwing: then nothing is stored. Undefined when there is no such model; otherwise the view as
   * it now is (undefined after a delete).
   */
  change(
    modelId: string,
    lookup: ViewLookup,
    plan: (state: ViewChangeState) => PlannedViewChange,
  ): Promise<{ view: ViewRecord | undefined } | undefined>;
}

export interface DeletedModel {
  id: string;
  /** Undefined when the model was unreadable (it is deleted all the same). */
  summary: ModelSummary | undefined;
}

// Ids are lower-case version 4 UUIDs (crypto.randomUUID). Nothing else ever reaches a file path.
const modelIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isModelId(id: string): boolean {
  return modelIdPattern.test(id);
}

/** The store already holds the most models it may. The message is user-safe. */
export class ModelStoreFullError extends Error {
  override name = 'ModelStoreFullError';
  constructor(readonly maxModels: number) {
    super(`The model store is full (${maxModels} models). Delete a model before saving another.`);
  }
}

export const modelUnreadableMessage =
  'The stored model could not be read. Its file may be damaged; see the API log.';
export const modelDamagedMessage =
  "The stored model is damaged: it doesn't pass validation, so it can't be shown. See the API log.";

/**
 * A stored model exists but can't be read, or is damaged (`invalid`: it reads, but fails the JGF
 * and metamodel validation). The message is user-safe.
 */
export class ModelUnreadableError extends Error {
  override name = 'ModelUnreadableError';
  constructor(
    readonly id: string,
    readonly invalid = false,
  ) {
    super(invalid ? modelDamagedMessage : modelUnreadableMessage);
  }
}

/** The model is too large to store (its file would be over the read limit). User-safe message. */
export class ModelTooLargeError extends Error {
  override name = 'ModelTooLargeError';
  constructor(readonly maxBytes: number) {
    super(`The model is too large to store (more than ${maxBytes} bytes).`);
  }
}

/**
 * A relationship's new end can't go into a view that holds it: the view has the most elements it
 * may. Nothing was stored. The message is user-safe.
 */
export class ViewFullError extends Error {
  override name = 'ViewFullError';
  constructor(readonly maxElements: number) {
    super(
      `This relationship is in a view that already has ${maxElements} elements, the most it may have, so its new end can't be added to it. Remove a card from that view first.`,
    );
  }
}

/**
 * The model holds text PostgreSQL can't store: a NUL character or half of a surrogate pair (a
 * broken Unicode character). The message is user-safe.
 */
export class ModelNotStorableError extends Error {
  override name = 'ModelNotStorableError';
  constructor() {
    super(
      "The model contains text that can't be stored (a NUL character or a broken Unicode character). Remove it and try again.",
    );
  }
}

/**
 * The entry for this id isn't a model file (e.g. a non-empty folder someone put in DATA_DIR) and
 * couldn't be removed. The message is user-safe.
 */
export class ModelNotDeletableError extends Error {
  override name = 'ModelNotDeletableError';
  constructor(readonly id: string) {
    super(
      'This entry in the model store is not a model file and could not be deleted. Remove it on the server.',
    );
  }
}

/** The store can't be used (e.g. DATA_DIR is not a writable directory). For startup only. */
export class ModelStoreError extends Error {
  override name = 'ModelStoreError';
}

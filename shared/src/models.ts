import type { ApiError } from './api.js';
import type { JgfValidationResult, OefMappingReport } from './jgf.js';

/**
 * The `graph.metadata` key that holds the server-owned data of a stored model. The server sets
 * it on every save and replaces whatever a client sent under it. The colon keeps it apart from
 * custom metadata keys (the OEF import only creates letters and digits).
 */
export const storedModelKey = 'simplearchitecture:stored';

/** Who saved a model: the provider's user id and the display name at the time. */
export interface ModelAuthor {
  id: string;
  name: string;
}

/** Server-owned data of a stored model. Also stored in the model under `storedModelKey`. */
export interface ModelSummary {
  /** Server-generated UUID; also `graph.id` of the stored model. */
  id: string;
  /** From `graph.label`, trimmed and cut short, or a fallback when there is none. */
  name: string;
  /** ISO 8601, UTC. */
  createdAt: string;
  createdBy: ModelAuthor;
  nodeCount: number;
  edgeCount: number;
  /**
   * The `graph.id` the client sent (e.g. the OEF model identifier), cut short if very long.
   * Absent when there was none. The stored model's own `graph.id` is always `id`.
   */
  sourceId?: string;
}

/** Response body of `GET /api/models`. Newest first. */
export interface ModelListResponse {
  models: ModelSummary[];
  /**
   * Whether elements can be edited (Modelling). False without a database: the file store is
   * read-only for editing.
   */
  editable: boolean;
}

/** A stored model file that can't be read or doesn't pass validation. Only its id is shared. */
export interface DamagedModel {
  id: string;
}

/** Response body of `GET /api/admin/models/damaged` (Admin only). Sorted by id. */
export interface DamagedModelListResponse {
  models: DamagedModel[];
}

/** Response body (201) of `POST /api/models`. Warnings don't stop a save. */
export interface SaveModelResult {
  model: ModelSummary;
  validation: JgfValidationResult;
}

/** Response body (201) of `POST /api/models/import/oef`. */
export interface ImportOefModelResult extends SaveModelResult {
  report: OefMappingReport;
}

/**
 * Longest model name. A new model's name must fit; a longer `graph.label` from an import is cut
 * to it in the model list.
 */
export const maxModelNameLength = 200;

/**
 * Body of `POST /api/models/new` (Admin): a new, empty model. Names don't have to be unique (each
 * model has its own id). A refused name gets 422 with `ElementRejected` (`fields`).
 */
export interface NewModelRequest {
  /** Trimmed; 1 to `maxModelNameLength` characters. */
  name: string;
}

/** Response body (201) of `POST /api/models/new`: the new model as the model list shows it. */
export interface NewModelResult {
  model: ModelSummary;
}

/** Response body (422) when a model has validation errors, so nothing was saved. */
export interface ModelRejected extends ApiError {
  validation: JgfValidationResult;
  /** Set by the OEF import. */
  report?: OefMappingReport;
}

import type { ApiError } from './api.js';
import type { ElementFieldIssue } from './elements.js';
import { defaultNeighbourhoodCap } from './graph.js';
import type { ModelAuthor } from './models.js';

/**
 * Views: a named, stored set of elements and relationships of one model, by id. A view never
 * changes the model. Each card can keep where it was left (its layout), and each line the route it
 * was left on (given by hand, or drawn by Tidy up); a card without a position is placed, and a line without a route is drawn, by
 * the canvas when the view opens. A view can be in one folder (one level of folders): a folder is
 * only a name on its views, so there are no empty folders. Viewer and higher list and open views;
 * Modeller and higher create, rename, change, lay out, put in folders and delete them. Every view
 * is visible to everyone who can see the model. Views need PostgreSQL: without a database the
 * routes answer 501 with `editingUnavailableMessage`.
 *
 * Deleting an element or a relationship from the model removes it from every view, and deleting a
 * model deletes its views. Views aren't part of the JGF export or import.
 */

/**
 * A view's name: trimmed, required, at most this long, and unique within its model, ignoring case
 * (`sameViewName`).
 */
export const maxViewNameLength = 200;
/** Most elements in one view: as many as the canvas draws. */
export const maxViewElements = defaultNeighbourhoodCap;
/**
 * Most relationships in one view: room for every relationship among a full canvas of elements in
 * a densely connected model.
 */
export const maxViewRelationships = 5_000;
/** Most views one model may have. */
export const maxViewsPerModel = 500;
/** A card's width in a view's layout, when set by hand: as on the canvas. */
export const minViewCardWidth = 168;
export const maxViewCardWidth = 480;
/** How far from the canvas's origin a card in a view's layout may be, either way, in pixels. */
export const maxViewCardCoordinate = 1_000_000;
/**
 * Most bends a line's stored route may have (its points are two more: the ends). The points of a
 * route are within `maxViewCardCoordinate` of the canvas's origin, as cards are.
 */
export const maxViewLineBends = 30;

/** The key two view names are compared by: the same key is the same name. */
export function viewNameKey(name: string): string {
  return name.trim().normalize('NFC').toLowerCase();
}

/** Whether two view names count as the same: equal once trimmed, ignoring case. */
export function sameViewName(a: string, b: string): boolean {
  return viewNameKey(a) === viewNameKey(b);
}

/** The message when another view of the model already has the name. */
export function viewNameTakenMessage(existing: string): string {
  return `This model already has a view called “${existing}”. Choose another name.`;
}

/**
 * A folder's name: trimmed, 1 to this many characters, on one line. Folder names are compared as
 * view names are (`sameViewFolder`), and a folder keeps the spelling it has: a view put in
 * "claims" while "Claims" exists goes into "Claims".
 */
export const maxViewFolderLength = 100;

/** The key two folder names are compared by: the same key is the same folder. */
export function viewFolderKey(folder: string): string {
  return viewNameKey(folder);
}

/** Whether two folder names are the same folder: equal once trimmed, ignoring case. */
export function sameViewFolder(a: string, b: string): boolean {
  return viewFolderKey(a) === viewFolderKey(b);
}

/**
 * What is wrong with a folder name as typed, in the words the dialogs and the server use, or null.
 * Empty (or only spaces) is "Enter a name." where a name is required.
 */
export function viewFolderProblem(folder: string): string | null {
  const trimmed = folder.trim();
  if (trimmed === '') return 'Enter a name.';
  if (trimmed.length > maxViewFolderLength) {
    return `The folder name has ${trimmed.length} characters. Use ${maxViewFolderLength} or fewer.`;
  }
  if (/[\r\n]/.test(trimmed)) return "A folder name can't have line breaks.";
  return null;
}

/** The message when another folder of the model already has the name. Folders are never merged. */
export function viewFolderTakenMessage(existing: string): string {
  return `There's already a folder called “${existing}”.`;
}

export const viewConflictMessage =
  'Someone else changed this view after you opened it. Reload it to see their change. Nothing was saved.';

/** One view in a model's list. */
export interface ViewSummary {
  id: string;
  name: string;
  /**
   * The folder the view is in, or null. Putting a view in a folder isn't a change to the view: it
   * leaves `version`, `updatedAt` and `updatedBy` as they are.
   */
  folder: string | null;
  /** Starts at 1 and goes up by one with every rename, change of contents or of layout. */
  version: number;
  elementCount: number;
  relationshipCount: number;
  /** ISO 8601, UTC. */
  createdAt: string;
  createdBy: ModelAuthor;
  /** ISO 8601, UTC: the last rename, change of contents or of layout. */
  updatedAt: string;
  updatedBy: ModelAuthor;
}

/**
 * Where one card of a view was left: its top left corner on the canvas (in canvas pixels, also for
 * a card drawn inside a container) and, when its width was set by hand, that width.
 */
export interface ViewCardLayout {
  elementId: string;
  x: number;
  y: number;
  /** A whole number from `minViewCardWidth` to `maxViewCardWidth`. Absent: the card's own width. */
  width?: number;
}

/** A point on the canvas, in canvas pixels. */
export interface ViewPoint {
  x: number;
  y: number;
}

/**
 * The route a relationship's line in a view was left on (given by hand, or drawn by Tidy up): its
 * points on the canvas, from the end at the source to the end at the target. Each stretch between two points runs straight
 * across or straight up and down (they share x or y), so the line keeps its right angles. From 2
 * points to `maxViewLineBends` + 2.
 */
export interface ViewLineRoute {
  relationshipId: string;
  points: ViewPoint[];
}

/**
 * A view with its contents: element ids and relationship ids, each in the model's order, the
 * layout of those of its cards that have one, and the routes of those of its lines that have one
 * (both in the model's order too).
 */
export interface StoredView extends ViewSummary {
  elementIds: string[];
  relationshipIds: string[];
  layout: ViewCardLayout[];
  routes: ViewLineRoute[];
}

/**
 * Response body of `GET /api/models/:id/views` and of `GET /api/models/:id/elements/:elementId/views`
 * (the views holding that element): by name.
 */
export interface ViewListResponse {
  views: ViewSummary[];
}

/**
 * Response body of `GET /api/models/:id/views/:viewId` (200), `POST /api/models/:id/views` (201),
 * `PUT /api/models/:id/views/:viewId/contents` (200) and `PUT …/layout` (200).
 */
export interface ViewResult {
  view: StoredView;
}

/** Response body (200) of `PATCH /api/models/:id/views/:viewId` (rename). */
export interface RenamedViewResult {
  view: ViewSummary;
}

/**
 * Body of `POST /api/models/:id/views`. The server chooses the id. Ids sent twice count once.
 * Every element and relationship must be in the model, and a relationship only with both of its
 * elements in the view. A relationship without an id can't be in a view.
 */
export interface NewViewRequest {
  name: string;
  /**
   * Absent, null or only spaces: no folder. A folder that matches an existing one goes into that
   * one, with its spelling.
   */
  folder?: string | null;
  elementIds: string[];
  /** Absent: none. */
  relationshipIds?: string[];
}

/** Body of `PATCH /api/models/:id/views/:viewId`: a new name. */
export interface RenameViewRequest {
  /** The view's version as read. An older one gets 409. */
  version: number;
  name: string;
}

/**
 * Body of `PUT /api/models/:id/views/:viewId/contents`: the view's new contents, in place of the
 * old. With `relationshipIds`, exactly those (each with both of its elements in the view). Without
 * it, the view keeps those of its relationships whose two elements are still in it, so removing an
 * element removes its relationships.
 */
export interface ReplaceViewContentsRequest {
  /** The view's version as read. An older one gets 409. */
  version: number;
  elementIds: string[];
  relationshipIds?: string[];
}

/**
 * Body of `PUT /api/models/:id/views/:viewId/layout`: where the view's cards are, and the routes of
 * its lines, in place of the old layout. Each card at most once, and only cards in the view; a
 * card of the view that isn't listed has no position afterwards. The same for routes: each
 * relationship at most once, only relationships in the view, and a line not listed has no route
 * afterwards (it is drawn automatically). The same layout as stored changes nothing (no new
 * version).
 */
export interface ReplaceViewLayoutRequest {
  /** The view's version as read. An older one gets 409. */
  version: number;
  cards: ViewCardLayout[];
  /** Absent: none. */
  routes?: ViewLineRoute[];
}

/**
 * Body of `PUT /api/models/:id/views/:viewId/folder`: puts the view in a folder, or (null) takes it
 * out of its folder. No version: a folder change isn't version-checked. A folder that matches an
 * existing one goes into that one, with its spelling; with `newFolder`, a folder that matches one
 * that exists (the view's own too) is refused (422 on `folder`), so folders are never merged.
 */
export interface MoveViewRequest {
  folder: string | null;
  newFolder?: boolean;
}

/** Response body (200) of `PUT /api/models/:id/views/:viewId/folder`. */
export interface MovedViewResult {
  view: ViewSummary;
}

/**
 * Body of `PATCH /api/models/:id/view-folders`: renames the folder `from` to `to` on every view in
 * it, in one step. 404 (`missing: 'folder'`) when no view is in `from`; 422 on `folder` when `to`
 * matches another folder (never merged). Only a change of case of `from` is allowed.
 */
export interface RenameViewFolderRequest {
  from: string;
  to: string;
}

/** Response body (200) of `PATCH /api/models/:id/view-folders`: the views in it, by name. */
export interface RenamedViewFolderResult {
  folder: string;
  views: ViewSummary[];
}

/** Query of the delete route, as sent: `?version=N`. */
export interface DeleteViewRequest {
  version: number;
}

/** Response body (200) of `DELETE /api/models/:id/views/:viewId?version=N`. */
export interface DeletedViewResult {
  id: string;
}

/** Response body (404): which one is missing. */
export interface ViewNotFound extends ApiError {
  missing: 'model' | 'view' | 'folder';
}

/**
 * Response body (422) when a request is refused. Nothing was stored. `field`: `name`, `folder`,
 * `elementIds`, `relationshipIds`, `cards`, `routes`, `version`, or '' (a general message).
 */
export interface ViewRejected extends ApiError {
  fields: ElementFieldIssue[];
}

/** Response body (409) when the version sent is not the view's current one. */
export interface ViewConflict extends ApiError {
  currentVersion: number;
}

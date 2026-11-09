import {
  isHexColour,
  type ApiError,
  type Branding,
  type LogoMediaType,
} from '@simplearchitecture/shared';
import type {
  AdminConnectedApp,
  AdminConnectedAppList,
  AdminDisconnectResult,
  AgentDecision,
  AgentDecisionResult,
  AgentRequest,
  ConnectedApp,
  ConnectedAppList,
  DamagedModelListResponse,
  DeletedElementResult,
  DeletedRelationshipResult,
  ElementChangeResult,
  NewRelationshipRequest,
  RelationshipChangeResult,
  UpdateRelationshipRequest,
  NewElementRequest,
  UpdateElementRequest,
  DatabaseStatus,
  DatabaseTestResult,
  ImportOefModelResult,
  SaveModelResult,
  JgfDocument,
  ModelListResponse,
  ModelRejected,
  ModelSummary,
  NewModelRequest,
  NewModelResult,
  NewViewRequest,
  RenameViewRequest,
  ReplaceViewContentsRequest,
  ReplaceViewLayoutRequest,
  StoredView,
  ViewCardLayout,
  ViewSummary,
} from '@simplearchitecture/shared';

/**
 * Calls to the API. The session cookie is httpOnly and sent by the browser; nothing here sees or
 * stores a token. Non-GET requests are same-origin fetches, so the browser sends the Origin
 * header the API's CSRF check needs.
 */

/** A failed API call. `status` 0 means the server couldn't be reached. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The parsed error body, when there was one (e.g. a 422 with the validation result). */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<ApiError>).statusCode === 'number' &&
    typeof (value as Partial<ApiError>).message === 'string'
  );
}

type SessionListener = () => void;
const sessionListeners = new Set<SessionListener>();

/** Called when an API call answers 401: the session ended (timed out or signed out elsewhere). */
export function onSessionEnded(listener: SessionListener): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

interface RequestOptions extends RequestInit {
  /** Handle 401 here instead of telling the shell the session ended. */
  ownSessionHandling?: boolean;
}

async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const { ownSessionHandling, ...init } = options;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: 'same-origin', headers });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new ApiRequestError(0, "The server can't be reached.");
  }
  if (response.ok) return response;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (response.status === 401 && ownSessionHandling !== true) {
    for (const listener of sessionListeners) listener();
  }
  const message = isApiError(body) ? body.message : response.statusText || 'Request failed';
  throw new ApiRequestError(response.status, message, body);
}

async function json(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ApiRequestError(response.status, 'The server sent an unreadable answer.');
  }
}

function isModelSummary(value: unknown): value is ModelSummary {
  if (typeof value !== 'object' || value === null) return false;
  const model = value as Partial<Record<keyof ModelSummary, unknown>>;
  return (
    typeof model.id === 'string' &&
    typeof model.name === 'string' &&
    typeof model.createdAt === 'string' &&
    typeof model.nodeCount === 'number' &&
    typeof model.edgeCount === 'number' &&
    typeof model.createdBy === 'object' &&
    model.createdBy !== null &&
    typeof (model.createdBy as { name?: unknown }).name === 'string'
  );
}

/**
 * GET /api/models: every stored model, newest first, and whether elements can be edited (it
 * needs the database). A missing flag counts as not editable.
 */
export async function listModels(signal?: AbortSignal): Promise<ModelListResponse> {
  const body = await json(await request('/api/models', signal ? { signal } : {}));
  const list = body as Partial<ModelListResponse> | null;
  const models = list?.models;
  if (!Array.isArray(models) || !models.every(isModelSummary)) {
    throw new ApiRequestError(200, 'The server sent an unexpected model list.');
  }
  return { models, editable: list?.editable === true };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The shape the explorer relies on: nodes an object of objects, edges a list of objects.
 * The server validates stored models fully; this keeps a broken answer from reaching the page.
 */
function isJgfShape(graph: unknown): boolean {
  if (!isObject(graph)) return false;
  const { nodes, edges } = graph;
  if (nodes !== undefined && !(isObject(nodes) && Object.values(nodes).every(isObject))) {
    return false;
  }
  return edges === undefined || (Array.isArray(edges) && edges.every(isObject));
}

/** GET /api/models/:id: one stored model as JGF. */
export async function getModel(id: string, signal?: AbortSignal): Promise<JgfDocument> {
  const response = await request(`/api/models/${encodeURIComponent(id)}`, signal ? { signal } : {});
  const body = await json(response);
  const graph: unknown = (body as { graph?: unknown } | null)?.graph;
  if (!isJgfShape(graph)) {
    throw new ApiRequestError(200, 'The server sent an unexpected model.');
  }
  return body as JgfDocument;
}

/**
 * POST /api/models/import/oef. Throws ApiRequestError on failure; a 422 carries the
 * `ModelRejected` body (validation result and, for OEF, the report).
 */
export async function importOef(file: Blob): Promise<ImportOefModelResult> {
  const response = await request('/api/models/import/oef', {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: file,
    ownSessionHandling: true,
  });
  const body = await json(response);
  const result = body as Partial<ImportOefModelResult> | null;
  if (!result || !isModelSummary(result.model) || !result.report || !result.validation) {
    throw new ApiRequestError(response.status, 'The server sent an unexpected import result.');
  }
  return result as ImportOefModelResult;
}

/**
 * POST /api/models: a JGF file, such as one saved by Export. Throws ApiRequestError on failure; a
 * 422 carries the `ModelRejected` body.
 */
export async function importJgf(file: Blob): Promise<SaveModelResult> {
  const response = await request('/api/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: file,
    ownSessionHandling: true,
  });
  const body = await json(response);
  const result = body as Partial<SaveModelResult> | null;
  if (!result || !isModelSummary(result.model) || !result.validation) {
    throw new ApiRequestError(response.status, 'The server sent an unexpected import result.');
  }
  return result as SaveModelResult;
}

export function isModelRejected(value: unknown): value is ModelRejected {
  if (!isApiError(value)) return false;
  const validation: unknown = (value as { validation?: unknown }).validation;
  return typeof validation === 'object' && validation !== null;
}

/** GET /api/admin/models/damaged (Admin only): ids of stored models that can't be opened. */
export async function listDamagedModels(signal?: AbortSignal): Promise<string[]> {
  const body = await json(await request('/api/admin/models/damaged', signal ? { signal } : {}));
  const models = (body as Partial<DamagedModelListResponse> | null)?.models;
  if (
    !Array.isArray(models) ||
    !models.every((m: unknown) => typeof (m as { id?: unknown } | null)?.id === 'string')
  ) {
    throw new ApiRequestError(200, 'The server sent an unexpected list of damaged models.');
  }
  return models.map((m) => m.id);
}

/** DELETE /api/models/:id. */
export async function deleteModel(id: string): Promise<void> {
  await request(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

const isText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';

function isDatabaseStatus(value: unknown): value is DatabaseStatus {
  if (!isObject(value) || !isObject(value.migrations)) return false;
  const { migrations } = value;
  return (
    typeof value.configured === 'boolean' &&
    typeof value.connected === 'boolean' &&
    isText(value.host) &&
    (value.port === null || typeof value.port === 'number') &&
    isText(value.database) &&
    isText(value.user) &&
    typeof value.tls === 'boolean' &&
    typeof value.tlsVerified === 'boolean' &&
    isText(value.serverVersion) &&
    (migrations.applied === null || typeof migrations.applied === 'number') &&
    typeof migrations.total === 'number'
  );
}

/** GET /api/admin/database (Admin): the database connection's status, never its password. */
export async function getDatabaseStatus(signal?: AbortSignal): Promise<DatabaseStatus> {
  const body = await json(await request('/api/admin/database', signal ? { signal } : {}));
  if (!isDatabaseStatus(body)) {
    throw new ApiRequestError(200, 'The server sent an unexpected database status.');
  }
  return body;
}

/** POST /api/admin/database/test (Admin): opens a connection and runs a query. */
export async function testDatabaseConnection(): Promise<DatabaseTestResult> {
  const body = await json(await request('/api/admin/database/test', { method: 'POST' }));
  const result = body as Partial<DatabaseTestResult> | null;
  if (typeof result?.ok !== 'boolean' || typeof result.message !== 'string') {
    throw new ApiRequestError(200, 'The server sent an unexpected test result.');
  }
  return { ok: result.ok, message: result.message };
}

function elementUrl(modelId: string, elementId?: string): string {
  const base = `/api/models/${encodeURIComponent(modelId)}/elements`;
  return elementId === undefined ? base : `${base}/${encodeURIComponent(elementId)}`;
}

function isElementChangeResult(value: unknown): value is ElementChangeResult {
  if (!isObject(value) || !isObject(value.element) || !Array.isArray(value.warnings)) return false;
  const { element } = value;
  return (
    typeof element.id === 'string' &&
    typeof element.version === 'number' &&
    isObject(element.node) &&
    (element.node.metadata === undefined || isObject(element.node.metadata))
  );
}

async function elementResult(response: Response): Promise<ElementChangeResult> {
  const body = await json(response);
  if (!isElementChangeResult(body)) {
    throw new ApiRequestError(response.status, 'The server sent an unexpected element.');
  }
  return body;
}

const jsonBody = (body: unknown): RequestInit => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * POST /api/models/new (Admin): a new, empty model. A 422 carries `ElementRejected` (`fields`,
 * e.g. on `name`).
 */
export async function createModel(name: string): Promise<ModelSummary> {
  const body: NewModelRequest = { name };
  const response = await request('/api/models/new', { method: 'POST', ...jsonBody(body) });
  const result = await json(response);
  const model = (result as Partial<NewModelResult> | null)?.model;
  if (!isModelSummary(model)) {
    throw new ApiRequestError(response.status, 'The server sent an unexpected model.');
  }
  return model;
}

/** GET /api/models/:id/elements/:elementId (Modelling): one element with its version. */
export async function getElement(
  modelId: string,
  elementId: string,
  signal?: AbortSignal,
): Promise<ElementChangeResult> {
  return elementResult(await request(elementUrl(modelId, elementId), signal ? { signal } : {}));
}

/** POST /api/models/:id/elements (Modelling). A 422 carries `ElementRejected`. */
export async function createElement(
  modelId: string,
  element: NewElementRequest,
): Promise<ElementChangeResult> {
  return elementResult(
    await request(elementUrl(modelId), { method: 'POST', ...jsonBody(element) }),
  );
}

/** PATCH /api/models/:id/elements/:elementId (Modelling). 409: changed by someone else. */
export async function updateElement(
  modelId: string,
  elementId: string,
  change: UpdateElementRequest,
): Promise<ElementChangeResult> {
  return elementResult(
    await request(elementUrl(modelId, elementId), { method: 'PATCH', ...jsonBody(change) }),
  );
}

/** DELETE /api/models/:id/elements/:elementId?version=N (Modelling). */
export async function deleteElement(
  modelId: string,
  elementId: string,
  version: number,
): Promise<DeletedElementResult> {
  const response = await request(`${elementUrl(modelId, elementId)}?version=${version}`, {
    method: 'DELETE',
  });
  const body = await json(response);
  const result = body as Partial<DeletedElementResult> | null;
  if (
    typeof result?.id !== 'string' ||
    typeof result.deletedRelationshipCount !== 'number' ||
    !Array.isArray(result.deletedRelationshipIds) ||
    !Array.isArray(result.unnestedElementIds)
  ) {
    throw new ApiRequestError(response.status, 'The server sent an unexpected answer.');
  }
  return result as DeletedElementResult;
}

const relationshipUrl = (modelId: string, relationshipId?: string): string =>
  `/api/models/${encodeURIComponent(modelId)}/relationships${
    relationshipId === undefined ? '' : `/${encodeURIComponent(relationshipId)}`
  }`;

function isRelationshipChangeResult(value: unknown): value is RelationshipChangeResult {
  if (!isObject(value) || !isObject(value.relationship)) return false;
  const { relationship } = value;
  return (
    typeof relationship.id === 'string' &&
    typeof relationship.version === 'number' &&
    isObject(relationship.edge) &&
    Array.isArray(value.warnings) &&
    Array.isArray(value.nestingChanges)
  );
}

async function relationshipResult(response: Response): Promise<RelationshipChangeResult> {
  const body = await json(response);
  if (!isRelationshipChangeResult(body)) {
    throw new ApiRequestError(response.status, 'The server sent an unexpected relationship.');
  }
  return body;
}

/** GET /api/models/:id/relationships/:relationshipId (Modelling): one with its version. */
export async function getRelationship(
  modelId: string,
  relationshipId: string,
  signal?: AbortSignal,
): Promise<RelationshipChangeResult> {
  return relationshipResult(
    await request(relationshipUrl(modelId, relationshipId), signal ? { signal } : {}),
  );
}

/** POST /api/models/:id/relationships (Modelling). A 422 carries `RelationshipRejected`. */
export async function createRelationship(
  modelId: string,
  relationship: NewRelationshipRequest,
): Promise<RelationshipChangeResult> {
  return relationshipResult(
    await request(relationshipUrl(modelId), { method: 'POST', ...jsonBody(relationship) }),
  );
}

/** PATCH /api/models/:id/relationships/:relationshipId (Modelling). 409: changed meanwhile. */
export async function updateRelationship(
  modelId: string,
  relationshipId: string,
  change: UpdateRelationshipRequest,
): Promise<RelationshipChangeResult> {
  return relationshipResult(
    await request(relationshipUrl(modelId, relationshipId), {
      method: 'PATCH',
      ...jsonBody(change),
    }),
  );
}

/** DELETE /api/models/:id/relationships/:relationshipId?version=N (Modelling). */
export async function deleteRelationship(
  modelId: string,
  relationshipId: string,
  version: number,
): Promise<DeletedRelationshipResult> {
  const response = await request(`${relationshipUrl(modelId, relationshipId)}?version=${version}`, {
    method: 'DELETE',
  });
  const body = await json(response);
  const result = body as Partial<DeletedRelationshipResult> | null;
  if (typeof result?.id !== 'string' || !Array.isArray(result.nestingChanges)) {
    throw new ApiRequestError(response.status, 'The server sent an unexpected answer.');
  }
  return result as DeletedRelationshipResult;
}

const viewUrl = (modelId: string, viewId?: string): string =>
  `/api/models/${encodeURIComponent(modelId)}/views${
    viewId === undefined ? '' : `/${encodeURIComponent(viewId)}`
  }`;

function isViewSummary(value: unknown): value is ViewSummary {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.version === 'number' &&
    typeof value.elementCount === 'number' &&
    typeof value.relationshipCount === 'number'
  );
}

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === 'string');

function isCardLayout(value: unknown): value is ViewCardLayout {
  return (
    isObject(value) &&
    typeof value.elementId === 'string' &&
    typeof value.x === 'number' &&
    Number.isFinite(value.x) &&
    typeof value.y === 'number' &&
    Number.isFinite(value.y) &&
    (value.width === undefined || (typeof value.width === 'number' && Number.isFinite(value.width)))
  );
}

function isStoredView(value: unknown): value is StoredView {
  if (!isViewSummary(value)) return false;
  const fields = value as unknown as Record<string, unknown>;
  return (
    isIdList(fields.elementIds) &&
    isIdList(fields.relationshipIds) &&
    Array.isArray(fields.layout) &&
    fields.layout.every(isCardLayout)
  );
}

async function viewResult(response: Response): Promise<StoredView> {
  const body = await json(response);
  const view = isObject(body) ? body.view : undefined;
  if (!isStoredView(view)) {
    throw new ApiRequestError(response.status, 'The server sent an unexpected view.');
  }
  return view;
}

/** GET /api/models/:id/views (Viewer): the model's views, by name. */
export async function listViews(modelId: string, signal?: AbortSignal): Promise<ViewSummary[]> {
  const body = await json(await request(viewUrl(modelId), signal ? { signal } : {}));
  const views = isObject(body) ? body.views : undefined;
  if (!Array.isArray(views) || !views.every(isViewSummary)) {
    throw new ApiRequestError(200, 'The server sent an unexpected list of views.');
  }
  return views;
}

/** GET /api/models/:id/views/:viewId (Viewer): a view with its element and relationship ids. */
export async function getView(
  modelId: string,
  viewId: string,
  signal?: AbortSignal,
): Promise<StoredView> {
  return viewResult(await request(viewUrl(modelId, viewId), signal ? { signal } : {}));
}

/** POST /api/models/:id/views (Modeller). A 422 carries `ViewRejected` (`fields`). */
export async function createView(modelId: string, view: NewViewRequest): Promise<StoredView> {
  return viewResult(await request(viewUrl(modelId), { method: 'POST', ...jsonBody(view) }));
}

/** PATCH /api/models/:id/views/:viewId (Modeller): a new name. 409: changed meanwhile. */
export async function renameView(
  modelId: string,
  viewId: string,
  change: RenameViewRequest,
): Promise<ViewSummary> {
  const response = await request(viewUrl(modelId, viewId), {
    method: 'PATCH',
    ...jsonBody(change),
  });
  const body = await json(response);
  const view = isObject(body) ? body.view : undefined;
  if (!isViewSummary(view)) {
    throw new ApiRequestError(response.status, 'The server sent an unexpected view.');
  }
  return view;
}

/** PUT /api/models/:id/views/:viewId/contents (Modeller): new contents. 409: changed meanwhile. */
export async function replaceViewContents(
  modelId: string,
  viewId: string,
  contents: ReplaceViewContentsRequest,
): Promise<StoredView> {
  return viewResult(
    await request(`${viewUrl(modelId, viewId)}/contents`, {
      method: 'PUT',
      ...jsonBody(contents),
    }),
  );
}

/**
 * PUT /api/models/:id/views/:viewId/layout (Modeller): where the view's cards are. 409: changed
 * meanwhile.
 */
export async function replaceViewLayout(
  modelId: string,
  viewId: string,
  layout: ReplaceViewLayoutRequest,
): Promise<StoredView> {
  return viewResult(
    await request(`${viewUrl(modelId, viewId)}/layout`, {
      method: 'PUT',
      ...jsonBody(layout),
    }),
  );
}

/** DELETE /api/models/:id/views/:viewId?version=N (Modeller). */
export async function deleteView(modelId: string, viewId: string, version: number): Promise<void> {
  await request(`${viewUrl(modelId, viewId)}?version=${version}`, { method: 'DELETE' });
}

function isBranding(value: unknown): value is Branding {
  if (!isObject(value)) return false;
  const colour = (c: unknown) => c === null || isHexColour(c);
  return (
    colour(value.primary) &&
    colour(value.secondary) &&
    (value.logoUrl === null || typeof value.logoUrl === 'string') &&
    typeof value.version === 'number' &&
    Number.isInteger(value.version) &&
    value.version >= 0
  );
}

async function brandingResult(response: Response): Promise<Branding> {
  const body = await json(response);
  if (!isBranding(body)) {
    throw new ApiRequestError(response.status, 'The server sent unexpected branding.');
  }
  return {
    primary: body.primary,
    secondary: body.secondary,
    logoUrl: body.logoUrl,
    version: body.version,
  };
}

/** GET /api/branding (public): the colours, the logo's URL and the version; neutral = all null. */
export async function getBranding(signal?: AbortSignal): Promise<Branding> {
  return brandingResult(
    await request('/api/branding', { ...(signal ? { signal } : {}), ownSessionHandling: true }),
  );
}

/** PUT /api/admin/branding (Admin): both colours (null removes one). 409: changed meanwhile. */
export async function saveBrandingColours(
  primary: string | null,
  secondary: string | null,
  version: number,
): Promise<Branding> {
  return brandingResult(
    await request('/api/admin/branding', {
      method: 'PUT',
      ...jsonBody({ primary, secondary, version }),
    }),
  );
}

/** PUT /api/admin/branding/logo?version=N (Admin): the image file as the raw body. */
export async function uploadBrandingLogo(
  file: Blob,
  type: LogoMediaType,
  version: number,
): Promise<Branding> {
  return brandingResult(
    await request(`/api/admin/branding/logo?version=${version}`, {
      method: 'PUT',
      headers: { 'Content-Type': type },
      body: file,
    }),
  );
}

/** DELETE /api/admin/branding/logo?version=N (Admin). */
export async function removeBrandingLogo(version: number): Promise<Branding> {
  return brandingResult(
    await request(`/api/admin/branding/logo?version=${version}`, { method: 'DELETE' }),
  );
}

/** DELETE /api/admin/branding?version=N (Admin): no colours and no logo, for everyone. */
export async function resetBranding(version: number): Promise<Branding> {
  return brandingResult(
    await request(`/api/admin/branding?version=${version}`, { method: 'DELETE' }),
  );
}

// ---- AI agents: the consent page and Connected apps -------------------------------------------

const isString = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || isString(value);

function isConnectedApp(value: unknown): value is ConnectedApp {
  if (!isObject(value)) return false;
  return (
    isString(value.id) &&
    isTextOrNull(value.clientName) &&
    isString(value.redirectHost) &&
    typeof value.loopback === 'boolean' &&
    isString(value.connectedAt) &&
    isTextOrNull(value.lastUsedAt) &&
    isString(value.expiresAt)
  );
}

/** GET /api/agents/requests/:id: the agent asking to connect, for the consent page. */
export async function getAgentRequest(id: string, signal?: AbortSignal): Promise<AgentRequest> {
  const body = await json(
    await request(`/api/agents/requests/${encodeURIComponent(id)}`, signal ? { signal } : {}),
  );
  if (
    !isObject(body) ||
    !isTextOrNull(body.clientName) ||
    !isString(body.redirectHost) ||
    typeof body.loopback !== 'boolean' ||
    !isString(body.connectionEndsAt)
  ) {
    throw new ApiRequestError(200, 'The server sent an unexpected request.');
  }
  return body as unknown as AgentRequest;
}

/** POST /api/agents/requests/:id: the user's decision. Where the browser goes next. */
export async function decideAgentRequest(id: string, allow: boolean): Promise<string> {
  const body = await json(
    await request(`/api/agents/requests/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allow } satisfies AgentDecision),
    }),
  );
  const location = (body as Partial<AgentDecisionResult> | null)?.location;
  // Only ever an absolute https or http address, from the server.
  if (!isString(location) || !/^https?:\/\//.test(location)) {
    throw new ApiRequestError(200, 'The server sent an unexpected answer.');
  }
  return location;
}

/** GET /api/agents: the user's own connections, newest first. */
export async function listConnectedApps(signal?: AbortSignal): Promise<ConnectedApp[]> {
  const body = await json(await request('/api/agents', signal ? { signal } : {}));
  const apps = (body as Partial<ConnectedAppList> | null)?.apps;
  if (!Array.isArray(apps) || !apps.every(isConnectedApp)) {
    throw new ApiRequestError(200, 'The server sent an unexpected list.');
  }
  return apps;
}

/** DELETE /api/agents/:id. Already gone (404) counts as done. */
export async function disconnectApp(id: string): Promise<void> {
  try {
    await request(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return;
    throw error;
  }
}

/** GET /api/admin/agents: every user's connections (Admin). */
export async function listAllConnectedApps(signal?: AbortSignal): Promise<AdminConnectedApp[]> {
  const body = await json(await request('/api/admin/agents', signal ? { signal } : {}));
  const apps = (body as Partial<AdminConnectedAppList> | null)?.apps;
  if (
    !Array.isArray(apps) ||
    !apps.every((app) => isConnectedApp(app) && isString(app.userId) && isString(app.userName))
  ) {
    throw new ApiRequestError(200, 'The server sent an unexpected list.');
  }
  return apps;
}

/** DELETE /api/admin/agents/:id (Admin). Already gone (404) counts as done. */
export async function adminDisconnectApp(id: string): Promise<void> {
  try {
    await request(`/api/admin/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return;
    throw error;
  }
}

async function disconnected(response: Response): Promise<number> {
  const count = ((await json(response)) as Partial<AdminDisconnectResult> | null)?.disconnected;
  if (typeof count !== 'number')
    throw new ApiRequestError(200, 'The server sent an unexpected answer.');
  return count;
}

/** DELETE /api/admin/agents/users/:userId (Admin): how many ended. */
export async function adminDisconnectUser(userId: string): Promise<number> {
  return disconnected(
    await request(`/api/admin/agents/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  );
}

/** DELETE /api/admin/agents (Admin): how many ended. */
export async function adminDisconnectAll(): Promise<number> {
  return disconnected(await request('/api/admin/agents', { method: 'DELETE' }));
}

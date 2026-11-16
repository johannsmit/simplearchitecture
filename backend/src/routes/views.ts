import type {
  ApiError,
  DeletedViewResult,
  MovedViewResult,
  RenamedViewFolderResult,
  RenamedViewResult,
  ViewListResponse,
  ViewResult,
} from '@simplearchitecture/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { errorBody } from '../errors.js';
import { viewBodyLimit, viewFolderBodyLimit } from '../limits.js';
import { ViewLimitError, type ViewService } from '../views/view-service.js';
import { requireMediaType } from './body.js';
import { actor, auditLog, badModelId, modelling, refused } from './editing.js';

const jsonOnly = requireMediaType(['application/json'], 'Send the view as application/json');

// Opening views is viewing: Viewer and higher. Changing them is modelling (Modeller and Admin).
const viewing = { access: { space: 'viewing' } } as const;

interface ViewParams {
  id: string;
  viewId: string;
}

/** The answers ViewService's refusals get, as for elements; a full model is 409. */
function refusedView(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ViewLimitError) return reply.code(409).send(errorBody(409, error.message));
  return refused(reply, error);
}

/**
 * A model's views. The rules are in ViewService; these routes only translate. The version goes in
 * the PATCH and PUT bodies (contents and layout) and in the DELETE query (`?version=N`). The CSRF check (same Origin) and
 * the access guard run on every route (auth/access.ts).
 */
export function viewRoutes(service: ViewService): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: { id: string }; Reply: ViewListResponse | ApiError }>(
      '/api/models/:id/views',
      { config: viewing },
      async (request, reply) => {
        const { id } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          return await service.listViews(id);
        } catch (error) {
          return refusedView(reply, error);
        }
      },
    );

    // Where an element is used: read by everyone who can open the model, as the views are.
    app.get<{ Params: { id: string; elementId: string }; Reply: ViewListResponse | ApiError }>(
      '/api/models/:id/elements/:elementId/views',
      { config: viewing },
      async (request, reply) => {
        const { id, elementId } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          return await service.listViewsHolding(id, elementId);
        } catch (error) {
          return refusedView(reply, error);
        }
      },
    );

    app.get<{ Params: ViewParams; Reply: ViewResult | ApiError }>(
      '/api/models/:id/views/:viewId',
      { config: viewing },
      async (request, reply) => {
        const { id, viewId } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          return await service.getView(id, viewId);
        } catch (error) {
          return refusedView(reply, error);
        }
      },
    );

    app.post<{ Params: { id: string }; Reply: ViewResult | ApiError }>(
      '/api/models/:id/views',
      { config: modelling, bodyLimit: viewBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        const { id } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          const result = await service.createView(id, request.body, actor(request));
          auditLog(request, 'view-added', { modelId: id, viewId: result.view.id });
          return await reply
            .code(201)
            .header('location', `/api/models/${id}/views/${result.view.id}`)
            .send(result);
        } catch (error) {
          return refusedView(reply, error);
        }
      },
    );

    app.patch<{ Params: ViewParams; Reply: RenamedViewResult | ApiError }>(
      '/api/models/:id/views/:viewId',
      { config: modelling, bodyLimit: viewBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        const { id, viewId } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          const before = request.body as { version?: unknown } | null;
          const result = await service.renameView(id, viewId, request.body, actor(request));
          if (result.view.version !== before?.version) {
            auditLog(request, 'view-renamed', { modelId: id, viewId });
          }
          return result;
        } catch (error) {
          return refusedView(reply, error);
        }
      },
    );

    app.put<{ Params: ViewParams; Reply: ViewResult | ApiError }>(
      '/api/models/:id/views/:viewId/contents',
      { config: modelling, bodyLimit: viewBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        const { id, viewId } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          const before = request.body as { version?: unknown } | null;
          const result = await service.replaceContents(id, viewId, request.body, actor(request));
          if (result.view.version !== before?.version) {
            auditLog(request, 'view-changed', { modelId: id, viewId });
          }
          return result;
        } catch (error) {
          return refusedView(reply, error);
        }
      },
    );

    app.put<{ Params: ViewParams; Reply: ViewResult | ApiError }>(
      '/api/models/:id/views/:viewId/layout',
      { config: modelling, bodyLimit: viewBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        const { id, viewId } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          const before = request.body as { version?: unknown } | null;
          const result = await service.replaceLayout(id, viewId, request.body, actor(request));
          if (result.view.version !== before?.version) {
            auditLog(request, 'view-laid-out', { modelId: id, viewId });
          }
          return result;
        } catch (error) {
          return refusedView(reply, error);
        }
      },
    );

    // Folders: not version-checked, and the view's version stays. One log line per view changed.
    app.put<{ Params: ViewParams; Reply: MovedViewResult | ApiError }>(
      '/api/models/:id/views/:viewId/folder',
      { config: modelling, bodyLimit: viewFolderBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        const { id, viewId } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          const { view, changed } = await service.moveView(
            id,
            viewId,
            request.body,
            actor(request),
          );
          for (const changedId of changed) {
            auditLog(request, 'view-folder-changed', { modelId: id, viewId: changedId });
          }
          return { view };
        } catch (error) {
          return refusedView(reply, error);
        }
      },
    );

    app.patch<{ Params: { id: string }; Reply: RenamedViewFolderResult | ApiError }>(
      '/api/models/:id/view-folders',
      { config: modelling, bodyLimit: viewFolderBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        const { id } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          const { folder, views, changed } = await service.renameFolder(
            id,
            request.body,
            actor(request),
          );
          for (const changedId of changed) {
            auditLog(request, 'view-folder-changed', { modelId: id, viewId: changedId });
          }
          return { folder, views };
        } catch (error) {
          return refusedView(reply, error);
        }
      },
    );

    app.delete<{
      Params: ViewParams;
      Querystring: Record<string, unknown>;
      Reply: DeletedViewResult | ApiError;
    }>('/api/models/:id/views/:viewId', { config: modelling }, async (request, reply) => {
      const { id, viewId } = request.params;
      const invalid = badModelId(reply, id);
      if (invalid) return invalid;
      try {
        const result = await service.deleteView(id, viewId, request.query, actor(request));
        auditLog(request, 'view-deleted', { modelId: id, viewId });
        return result;
      } catch (error) {
        return refusedView(reply, error);
      }
    });
  };
}

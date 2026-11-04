import type {
  ApiError,
  DeletedElementResult,
  ElementChangeResult,
} from '@simplearchitecture/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { ElementService } from '../editing/element-service.js';
import { elementBodyLimit } from '../limits.js';
import { requireMediaType } from './body.js';
import { actor, auditLog, badModelId as badId, modelling, refused } from './editing.js';

const jsonOnly = requireMediaType(['application/json'], 'Send the element as application/json');

interface ElementParams {
  id: string;
  elementId: string;
}

/**
 * Editing one element of a stored model (Modelling). The rules are in ElementService; these
 * routes only translate. The version goes in the PATCH body and in the DELETE query
 * (`?version=N`), so no proxy has to keep a DELETE body. The CSRF check (same Origin) and the
 * access guard run on every route (auth/access.ts).
 */
export function elementRoutes(service: ElementService): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: ElementParams; Reply: ElementChangeResult | ApiError }>(
      '/api/models/:id/elements/:elementId',
      { config: modelling },
      async (request, reply) => {
        const { id, elementId } = request.params;
        const invalid = badId(reply, id);
        if (invalid) return invalid;
        try {
          return await service.getElement(id, elementId);
        } catch (error) {
          return refused(reply, error);
        }
      },
    );

    app.post<{ Params: { id: string }; Reply: ElementChangeResult | ApiError }>(
      '/api/models/:id/elements',
      { config: modelling, bodyLimit: elementBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        const { id } = request.params;
        const invalid = badId(reply, id);
        if (invalid) return invalid;
        try {
          const result = await service.addElement(id, request.body, actor(request));
          auditLog(request, 'element-added', { modelId: id, elementId: result.element.id });
          return await reply
            .code(201)
            .header(
              'location',
              `/api/models/${id}/elements/${encodeURIComponent(result.element.id)}`,
            )
            .send(result);
        } catch (error) {
          return refused(reply, error);
        }
      },
    );

    app.patch<{ Params: ElementParams; Reply: ElementChangeResult | ApiError }>(
      '/api/models/:id/elements/:elementId',
      { config: modelling, bodyLimit: elementBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        const { id, elementId } = request.params;
        const invalid = badId(reply, id);
        if (invalid) return invalid;
        try {
          const before = request.body as { version?: unknown } | null;
          const result = await service.updateElement(id, elementId, request.body, actor(request));
          if (result.element.version !== before?.version) {
            auditLog(request, 'element-updated', { modelId: id, elementId });
          }
          return result;
        } catch (error) {
          return refused(reply, error);
        }
      },
    );

    app.delete<{
      Params: ElementParams;
      Querystring: Record<string, unknown>;
      Reply: DeletedElementResult | ApiError;
    }>('/api/models/:id/elements/:elementId', { config: modelling }, async (request, reply) => {
      const { id, elementId } = request.params;
      const invalid = badId(reply, id);
      if (invalid) return invalid;
      try {
        const result = await service.deleteElement(id, elementId, request.query, actor(request));
        auditLog(
          request,
          'element-deleted',
          { modelId: id, elementId },
          { relationships: result.deletedRelationshipCount },
        );
        return result;
      } catch (error) {
        return refused(reply, error);
      }
    });
  };
}

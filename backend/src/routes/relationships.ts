import type {
  ApiError,
  DeletedRelationshipResult,
  RelationshipChangeResult,
} from '@simplearchitecture/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { RelationshipService } from '../editing/relationship-service.js';
import { relationshipBodyLimit } from '../limits.js';
import { requireMediaType } from './body.js';
import { actor, auditLog, badModelId, modelling, refused } from './editing.js';

const jsonOnly = requireMediaType(
  ['application/json'],
  'Send the relationship as application/json',
);

interface RelationshipParams {
  id: string;
  relationshipId: string;
}

/**
 * Editing one relationship of a stored model (Modelling), as the element routes do: the rules are
 * in RelationshipService, the version goes in the PATCH body and the DELETE query, and the CSRF
 * check (same Origin) and the access guard run on every route (auth/access.ts).
 */
export function relationshipRoutes(service: RelationshipService): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Params: RelationshipParams; Reply: RelationshipChangeResult | ApiError }>(
      '/api/models/:id/relationships/:relationshipId',
      { config: modelling },
      async (request, reply) => {
        const { id, relationshipId } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          return await service.getRelationship(id, relationshipId);
        } catch (error) {
          return refused(reply, error);
        }
      },
    );

    app.post<{ Params: { id: string }; Reply: RelationshipChangeResult | ApiError }>(
      '/api/models/:id/relationships',
      { config: modelling, bodyLimit: relationshipBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        const { id } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          const result = await service.addRelationship(id, request.body, actor(request));
          const relationshipId = result.relationship.id;
          auditLog(request, 'relationship-added', { modelId: id, relationshipId });
          return await reply
            .code(201)
            .header('location', `/api/models/${id}/relationships/${relationshipId}`)
            .send(result);
        } catch (error) {
          return refused(reply, error);
        }
      },
    );

    app.patch<{ Params: RelationshipParams; Reply: RelationshipChangeResult | ApiError }>(
      '/api/models/:id/relationships/:relationshipId',
      { config: modelling, bodyLimit: relationshipBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        const { id, relationshipId } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          const before = request.body as { version?: unknown } | null;
          const result = await service.updateRelationship(
            id,
            relationshipId,
            request.body,
            actor(request),
          );
          if (result.relationship.version !== before?.version) {
            auditLog(request, 'relationship-updated', { modelId: id, relationshipId });
          }
          return result;
        } catch (error) {
          return refused(reply, error);
        }
      },
    );

    app.delete<{
      Params: RelationshipParams;
      Querystring: Record<string, unknown>;
      Reply: DeletedRelationshipResult | ApiError;
    }>(
      '/api/models/:id/relationships/:relationshipId',
      { config: modelling },
      async (request, reply) => {
        const { id, relationshipId } = request.params;
        const invalid = badModelId(reply, id);
        if (invalid) return invalid;
        try {
          const result = await service.deleteRelationship(
            id,
            relationshipId,
            request.query,
            actor(request),
          );
          auditLog(request, 'relationship-deleted', { modelId: id, relationshipId });
          return result;
        } catch (error) {
          return refused(reply, error);
        }
      },
    );
  };
}

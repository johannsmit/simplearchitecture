import type {
  ApiError,
  DeletedElementPropertyResult,
  DeletedRelationshipPropertyResult,
  ElementPropertyResult,
  RelationshipPropertyListResponse,
  RelationshipPropertyResult,
  RelationshipPropertyUsageResponse,
} from '@simplearchitecture/shared';
import type { FastifyPluginAsync } from 'fastify';
import { propertyBodyLimit } from '../limits.js';
import type { PropertyService } from '../properties/property-service.js';
import { requireMediaType } from './body.js';
import { actor, refused } from './editing.js';

const jsonOnly = requireMediaType(['application/json'], 'Send the property as application/json');

// Everyone with a role reads the definitions; only Admins change them or see how they're used.
const viewing = { access: { space: 'viewing' } } as const;
const admin = { access: { space: 'admin' } } as const;

/**
 * The properties an Admin defines (Admin → Properties): both lists, for relationships and for
 * elements. The rules are in PropertyService; these routes only translate. A change or delete names
 * the property by its key in the query (`?key=costCentre`): a key may be long or hold any
 * character, more than the router takes in a path. A change to an element property says so in the
 * query (`?for=element`); without it, a change is to a relationship property. The version goes in
 * the PATCH body.
 */
export function propertyRoutes(service: PropertyService): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Reply: RelationshipPropertyListResponse }>(
      '/api/properties',
      { config: viewing },
      async () => ({
        properties: await service.list(),
        elementProperties: await service.listElements(),
      }),
    );

    app.get<{ Reply: RelationshipPropertyUsageResponse | ApiError }>(
      '/api/properties/usage',
      { config: admin },
      async (_request, reply) => {
        try {
          return { usage: await service.usage(), elementUsage: await service.elementUsage() };
        } catch (error) {
          return refused(reply, error);
        }
      },
    );

    app.post<{
      Querystring: Record<string, unknown>;
      Reply: RelationshipPropertyResult | ElementPropertyResult | ApiError;
    }>(
      '/api/properties',
      { config: admin, bodyLimit: propertyBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        try {
          const property = await service.create(request.body, actor(request), request.query);
          request.log.info(
            { audit: 'property-added', userId: actor(request).id },
            'property added',
          );
          return await reply.code(201).send({ property });
        } catch (error) {
          return refused(reply, error);
        }
      },
    );

    app.patch<{
      Querystring: Record<string, unknown>;
      Reply: RelationshipPropertyResult | ElementPropertyResult | ApiError;
    }>(
      '/api/properties',
      { config: admin, bodyLimit: propertyBodyLimit, onRequest: jsonOnly },
      async (request, reply) => {
        try {
          const property = await service.update(request.query, request.body, actor(request));
          request.log.info(
            { audit: 'property-changed', userId: actor(request).id },
            'property changed',
          );
          return { property };
        } catch (error) {
          return refused(reply, error);
        }
      },
    );

    app.delete<{
      Querystring: Record<string, unknown>;
      Reply: DeletedRelationshipPropertyResult | DeletedElementPropertyResult | ApiError;
    }>('/api/properties', { config: admin }, async (request, reply) => {
      try {
        const result = await service.delete(request.query, actor(request));
        request.log.info(
          {
            audit: 'property-deleted',
            userId: actor(request).id,
            values: result.values,
            models: result.models,
          },
          'property deleted',
        );
        return result;
      } catch (error) {
        return refused(reply, error);
      }
    });
  };
}

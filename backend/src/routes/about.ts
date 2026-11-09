import type { AboutResponse } from '@simplearchitecture/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { AboutService } from '../about/about-service.js';

const aboutResponseSchema = {
  type: 'object',
  properties: { version: { type: 'string' }, commit: { type: 'string' } },
  required: ['version', 'commit'],
  additionalProperties: false,
} as const;

/** The code version the server runs, for signed-in people only (the health check names none). */
export function aboutRoutes(service: AboutService): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Reply: AboutResponse }>(
      '/api/about',
      {
        config: { access: { space: 'viewing' } },
        schema: { response: { 200: aboutResponseSchema } },
      },
      async () => service.about(),
    );
  };
}

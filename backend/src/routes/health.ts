import type { HealthResponse } from '@simplearchitecture/shared';
import type { FastifyPluginAsync } from 'fastify';

const healthResponseSchema = {
  type: 'object',
  properties: { status: { type: 'string', enum: ['ok'] } },
  required: ['status'],
  additionalProperties: false,
} as const;

/** Public liveness check. It names no version or other detail an attacker could use. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: HealthResponse }>(
    '/api/health',
    { config: { access: 'public' }, schema: { response: { 200: healthResponseSchema } } },
    async () => ({ status: 'ok' }),
  );
};

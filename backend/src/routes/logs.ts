import type { ApiError, LogsResponse } from '@simplearchitecture/shared';
import type { FastifyPluginAsync } from 'fastify';
import { errorBody } from '../errors.js';
import { LogAccessError, LogQueryError, type LogService } from '../logs/log-service.js';

const admin = { access: { space: 'admin' } } as const;

/**
 * Admin → Logs:
 * `GET /api/admin/logs?from=YYYY-MM-DD&to=YYYY-MM-DD&level=warn&tzOffset=-60&toTzOffset=-120`.
 * `tzOffset` is the browser's offset at the start of `from`, `toTzOffset` the one at the end of
 * `to` (they differ when the range crosses a clock change; `toTzOffset` defaults to `tzOffset`).
 * The service checks the query and the role again; see logs/log-service.ts.
 */
export function logRoutes(service: LogService): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Reply: LogsResponse | ApiError }>(
      '/api/admin/logs',
      { config: admin },
      async (request, reply) => {
        const session = request.session;
        if (!session) throw new Error('logs route reached without a session');
        try {
          return await service.query(session.user.roles, request.query);
        } catch (error) {
          if (error instanceof LogQueryError) {
            return reply.code(400).send(errorBody(400, error.message));
          }
          if (error instanceof LogAccessError) {
            return reply.code(403).send(errorBody(403, error.message));
          }
          throw error;
        }
      },
    );
  };
}

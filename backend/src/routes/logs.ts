import type { ApiError, LogsResponse } from '@simplearchitecture/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { errorBody } from '../errors.js';
import { LogQueryError, type LogService } from '../logs/log-service.js';

const admin = { access: { space: 'admin' } } as const;

export const logQueryShapeMessage =
  'Send from and to as YYYY-MM-DD, and level as a number, each at most once.';

const querySchema = z.strictObject({
  from: z.string().max(10).optional(),
  to: z.string().max(10).optional(),
  level: z
    .string()
    .regex(/^\d{1,3}$/)
    .optional(),
});

const statusOf = { invalid: 400, forbidden: 403, 'rate-limited': 429 } as const;

/**
 * Admin → Logs: the application's log lines for whole UTC days (see logs/log-service.ts). Each read
 * is audited with the range and the count, never the lines.
 */
export function logRoutes(service: LogService): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Reply: LogsResponse | ApiError }>(
      '/api/admin/logs',
      { config: admin },
      async (request, reply) => {
        const session = request.session;
        if (!session) throw new Error('logs route reached without a session');
        const query = querySchema.safeParse(request.query);
        if (!query.success) return reply.code(400).send(errorBody(400, logQueryShapeMessage));
        const { from, to, level } = query.data;
        try {
          const result = await service.query(
            { userId: session.user.id, roles: session.user.roles },
            { from, to, minLevel: level === undefined ? undefined : Number(level) },
          );
          request.log.info(
            {
              audit: 'logs-read',
              userId: session.user.id,
              from: result.from,
              to: result.to,
              minLevel: result.minLevel,
              lines: result.lines.length,
              truncated: result.truncated,
            },
            'logs read',
          );
          return result;
        } catch (error) {
          if (!(error instanceof LogQueryError)) throw error;
          const status = statusOf[error.reason];
          if (status === 429) void reply.header('retry-after', '60');
          return reply.code(status).send(errorBody(status, error.message));
        }
      },
    );
  };
}

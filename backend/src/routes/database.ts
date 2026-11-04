import { createHash } from 'node:crypto';
import type { DatabaseStatus, DatabaseTestResult } from '@simplearchitecture/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { DatabaseService } from '../db/service.js';
import { errorBody } from '../errors.js';
import { RateLimiter } from '../rate-limit.js';

const admin = { access: { space: 'admin' } } as const;

/** Test connection opens a new connection each time: a few per minute is plenty. */
export const connectionTestsPerMinute = 5;
export const tooManyTestsMessage = 'Too many connection tests. Wait a minute and try again.';

/**
 * Admin → Database: the connection status (read-only: the details are set in DATABASE_URL) and a
 * connection test. Neither ever returns the password, the URL or a driver message.
 */
export function databaseRoutes(database: DatabaseService, now: () => number): FastifyPluginAsync {
  return async (app) => {
    const limiter = new RateLimiter(connectionTestsPerMinute, 60_000, now);

    app.get<{ Reply: DatabaseStatus }>('/api/admin/database', { config: admin }, async () =>
      database.status(),
    );

    app.post<{ Reply: DatabaseTestResult | ReturnType<typeof errorBody> }>(
      '/api/admin/database/test',
      { config: admin },
      async (request, reply) => {
        const session = request.session;
        if (!session) throw new Error('database route reached without a session');
        // Keyed by a hash of the session id, so the raw id is kept in one place only.
        const key = createHash('sha256').update(session.id).digest('hex');
        if (!limiter.allow(key)) {
          return reply.code(429).send(errorBody(429, tooManyTestsMessage));
        }
        const result = await database.test();
        request.log.info(
          { audit: 'database-tested', userId: session.user.id, ok: result.ok },
          'database connection tested',
        );
        return result;
      },
    );
  };
}

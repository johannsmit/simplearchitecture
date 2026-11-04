import { createHash } from 'node:crypto';
import { roles } from '@simplearchitecture/shared';
import { z } from 'zod';
import type { Db } from '../db/db.js';
import {
  defaultSessionTimeouts,
  newSessionId,
  type Session,
  type SessionStore,
  type SessionTimeouts,
  type SessionUser,
} from './sessions.js';

/** How often expired sessions are removed. */
export const sessionSweepIntervalMs = 10 * 60 * 1000;

const userSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().nullable(),
  // Known roles only, as at sign-in: anything else gives no access.
  roles: z.array(z.string()).transform((claimed) => roles.filter((role) => claimed.includes(role))),
});

interface SessionRow {
  user_data: unknown;
  created_at: Date;
  last_seen_at: Date;
}

export interface SweepLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

/** Only a hash of the id is stored: someone who reads the table can't use a session. */
function hashOf(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

/**
 * Sessions in PostgreSQL, so an API restart or a second container doesn't sign anyone out. The
 * same idle and absolute timeouts as in memory apply, checked in the query itself. Expired rows
 * are removed every few minutes.
 */
export class PostgresSessionStore implements SessionStore {
  readonly #db: Db;
  readonly #now: () => number;
  readonly #log: SweepLogger;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    db: Db,
    options: { timeouts?: SessionTimeouts; now?: () => number; log: SweepLogger },
  ) {
    this.#db = db;
    this.timeouts = options.timeouts ?? defaultSessionTimeouts;
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
  }

  readonly timeouts: SessionTimeouts;

  /** Removes expired sessions now, and then every `intervalMs`. */
  startSweeping(intervalMs: number = sessionSweepIntervalMs): void {
    const run = () => {
      this.sweep().catch((error: unknown) => {
        this.#log.warn({ err: error }, 'expired sessions not removed');
      });
    };
    run();
    this.#timer = setInterval(run, intervalMs);
    this.#timer.unref();
  }

  async create(user: SessionUser): Promise<Session> {
    const time = this.#now();
    const session: Session = { id: newSessionId(), user, createdAt: time, lastSeenAt: time };
    await this.#db.query(
      `insert into sessions (id_hash, user_data, created_at, last_seen_at)
       values ($1, $2::text::jsonb, $3, $3)`,
      [hashOf(session.id), JSON.stringify(user), new Date(time)],
    );
    return session;
  }

  async touch(id: string): Promise<Session | undefined> {
    const time = this.#now();
    const [row] = await this.#db.query<SessionRow>(
      `update sessions set last_seen_at = $2
       where id_hash = $1 and last_seen_at > $3 and created_at > $4
       returning user_data, created_at, last_seen_at`,
      [hashOf(id), new Date(time), ...this.#limits(time)],
    );
    const user = row === undefined ? undefined : userSchema.safeParse(row.user_data);
    if (row === undefined || !user?.success) {
      // Expired, unknown or unreadable: make sure it's gone.
      await this.#db.query('delete from sessions where id_hash = $1', [hashOf(id)]);
      return undefined;
    }
    return { id, user: user.data, createdAt: row.created_at.getTime(), lastSeenAt: time };
  }

  async destroy(id: string): Promise<Session | undefined> {
    const [row] = await this.#db.query<SessionRow>(
      'delete from sessions where id_hash = $1 returning user_data, created_at, last_seen_at',
      [hashOf(id)],
    );
    const user = row === undefined ? undefined : userSchema.safeParse(row.user_data);
    if (row === undefined || !user?.success) return undefined;
    return {
      id,
      user: user.data,
      createdAt: row.created_at.getTime(),
      lastSeenAt: row.last_seen_at.getTime(),
    };
  }

  /** Removes every expired session. Returns how many. */
  async sweep(): Promise<number> {
    const [result] = await this.#db.query<{ count: number }>(
      `with removed as (
         delete from sessions where last_seen_at <= $1 or created_at <= $2 returning 1
       ) select count(*)::int as count from removed`,
      this.#limits(this.#now()),
    );
    const count = result?.count ?? 0;
    if (count > 0) this.#log.info({ count }, 'expired sessions removed');
    return count;
  }

  close(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    return Promise.resolve();
  }

  /** A session last seen at or before the first, or created at or before the second, is over. */
  #limits(time: number): [Date, Date] {
    return [new Date(time - this.timeouts.idleMs), new Date(time - this.timeouts.absoluteMs)];
  }
}

import { randomBytes } from 'node:crypto';
import type { Role } from '@simplearchitecture/shared';

export interface SessionUser {
  /** The provider's stable user id: `oid` (Entra's object id), falling back to `sub`. */
  id: string;
  name: string;
  email: string | null;
  roles: Role[];
}

export interface Session {
  id: string;
  user: SessionUser;
  createdAt: number;
  lastSeenAt: number;
}

export interface SessionTimeouts {
  /** Ends the session after this long without a request (ms). */
  idleMs: number;
  /** Ends the session this long after sign-in, however active (ms). */
  absoluteMs: number;
}

export const defaultSessionTimeouts: SessionTimeouts = {
  idleMs: 30 * 60 * 1000,
  absoluteMs: 8 * 60 * 60 * 1000,
};

/**
 * Server-side sessions. The browser only holds the random session id. In memory without a
 * database; in PostgreSQL with one (PostgresSessionStore), so a restart signs nobody out.
 */
export interface SessionStore {
  readonly timeouts: SessionTimeouts;
  /** Creates a session with a fresh id (256 bits). Callers destroy any previous session first. */
  create(user: SessionUser): Promise<Session>;
  /** Returns the live session for an id and extends its idle timeout, or `undefined`. */
  touch(id: string): Promise<Session | undefined>;
  /** Ends a session and returns it, if it existed. */
  destroy(id: string): Promise<Session | undefined>;
  /** Stops any background work (the clean-up timer). */
  close(): Promise<void>;
}

/** A new random session id (256 bits). */
export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

/** Sessions in memory: lost when the API restarts. */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Session>();

  constructor(
    readonly timeouts: SessionTimeouts = defaultSessionTimeouts,
    private readonly now: () => number = Date.now,
  ) {}

  create(user: SessionUser): Promise<Session> {
    this.#sweep();
    const time = this.now();
    const session: Session = { id: newSessionId(), user, createdAt: time, lastSeenAt: time };
    this.#sessions.set(session.id, session);
    return Promise.resolve(session);
  }

  touch(id: string): Promise<Session | undefined> {
    const session = this.#sessions.get(id);
    if (!session) return Promise.resolve(undefined);
    const time = this.now();
    if (isExpired(session, time, this.timeouts)) {
      this.#sessions.delete(id);
      return Promise.resolve(undefined);
    }
    session.lastSeenAt = time;
    return Promise.resolve(session);
  }

  destroy(id: string): Promise<Session | undefined> {
    const session = this.#sessions.get(id);
    this.#sessions.delete(id);
    return Promise.resolve(session);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** Drops expired sessions so memory doesn't grow with abandoned sign-ins. */
  #sweep(): void {
    const time = this.now();
    for (const [id, session] of this.#sessions) {
      if (isExpired(session, time, this.timeouts)) this.#sessions.delete(id);
    }
  }
}

function isExpired(session: Session, time: number, timeouts: SessionTimeouts): boolean {
  return (
    time - session.lastSeenAt >= timeouts.idleMs || time - session.createdAt >= timeouts.absoluteMs
  );
}

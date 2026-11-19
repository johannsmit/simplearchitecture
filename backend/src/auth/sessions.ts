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
 * Server-side sessions. The browser only holds the random session id. Kept in PostgreSQL
 * (PostgresSessionStore), so a restart signs nobody out.
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

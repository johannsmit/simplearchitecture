import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { errorBody } from './errors.js';

/** Keys kept at most. Past it, the oldest keys are dropped, so many senders can't fill memory. */
const maxKeys = 10_000;

/**
 * Allows at most `limit` calls per key in any `windowMs`. In memory, per API process (so per
 * container: with several containers, each counts on its own). Old keys are dropped, so memory
 * stays bounded.
 */
export class RateLimiter {
  readonly #calls = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a call and says whether it is allowed. */
  allow(key: string): boolean {
    const time = this.now();
    const since = time - this.windowMs;
    if (this.#calls.size > 1_000) {
      for (const [other, times] of this.#calls) {
        if ((times.at(-1) ?? 0) <= since) this.#calls.delete(other);
      }
      // Still full of live keys: drop the oldest (a Map keeps insertion order).
      for (const other of this.#calls.keys()) {
        if (this.#calls.size <= maxKeys) break;
        this.#calls.delete(other);
      }
    }
    const recent = (this.#calls.get(key) ?? []).filter((at) => at > since);
    if (recent.length >= this.limit) {
      this.#calls.set(key, recent);
      return false;
    }
    recent.push(time);
    this.#calls.set(key, recent);
    return true;
  }

  /** How many keys are kept (tests). */
  get size(): number {
    return this.#calls.size;
  }
}

/**
 * What a refused request gets: 429 with a message (API calls), or, for a browser navigation such
 * as sign-in, a 303 to a fixed page that explains it (never built from the request).
 */
export type Refusal = { message: string } | { redirect: string };

/**
 * An onRequest hook that refuses a request once `keyOf(request)` has used up its calls, with
 * `Retry-After`. Requests without a key (keyOf returns undefined) are never limited by it.
 */
export function rateLimit(
  limiter: RateLimiter,
  keyOf: (request: FastifyRequest) => string | undefined,
  refusal: Refusal,
  retryAfterSeconds = 60,
): onRequestAsyncHookHandler {
  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply) {
    const key = keyOf(request);
    if (key === undefined || limiter.allow(key)) return;
    request.log.warn({ url: request.routeOptions.url }, 'rate limit reached');
    void reply.header('retry-after', String(retryAfterSeconds));
    if ('redirect' in refusal) return reply.redirect(refusal.redirect, 303);
    return reply.code(429).send(errorBody(429, refusal.message));
  };
}

/**
 * Sign-in starts (`/auth/login`) and callbacks (`/auth/callback`) per client IP address per
 * minute, each counted on its own. Over it, the browser goes to `/?signin=busy`.
 */
export const signInsPerMinute = 10;
export const signInBusyPath = '/?signin=busy';

/** Uploads (model imports and checks, the logo) per signed-in user per minute, all together. */
export const uploadsPerMinute = 10;
export const tooManyUploadsMessage = 'Too many uploads. Wait a minute and try again.';

/**
 * The upload limit: one budget per signed-in user, shared by every upload route. Runs after the
 * access guard, so the session is there.
 */
export function uploadLimit(now: () => number): onRequestAsyncHookHandler {
  return rateLimit(
    new RateLimiter(uploadsPerMinute, 60_000, now),
    (request) => request.session?.user.id,
    { message: tooManyUploadsMessage },
  );
}

/**
 * New models per signed-in user per minute. Their own budget, not the uploads': a new model is
 * small, but each one takes a place in the store (see maxStoredModels).
 */
export const newModelsPerMinute = 10;
export const tooManyNewModelsMessage = 'Too many new models. Wait a minute and try again.';

export function newModelLimit(now: () => number): onRequestAsyncHookHandler {
  return rateLimit(
    new RateLimiter(newModelsPerMinute, 60_000, now),
    (request) => request.session?.user.id,
    { message: tooManyNewModelsMessage },
  );
}

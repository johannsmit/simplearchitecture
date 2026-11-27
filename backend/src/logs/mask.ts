import type { LogEntry } from '@simplearchitecture/shared';

/**
 * Personal data in stored log entries, masked before get_logs hands them to an Admin's agent
 * (and so, possibly, to its model provider). Admin → Logs shows the full values.
 *
 * What the app logs: `userId` (sign-in, MCP, audit and refusal lines), `targetUserId` (an Admin
 * disconnecting a user's agents) and `req.remoteAddress` (the client address of each request).
 * Names close to these are masked too, so a field added later under a similar name is covered.
 * A user id can also be part of a request's path (`req.url`): the routes in `userIdPaths` have
 * that segment masked. Free text (a message, an error's details) is not searched, so a value an
 * error quotes stays as it is.
 */

export const maskPrefix = '*****';

/** Field names that hold a user id or a client address, at any depth. */
const personalName =
  /user[-_]?id$|^sub$|remote[-_]?address|client[-_]?address|^ip$|ip[-_]?address/i;

const maxDepth = 12;

/** Routes with a user id in their path: the prefix before it, and the id segment itself. */
const userIdPaths: readonly RegExp[] = [/^(\/api\/admin\/agents\/users\/)([^/?#]+)/];

/** A logged path with the user id of a route in `userIdPaths` masked; the rest as it was. */
export function maskUrl(url: string): string {
  for (const pattern of userIdPaths) {
    const found = pattern.exec(url);
    if (found !== null) {
      const [whole, prefix = '', id = ''] = found;
      return `${prefix}${maskValue(id)}${url.slice(whole.length)}`;
    }
  }
  return url;
}

export function isPersonalName(name: string): boolean {
  return personalName.test(name);
}

/** `*****` and the value's last 4 characters; a value of 4 characters or fewer is `*****` alone. */
export function maskValue(value: string): string {
  // By code point, so a pair of surrogates is never split; ids and addresses are ASCII anyway.
  const characters = Array.from(value);
  return characters.length <= 4 ? maskPrefix : maskPrefix + characters.slice(-4).join('');
}

/** A copy of a value with every user id and client address masked, at any depth. */
export function maskPersonal(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  // Stored entries are already cut at this depth (redact.ts); never pass deeper text unmasked.
  if (depth >= maxDepth) return '[Nested too deep]';
  if (Array.isArray(value)) return value.map((item) => maskPersonal(item, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = isPersonalName(key)
      ? maskField(item, depth + 1)
      : key === 'url' && typeof item === 'string'
        ? maskUrl(item)
        : maskPersonal(item, depth + 1);
  }
  return copy;
}

function maskField(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return maskValue(value);
  if (typeof value === 'number' || typeof value === 'bigint') return maskValue(String(value));
  // A list of ids, or an object under a personal name: mask what it holds.
  if (Array.isArray(value)) return value.map((item) => maskField(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    if (depth >= maxDepth) return maskPrefix;
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) copy[key] = maskField(item, depth + 1);
    return copy;
  }
  return value;
}

/** An entry as get_logs returns it: user ids and client addresses masked in its other fields. */
export function maskEntry(entry: LogEntry): LogEntry {
  return { ...entry, extra: maskPersonal(entry.extra) as Record<string, unknown> };
}

import { maxJsonDepth } from '../limits.js';
import { reservedKey } from './validate.js';

/** Why a JGF body was refused. The messages are user-safe: they never echo the input. */
export class JgfJsonError extends Error {
  override name = 'JgfJsonError';
  constructor(readonly reason: 'invalid' | 'reserved-key' | 'too-deep') {
    super(
      reason === 'reserved-key'
        ? `The key "${reservedKey}" is reserved: it can't be a node id, edge id or metadata key.`
        : reason === 'too-deep'
          ? `The JSON is nested too deeply (more than ${maxJsonDepth} levels).`
          : 'Body is not valid JSON',
    );
  }
}

/**
 * Parses JGF JSON. Like Fastify's default parser it refuses `__proto__` (and
 * `constructor.prototype`), but says why, and it refuses nesting deeper than `maxJsonDepth`.
 *
 * JSON.parse itself copes with any depth, and keeps `__proto__` as a plain own key. The checks
 * then walk the result with an explicit stack: a reviver (or any recursion) would overflow the
 * call stack on deeply nested input and hide the reason.
 */
export function parseJgfJson(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new JgfJsonError('invalid');
  }
  if (typeof value !== 'object' || value === null) return value;

  const stack: object[] = [value];
  const depths: number[] = [1];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    const childDepth = (depths.pop() ?? 0) + 1;
    if (Array.isArray(current)) {
      for (const item of current as unknown[]) {
        if (typeof item !== 'object' || item === null) continue;
        if (childDepth > maxJsonDepth) throw new JgfJsonError('too-deep');
        stack.push(item);
        depths.push(childDepth);
      }
      continue;
    }
    const record = current as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === reservedKey) throw new JgfJsonError('reserved-key');
      const child = record[key];
      if (typeof child !== 'object' || child === null) continue;
      if (key === 'constructor' && Object.hasOwn(child, 'prototype')) {
        throw new JgfJsonError('reserved-key');
      }
      if (childDepth > maxJsonDepth) throw new JgfJsonError('too-deep');
      stack.push(child);
      depths.push(childDepth);
    }
  }
  return value;
}

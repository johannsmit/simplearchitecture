import { prototypeKeyMessage } from '@simplearchitecture/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorBody } from '../errors.js';
import { JgfJsonError, parseJgfJson } from '../jgf/parse.js';
import { countJgf } from '../jgf/validate.js';
import { jgfBodyLimit, maxImportEdges, maxImportNodes } from '../limits.js';
import { defaultXmlLimits } from '../oef/xml.js';

export { jgfBodyLimit };
/** Largest OEF body (bytes): OEF files can be a few MB. Larger requests get 413. */
export const oefBodyLimit = defaultXmlLimits.maxBytes;

export const jgfMediaTypes = ['application/json'] as const;
export const oefMediaTypes = ['application/xml', 'text/xml'] as const;
export const jgfMediaTypeMessage = 'Send the JGF file as application/json';
export const oefMediaTypeMessage = 'Send the OEF file as application/xml or text/xml';

function isMediaType(contentType: string | undefined, types: readonly string[]): boolean {
  const media = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return types.includes(media);
}

/**
 * 415 before the body is read (an onRequest hook runs after the access guard and before parsing).
 * The message never echoes the Content-Type.
 */
export function requireMediaType(types: readonly string[], message: string) {
  return async function mediaTypeCheck(request: FastifyRequest, reply: FastifyReply) {
    if (!isMediaType(request.headers['content-type'], types)) {
      return reply.code(415).send(errorBody(415, message));
    }
  };
}

function clientError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * Body parsers for the routes that take models, in the calling plugin only: OEF as plain XML
 * text (the safe parser does the rest), and JGF JSON with clear messages for reserved keys and
 * deep nesting (see jgf/parse.ts).
 */
export function registerModelBodyParsers(app: FastifyInstance): void {
  app.addContentTypeParser(
    [...oefMediaTypes],
    { parseAs: 'string', bodyLimit: oefBodyLimit },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: jgfBodyLimit },
    (_request, body, done) => {
      try {
        done(null, parseJgfJson(body as string));
      } catch (error) {
        const message =
          error instanceof JgfJsonError ? error.message : new JgfJsonError('invalid').message;
        done(clientError(400, message), undefined);
      }
    },
  );
}

/**
 * Parses the JSON body of an element or relationship change. Like Fastify's own parser it refuses
 * `__proto__` and `constructor.prototype` (400), with one exception: `__proto__` as a key of the
 * request's `metadata`, which JSON.parse keeps as a plain own key. The editing service refuses that
 * one at its field (`metadata.__proto__`, 422), with the message the forms show. The walk uses a
 * stack, so deep nesting can't overflow the call stack.
 */
export function parseEditingJson(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw clientError(400, new JgfJsonError('invalid').message);
  }
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const metadata = Object.hasOwn(record, 'metadata') ? record.metadata : undefined;
  const stack: object[] = [value];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    for (const [key, child] of Object.entries(current) as [string, unknown][]) {
      if (key === '__proto__' && current !== metadata) throw clientError(400, prototypeKeyMessage);
      if (typeof child !== 'object' || child === null) continue;
      if (key === 'constructor' && Object.hasOwn(child, 'prototype')) {
        throw clientError(400, new JgfJsonError('reserved-key').message);
      }
      stack.push(child);
    }
  }
  return value;
}

/** The JSON parser of the element and relationship routes (`parseEditingJson`), in that plugin. */
export function registerEditingBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, parseEditingJson(body as string));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
}

/** The 413 message when a JGF body has more nodes or edges than an import allows, or undefined. */
export function jgfTooLarge(request: FastifyRequest): string | undefined {
  const counts = countJgf(request.body);
  if (counts.nodes <= maxImportNodes && counts.edges <= maxImportEdges) return undefined;
  request.log.info({ nodes: counts.nodes, edges: counts.edges }, 'JGF import too large');
  return counts.nodes > maxImportNodes
    ? `The model has more than ${maxImportNodes} nodes.`
    : `The model has more than ${maxImportEdges} edges.`;
}

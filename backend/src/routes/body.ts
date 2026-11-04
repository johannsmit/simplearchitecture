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

/** The 413 message when a JGF body has more nodes or edges than an import allows, or undefined. */
export function jgfTooLarge(request: FastifyRequest): string | undefined {
  const counts = countJgf(request.body);
  if (counts.nodes <= maxImportNodes && counts.edges <= maxImportEdges) return undefined;
  request.log.info({ nodes: counts.nodes, edges: counts.edges }, 'JGF import too large');
  return counts.nodes > maxImportNodes
    ? `The model has more than ${maxImportNodes} nodes.`
    : `The model has more than ${maxImportEdges} edges.`;
}

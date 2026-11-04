import {
  logoMediaTypes,
  logoTooLargeMessage,
  logoTypeMessage,
  maxLogoBytes,
  type ApiError,
  type Branding,
} from '@simplearchitecture/shared';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from 'fastify';
import {
  BrandingUnavailableError,
  LogoTooLargeError,
  LogoTypeError,
  type BrandingAuditAction,
  type BrandingService,
} from '../branding/branding-service.js';
import { errorBody } from '../errors.js';
import { requireMediaType } from './body.js';
import { actor, refused } from './editing.js';

const admin = { access: { space: 'admin' } } as const;
const everyone = { access: 'public' } as const;

/** A year: the logo URL changes with the version. */
const longCache = 'public, max-age=31536000, immutable';
/**
 * The logo response on its own (opened directly, it is a document): nothing may run or load,
 * whatever the bytes hold.
 */
const logoPolicy = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";

const jsonOnly = requireMediaType(['application/json'], 'Send the colours as application/json');
const imageOnly = requireMediaType(logoMediaTypes, logoTypeMessage);

/** 413 before the body is read when its declared length is over the cap. */
async function logoSizeCheck(request: FastifyRequest, reply: FastifyReply) {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > maxLogoBytes) {
    return reply.code(413).send(errorBody(413, logoTooLargeMessage));
  }
}

function brandingRefused(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof BrandingUnavailableError) {
    return reply.code(501).send(errorBody(501, error.message));
  }
  if (error instanceof LogoTypeError) return reply.code(415).send(errorBody(415, error.message));
  if (error instanceof LogoTooLargeError) {
    return reply.code(413).send(errorBody(413, error.message));
  }
  return refused(reply, error);
}

/**
 * Logs a stored change (a new version; an unchanged result keeps the version sent). Who and what
 * only: never colours or bytes.
 */
function auditLog(
  request: FastifyRequest,
  audit: BrandingAuditAction,
  result: Branding,
  sent: unknown,
): void {
  if (String(result.version) === String(sent)) return;
  request.log.info({ audit, userId: actor(request).id }, audit.replaceAll('-', ' '));
}

const sentVersion = (input: unknown): unknown =>
  typeof input === 'object' && input !== null
    ? (input as { version?: unknown }).version
    : undefined;

/**
 * Branding: the colours and logo are public (the signed-out page shows them); changing them is
 * Admin only. The rules are in BrandingService; these routes only translate. The version goes in
 * the PUT body for the colours and in the query (`?version=N`) for the logo and the reset.
 */
export function brandingRoutes(
  service: BrandingService,
  uploadLimit: onRequestAsyncHookHandler,
): FastifyPluginAsync {
  return async (app) => {
    // The logo arrives as raw bytes, in this plugin only.
    app.addContentTypeParser(
      [...logoMediaTypes],
      { parseAs: 'buffer', bodyLimit: maxLogoBytes },
      (_request, body, done) => {
        done(null, body);
      },
    );

    app.get<{ Reply: Branding }>('/api/branding', { config: everyone }, async (_request, reply) => {
      void reply.header('cache-control', 'no-cache');
      return service.get();
    });

    app.get<{ Querystring: { v?: unknown } }>(
      '/api/branding/logo',
      { config: everyone },
      async (request, reply) => {
        const logo = await service.getLogo();
        if (logo === undefined) return reply.code(404).send(errorBody(404, 'No logo'));
        const current = request.query.v === String(logo.version);
        return reply
          .header('content-type', logo.type)
          .header('x-content-type-options', 'nosniff')
          .header('content-disposition', 'inline')
          .header('content-security-policy', logoPolicy)
          .header('cache-control', current ? longCache : 'no-cache')
          .send(Buffer.from(logo.bytes.buffer, logo.bytes.byteOffset, logo.bytes.byteLength));
      },
    );

    app.put<{ Reply: Branding | ApiError }>(
      '/api/admin/branding',
      { config: admin, bodyLimit: 16 * 1024, onRequest: jsonOnly },
      async (request, reply) => {
        try {
          const result = await service.setColours(request.body, actor(request));
          auditLog(request, 'branding-colours-changed', result, sentVersion(request.body));
          return result;
        } catch (error) {
          return brandingRefused(reply, error);
        }
      },
    );

    app.delete<{ Querystring: Record<string, unknown>; Reply: Branding | ApiError }>(
      '/api/admin/branding',
      { config: admin },
      async (request, reply) => {
        try {
          const result = await service.reset(request.query, actor(request));
          auditLog(request, 'branding-reset', result, request.query.version);
          return result;
        } catch (error) {
          return brandingRefused(reply, error);
        }
      },
    );

    app.put<{ Querystring: Record<string, unknown>; Reply: Branding | ApiError }>(
      '/api/admin/branding/logo',
      {
        config: admin,
        bodyLimit: maxLogoBytes,
        onRequest: [uploadLimit, imageOnly, logoSizeCheck],
      },
      async (request, reply) => {
        try {
          const body = request.body;
          if (!Buffer.isBuffer(body)) throw new LogoTypeError();
          const result = await service.setLogo(
            body,
            request.headers['content-type'],
            request.query,
            actor(request),
          );
          auditLog(request, 'branding-logo-set', result, request.query.version);
          return result;
        } catch (error) {
          return brandingRefused(reply, error);
        }
      },
    );

    app.delete<{ Querystring: Record<string, unknown>; Reply: Branding | ApiError }>(
      '/api/admin/branding/logo',
      { config: admin },
      async (request, reply) => {
        try {
          const result = await service.removeLogo(request.query, actor(request));
          auditLog(request, 'branding-logo-removed', result, request.query.version);
          return result;
        } catch (error) {
          return brandingRefused(reply, error);
        }
      },
    );
  };
}

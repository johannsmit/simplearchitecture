import {
  defaultProductTitle,
  logoMediaTypes,
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
  imageRules,
  LogoTooLargeError,
  LogoTypeError,
  type BrandImage,
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
const titleJsonOnly = requireMediaType(
  ['application/json'],
  'Send the product title as application/json',
);

/** 413 before the body is read when its declared length is over the cap. */
function sizeCheck(message: string) {
  return async function imageSizeCheck(request: FastifyRequest, reply: FastifyReply) {
    const length = Number(request.headers['content-length']);
    if (Number.isFinite(length) && length > maxLogoBytes) {
      return reply.code(413).send(errorBody(413, message));
    }
  };
}

/** The built-in icons, as the web app's build used to list them (in frontend/public). */
const builtInIcons = [
  { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
  { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
  { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
];
const builtInMaskable = {
  src: '/pwa-512x512.png',
  sizes: '512x512',
  type: 'image/png',
  purpose: 'maskable',
};

/**
 * The web app manifest, with the product title and the app icon when they are set. The title is
 * plain text in JSON (Fastify escapes it); the icon is only ever the versioned icon route.
 */
export function webAppManifest(branding: Branding): Record<string, unknown> {
  return {
    name: branding.title ?? defaultProductTitle,
    short_name: branding.title ?? 'SimpleArch',
    description: 'Model and explore your IT architecture.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    theme_color: '#1f4e79',
    background_color: '#ffffff',
    lang: 'en',
    // No id, as the build's manifest had none: the browser takes start_url, so an app already
    // installed stays the same app.
    icons:
      branding.iconUrl === null
        ? [...builtInIcons, builtInMaskable]
        : [
            { src: branding.iconUrl, sizes: '512x512', type: 'image/png', purpose: 'any' },
            builtInMaskable,
          ],
  };
}

function brandingRefused(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof LogoTypeError) return reply.code(415).send(errorBody(415, error.message));
  if (error instanceof LogoTooLargeError) {
    return reply.code(413).send(errorBody(413, error.message));
  }
  return refused(reply, error);
}

/**
 * Logs a stored change (a new version; an unchanged result keeps the version sent). Who and what
 * only: never a title, colours or bytes.
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
 * Branding: the title, colours, logos and icon are public (the signed-out page shows them, and the
 * browser asks for the manifest and icon without a session); changing them is Admin only. The
 * rules are in BrandingService; these routes only translate. The version goes in the PUT body for
 * the colours and the title, and in the query (`?version=N`) for the images and the reset.
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

    for (const image of ['logo', 'darkLogo', 'icon'] as const) {
      app.get<{ Querystring: { v?: unknown } }>(
        `/api/branding/${imageRules[image].path}`,
        { config: everyone },
        async (request, reply) => {
          const stored = await service.getImage(image);
          if (stored === undefined) return reply.code(404).send(errorBody(404, 'No image'));
          const current = request.query.v === String(stored.version);
          return reply
            .header('content-type', stored.type)
            .header('x-content-type-options', 'nosniff')
            .header('content-disposition', 'inline')
            .header('content-security-policy', logoPolicy)
            .header('cache-control', current ? longCache : 'no-cache')
            .send(
              Buffer.from(stored.bytes.buffer, stored.bytes.byteOffset, stored.bytes.byteLength),
            );
        },
      );
    }

    // The browser asks for it without a session (and an installed app keeps asking): public.
    app.get('/manifest.webmanifest', { config: everyone }, async (_request, reply) => {
      const branding = await service.get();
      return reply
        .header('content-type', 'application/manifest+json; charset=utf-8')
        .header('cache-control', 'no-cache')
        .send(JSON.stringify(webAppManifest(branding)));
    });

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

    app.put<{ Reply: Branding | ApiError }>(
      '/api/admin/branding/title',
      { config: admin, bodyLimit: 16 * 1024, onRequest: titleJsonOnly },
      async (request, reply) => {
        try {
          const result = await service.setTitle(request.body, actor(request));
          const audit = result.title === null ? 'branding-title-removed' : 'branding-title-set';
          auditLog(request, audit, result, sentVersion(request.body));
          return result;
        } catch (error) {
          return brandingRefused(reply, error);
        }
      },
    );

    for (const image of ['logo', 'darkLogo', 'icon'] satisfies BrandImage[]) {
      const rules = imageRules[image];
      const url = `/api/admin/branding/${rules.path}`;
      app.put<{ Querystring: Record<string, unknown>; Reply: Branding | ApiError }>(
        url,
        {
          config: admin,
          bodyLimit: maxLogoBytes,
          onRequest: [
            uploadLimit,
            requireMediaType(rules.types, rules.typeMessage),
            sizeCheck(rules.tooLargeMessage),
          ],
        },
        async (request, reply) => {
          try {
            const body = request.body;
            if (!Buffer.isBuffer(body)) throw new LogoTypeError(rules.typeMessage);
            const result = await service.setImage(
              image,
              body,
              request.headers['content-type'],
              request.query,
              actor(request),
            );
            auditLog(request, `branding-${rules.path}-set`, result, request.query.version);
            return result;
          } catch (error) {
            return brandingRefused(reply, error);
          }
        },
      );

      app.delete<{ Querystring: Record<string, unknown>; Reply: Branding | ApiError }>(
        url,
        { config: admin },
        async (request, reply) => {
          try {
            const result = await service.removeImage(image, request.query, actor(request));
            auditLog(request, `branding-${rules.path}-removed`, result, request.query.version);
            return result;
          } catch (error) {
            return brandingRefused(reply, error);
          }
        },
      );
    }
  };
}

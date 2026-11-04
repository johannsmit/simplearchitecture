import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { Fields, OAuthService } from '../mcp-auth/oauth-service.js';
import { registrationBodyLimit, tokenBodyLimit } from '../mcp-auth/rules.js';
import { rateLimit, RateLimiter, signInBusyPath } from '../rate-limit.js';
import { requireMediaType } from './body.js';

/** Per client address per minute. Claude's calls come from a few shared addresses: room for many. */
export const registrationsPerMinute = 20;
export const authorizationsPerMinute = 30;
export const tokenRequestsPerMinute = 60;

export interface OAuthRouteOptions {
  service: OAuthService;
  webOrigin: string;
  now: () => number;
}

/** The consent page in the web app (see routes/agents.ts for its API). */
export const consentPagePath = '/agents/connect';

const formType = 'application/x-www-form-urlencoded';

/** A form body as fields, a repeated one as a list (the service refuses those). */
function formFields(body: string): Record<string, string | string[]> {
  const fields: Record<string, string | string[]> = {};
  for (const [name, value] of new URLSearchParams(body)) {
    const before = Object.hasOwn(fields, name) ? fields[name] : undefined;
    fields[name] = before === undefined ? value : [...[before].flat(), value];
  }
  return fields;
}

function sendToken(reply: FastifyReply, result: { status: number; body: object }): FastifyReply {
  void reply.header('cache-control', 'no-store').header('pragma', 'no-cache');
  if (result.status === 401) void reply.header('www-authenticate', 'Basic realm="oauth"');
  return reply.code(result.status).send(result.body);
}

/**
 * The OAuth endpoints AI agents use (see mcp-auth/oauth-service.ts for the rules): the two
 * metadata documents, registration, authorize, token and revocation.
 */
export function oauthRoutes({ service, webOrigin, now }: OAuthRouteOptions): FastifyPluginAsync {
  const perAddress = (limit: number) =>
    rateLimit(new RateLimiter(limit, 60_000, now), (request) => request.ip, {
      message: 'Too many requests. Wait a minute and try again.',
    });
  const registrationLimit = perAddress(registrationsPerMinute);
  const tokenLimit = perAddress(tokenRequestsPerMinute);
  const revokeLimit = perAddress(tokenRequestsPerMinute);
  const authorizeLimit = rateLimit(
    new RateLimiter(authorizationsPerMinute, 60_000, now),
    (request) => request.ip,
    { redirect: `${webOrigin}${signInBusyPath}` },
  );

  return async (app) => {
    app.addContentTypeParser(
      formType,
      { parseAs: 'string', bodyLimit: tokenBodyLimit },
      (_request, body, done) => {
        done(null, formFields(body as string));
      },
    );

    const metadataCache = 'public, max-age=300';
    const publicAccess = { access: 'public' } as const;
    app.get(
      '/.well-known/oauth-authorization-server',
      { config: publicAccess },
      async (_request, reply) =>
        reply.header('cache-control', metadataCache).send(service.authorizationServerMetadata()),
    );
    // The path-suffixed form for the endpoint `/mcp` (RFC 9728 section 3.1), which clients try
    // first, and the plain one.
    for (const url of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      app.get(url, { config: publicAccess }, async (_request, reply) =>
        reply.header('cache-control', metadataCache).send(service.protectedResourceMetadata()),
      );
    }

    app.post(
      '/oauth/register',
      {
        config: { access: 'oauth' },
        bodyLimit: registrationBodyLimit,
        onRequest: [
          registrationLimit,
          requireMediaType(['application/json'], 'Send the registration as application/json'),
        ],
      },
      async (request, reply) => {
        const result = await service.register(request.body);
        void reply.header('cache-control', 'no-store');
        if (!result.ok) return reply.code(result.status).send(result.body);
        return reply.code(201).send(result.client);
      },
    );

    app.get(
      '/oauth/authorize',
      { config: { access: 'oauth' }, onRequest: authorizeLimit },
      async (request, reply) => {
        const check = await service.checkAuthorization(request.query as Fields);
        if (check.kind === 'invalid') {
          // Never to the agent's address before a user has chosen it: the page says it isn't valid.
          request.log.info({ error: check.error }, 'mcp authorize refused');
          return reply.redirect(`${consentPagePath}?error=invalid`, 302);
        }
        // Held for the consent page. Signed out: the usual sign-in first, which comes back there.
        const id = await service.holdAuthorization(check.request);
        const page = `${consentPagePath}?request=${encodeURIComponent(id)}`;
        if (request.session === null) {
          return reply.redirect(`/auth/login?returnTo=${encodeURIComponent(page)}`, 302);
        }
        return reply.redirect(page, 302);
      },
    );

    app.post(
      '/oauth/token',
      {
        config: { access: 'oauth' },
        bodyLimit: tokenBodyLimit,
        onRequest: [
          tokenLimit,
          requireMediaType([formType], `Send the token request as ${formType}`),
        ],
      },
      async (request, reply) =>
        sendToken(
          reply,
          await service.token(request.body as Fields, request.headers.authorization !== undefined),
        ),
    );

    app.post(
      '/oauth/revoke',
      {
        config: { access: 'oauth' },
        bodyLimit: tokenBodyLimit,
        onRequest: [
          revokeLimit,
          requireMediaType([formType], `Send the revocation as ${formType}`),
        ],
      },
      async (request, reply) =>
        sendToken(
          reply,
          await service.revoke(request.body as Fields, request.headers.authorization !== undefined),
        ),
    );
  };
}

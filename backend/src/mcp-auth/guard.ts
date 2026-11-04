import { spacesForRoles } from '@simplearchitecture/shared';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import { RateLimiter } from '../rate-limit.js';
import type { OAuthService } from './oauth-service.js';

/** Refused tokens per client address per minute, before more are even looked up. */
export const refusedTokensPerMinute = 30;

/**
 * The access check on the MCP endpoint: only the app's own access tokens, sent as
 * `Authorization: Bearer`. The session cookie is never read here. No token, or one that is
 * unknown, expired, revoked or for another address: 401 with the challenge that points the
 * client to the protected resource metadata (RFC 9728). A token whose roles don't open Viewing:
 * 403.
 */
export function mcpTokenGuard(service: OAuthService, now: () => number): onRequestAsyncHookHandler {
  const refusals = new RateLimiter(refusedTokensPerMinute, 60_000, now);
  const metadata = service.addresses.resourceMetadata;

  const challenge = (reply: FastifyReply, error?: string): FastifyReply =>
    reply
      .code(401)
      .header(
        'www-authenticate',
        error === undefined
          ? `Bearer resource_metadata="${metadata}"`
          : `Bearer error="${error}", resource_metadata="${metadata}"`,
      )
      .send({
        error: error ?? 'unauthorized',
        error_description:
          error === undefined ? 'Sign in required.' : 'The access token is not valid.',
      });

  return async function mcpGuard(request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    if (header === undefined) return challenge(reply);
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
    const auth = match?.[1] === undefined ? undefined : await service.verifyAccessToken(match[1]);
    if (auth === undefined) {
      if (!refusals.allow(request.ip)) {
        request.log.warn('mcp token refusals over the limit');
        return reply.code(429).header('retry-after', '60').send({
          error: 'too_many_requests',
          error_description: 'Too many refused tokens. Wait a minute.',
        });
      }
      request.log.info('mcp access token refused');
      return challenge(reply, 'invalid_token');
    }
    if (!spacesForRoles(auth.roles).includes('viewing')) {
      request.log.info({ userId: auth.userId }, 'mcp access refused: no role');
      return reply.code(403).send({
        error: 'forbidden',
        error_description: 'You need the Viewer role or higher.',
      });
    }
    request.mcpAuth = auth;
  };
}

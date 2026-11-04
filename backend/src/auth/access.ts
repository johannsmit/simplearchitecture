import { spacesForRoles, type ApiError, type Role, type Space } from '@simplearchitecture/shared';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from 'fastify';
import type { Session } from './sessions.js';

/**
 * Who may call a route. Every route must declare one (deny by default):
 * - 'public': anyone, signed in or not (health, the /auth endpoints)
 * - 'authenticated': any signed-in user, whatever their roles
 * - { space }: signed-in users whose roles open that space
 * - 'oauth': the OAuth endpoints for AI agents (see mcp-auth/). Agents call them without a
 *   browser, so there is no Origin to check; an Origin that is sent must be the app's own. The
 *   session is loaded when there is one (the browser's sign-in on the authorize page), never
 *   required. Each route checks what it needs.
 * - 'mcp': the MCP endpoint. Only the app's own access tokens (`Authorization: Bearer`), never the
 *   session cookie; an Origin that is sent must be the app's own.
 */
export type Access = 'public' | 'authenticated' | { space: Space } | 'oauth' | 'mcp';

/** Who an MCP request is for, from its access token: the user and roles of their sign-in. */
export interface McpAuth {
  userId: string;
  roles: Role[];
  clientId: string;
  connectionId: string;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    /** The live session on non-public routes, or `null` when signed out. Always `null` on public routes. */
    session: Session | null;
    /** On the MCP endpoint only: whom its access token is for. `null` everywhere else. */
    mcpAuth: McpAuth | null;
  }
}

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

function refuse(reply: FastifyReply, statusCode: 401 | 403, message: string): FastifyReply {
  const body: ApiError = {
    statusCode,
    error: statusCode === 401 ? 'Unauthorized' : 'Forbidden',
    message,
  };
  return reply.code(statusCode).send(body);
}

/** Route guard: 401 when signed out, 403 when the user's roles don't allow the route. */
export function requireAccess(access: Exclude<Access, 'oauth' | 'mcp'>): onRequestAsyncHookHandler {
  return async function accessGuard(request: FastifyRequest, reply: FastifyReply) {
    if (access === 'public') return;
    const session = request.session;
    if (!session) return refuse(reply, 401, 'Sign in required');
    if (access === 'authenticated') return;
    if (typeof access === 'object' && spacesForRoles(session.user.roles).includes(access.space)) {
      return;
    }
    return refuse(reply, 403, 'You do not have access to this resource');
  };
}

/**
 * CSRF defence for state-changing requests: the Origin header must be the web app's origin.
 * SameSite=Lax already keeps the cookie off cross-site POSTs; this also stops other same-site
 * origins (e.g. another localhost port) and requests without an Origin.
 */
export function requireSameOrigin(webOrigin: string): onRequestAsyncHookHandler {
  return async function originCheck(request: FastifyRequest, reply: FastifyReply) {
    if (safeMethods.has(request.method)) return;
    if (request.headers.origin !== webOrigin) {
      request.log.warn({ origin: request.headers.origin }, 'cross-origin request refused');
      return refuse(reply, 403, 'Request origin not allowed');
    }
  };
}

/**
 * For endpoints that agents call without a browser: no Origin is fine, but one that is sent must
 * be the web app's (a page on another site, or DNS rebinding, is refused).
 */
export function refuseForeignOrigin(webOrigin: string): onRequestAsyncHookHandler {
  return async function foreignOriginCheck(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin;
    if (origin === undefined || origin === webOrigin) return;
    request.log.warn({ origin }, 'cross-origin request refused');
    return refuse(reply, 403, 'Request origin not allowed');
  };
}

/**
 * Adds the CSRF check and the access guard to every route registered after this call. A route
 * without a `config.access` declaration fails at registration, so nothing is served by accident.
 * `loadSession` runs on non-public routes only, so public requests (e.g. /api/health) never extend
 * a session's idle timeout. The guard comes before a route's own hooks (rate limits, body checks),
 * so a blocked request costs nothing. `mcpGuard` checks the access token on 'mcp' routes; without
 * one, such a route fails at registration.
 */
export function enforceAccessOnAllRoutes(
  app: FastifyInstance,
  webOrigin: string,
  loadSession: onRequestAsyncHookHandler,
  mcpGuard?: onRequestAsyncHookHandler,
): void {
  const originCheck = requireSameOrigin(webOrigin);
  const foreignOriginCheck = refuseForeignOrigin(webOrigin);
  app.addHook('onRoute', (routeOptions) => {
    const access = routeOptions.config?.access;
    if (access === undefined) {
      throw new Error(
        `Route ${String(routeOptions.method)} ${routeOptions.url} has no access rule (config.access)`,
      );
    }
    const existing = routeOptions.onRequest;
    const own = existing === undefined ? [] : Array.isArray(existing) ? existing : [existing];
    let guards: onRequestAsyncHookHandler[];
    if (access === 'mcp') {
      if (mcpGuard === undefined) {
        throw new Error(`Route ${routeOptions.url} needs the MCP token check, which isn't set up`);
      }
      guards = [foreignOriginCheck, mcpGuard];
    } else if (access === 'public') guards = [originCheck];
    else if (access === 'oauth') guards = [foreignOriginCheck, loadSession];
    else guards = [originCheck, loadSession, requireAccess(access)];
    // A new array: Fastify copies GET options for the implicit HEAD route, so never mutate.
    routeOptions.onRequest = [...guards, ...own];
  });
}

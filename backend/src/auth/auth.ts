import cookie from '@fastify/cookie';
import { roles, type ApiError, type Role } from '@simplearchitecture/shared';
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  onRequestAsyncHookHandler,
} from 'fastify';
import type { Config } from '../config.js';
import { escapeHtml } from '../html.js';
import { rateLimit, RateLimiter, signInBusyPath, signInsPerMinute } from '../rate-limit.js';
import { enforceAccessOnAllRoutes } from './access.js';
import {
  OidcProviderRefused,
  type IdTokenClaims,
  type LoginChecks,
  type OidcClient,
} from './oidc.js';
import { safeReturnPath } from './return-to.js';
import { Sealer } from './seal.js';
import type { SessionStore, SessionUser } from './sessions.js';

const loginStateMaxAgeSeconds = 10 * 60;

export interface AuthDependencies {
  config: Config;
  oidc: OidcClient;
  sessions: SessionStore;
  now: () => number;
  /** Checks the access token on the MCP endpoint (see mcp-auth/). Without it, there is none. */
  mcpGuard?: onRequestAsyncHookHandler;
}

interface CookieNames {
  session: string;
  login: string;
}

/**
 * The `__Host-` prefix (Secure, Path=/, no Domain: the cookie can't be set or shadowed by
 * another host) needs Secure. Development runs on plain http://localhost, where Safari
 * refuses Secure cookies, so there the cookies are unprefixed and not Secure.
 */
export function cookieNames(secure: boolean): CookieNames {
  return secure
    ? { session: '__Host-sa_session', login: '__Host-sa_login' }
    : { session: 'sa_session', login: 'sa_login' };
}

/** The claim value that gives each role (OIDC_ROLE_* in the configuration). */
export function roleClaimValues(config: Config): Record<Role, string> {
  return {
    Admin: config.OIDC_ROLE_ADMIN,
    Modeller: config.OIDC_ROLE_MODELLER,
    Viewer: config.OIDC_ROLE_VIEWER,
  };
}

function userFromClaims(
  claims: IdTokenClaims,
  rolesClaim: string,
  roleValues: Record<Role, string>,
): SessionUser {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined;
  // One top-level claim by its exact name, a list or a single text (never split). Own properties
  // only, so a name like `constructor` finds nothing. Anything else matches no role.
  const value = Object.hasOwn(claims, rolesClaim) ? claims[rolesClaim] : undefined;
  const claimed: unknown[] = Array.isArray(value) ? value : [value];
  const email = text(claims.email) ?? text(claims.preferred_username) ?? null;
  return {
    id: text(claims.oid) ?? claims.sub,
    name: text(claims.name) ?? email ?? 'Signed-in user',
    email,
    // Known roles only, in a stable order. Unknown roles are ignored (no access).
    roles: roles.filter((role) => claimed.includes(roleValues[role])),
  };
}

type LoginState = LoginChecks & { expiresAt: number; returnTo?: unknown };

function isLoginState(value: unknown): value is LoginState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.codeVerifier === 'string' &&
    typeof v.state === 'string' &&
    typeof v.nonce === 'string' &&
    typeof v.expiresAt === 'number'
  );
}

/** Names openid-client errors in logs without dumping response bodies or claims. */
function describeError(error: unknown): { name: string; code?: unknown; message: string } {
  if (error instanceof Error) {
    return { name: error.name, code: (error as { code?: unknown }).code, message: error.message };
  }
  return { name: 'UnknownError', message: 'non-Error thrown' };
}

/**
 * The answer to the sign-out form when the provider has an end-session address. Browsers apply
 * form-action to the redirects of a form post, and the address's origin is only known after
 * discovery, so a 303 there could be blocked by the page's policy. Leaving from this page is a new
 * navigation, which form-action doesn't cover. No script: the policy allows none inline, and the
 * link is for browsers that block automatic refresh.
 */
function leavingForEndSessionPage(endSession: URL): string {
  const address = escapeHtml(endSession.href);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light">
<meta http-equiv="refresh" content="0;url=${address}">
<title>Signing out</title>
</head>
<body><p>Signing out. <a href="${address}">Continue</a></p></body>
</html>
`;
}

/**
 * Sign-in through the backend (OIDC authorization code flow with PKCE) and server-side sessions.
 * Registers on the root instance so its hooks apply to every route registered afterwards.
 */
export async function registerAuth(app: FastifyInstance, deps: AuthDependencies): Promise<void> {
  const { config, oidc, sessions, now } = deps;
  const names = cookieNames(config.COOKIE_SECURE);
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    path: '/',
  } as const;
  const loginSealer = new Sealer(config.SESSION_SECRET, 'login-state');
  const roleValues = roleClaimValues(config);
  const webHome = `${config.WEB_ORIGIN}/`;
  // Fixed failure page on the web origin; nothing from the request goes into a redirect.
  const signInFailed = `${config.WEB_ORIGIN}/?signin=failed`;
  // Each start costs a discovery call and a sealed cookie, and each callback a call to the provider's
  // token endpoint: both are limited per client address, each with its own count (one sign-in
  // uses one of each). The address is the client's behind the configured proxies (TRUST_PROXY).
  const perAddress = () =>
    rateLimit(
      new RateLimiter(signInsPerMinute, 60_000, now),
      (request) => request.ip,
      // Sign-in is a browser navigation: a fixed page that explains, not a JSON body.
      { redirect: `${config.WEB_ORIGIN}${signInBusyPath}` },
    );
  const signInLimit = perAddress();
  const callbackLimit = perAddress();

  await app.register(cookie);

  // Loads (and extends) the session on non-public routes. An unknown or expired id is cleared.
  app.decorateRequest('session', null);
  app.decorateRequest('mcpAuth', null);
  const loadSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const id = request.cookies[names.session];
    if (id === undefined) return;
    const session = await sessions.touch(id);
    if (session) {
      request.session = session;
    } else {
      reply.clearCookie(names.session, cookieOptions);
    }
  };

  enforceAccessOnAllRoutes(app, config.WEB_ORIGIN, loadSession, deps.mcpGuard);

  // Nothing user-specific may be cached: `no-store` on every /auth, /oauth and /mcp response and
  // every non-public /api response (including 401, 403 and 404), unless a route sets its own.
  app.addHook('onSend', async (request, reply) => {
    if (reply.hasHeader('cache-control')) return;
    const isAuth = /^\/(auth|oauth|mcp)(\/|\?|$)/.test(request.url);
    const isApi = /^\/api(\/|\?|$)/.test(request.url);
    const isPublic = request.routeOptions.config.access === 'public';
    if (isAuth || (isApi && !isPublic)) reply.header('cache-control', 'no-store');
  });

  await app.register(async (auth) => {
    // A sign-out form posts an empty urlencoded body. Accept and ignore it, here only.
    auth.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_request, _body, done) => {
        done(null, undefined);
      },
    );
    auth.get<{ Querystring: { returnTo?: unknown } }>(
      '/auth/login',
      { config: { access: 'public' }, onRequest: signInLimit },
      async (request, reply) => {
        let start: Awaited<ReturnType<OidcClient['startLogin']>>;
        try {
          start = await oidc.startLogin();
        } catch (error) {
          request.log.error(
            { reason: describeError(error) },
            error instanceof OidcProviderRefused
              ? 'OIDC provider refused'
              : 'OIDC discovery failed',
          );
          const body: ApiError = {
            statusCode: 502,
            error: 'Bad Gateway',
            message: 'Sign-in is unavailable. Try again later.',
          };
          return reply.code(502).send(body);
        }
        // Where to go back to afterwards travels in the sealed login-state cookie only: never in
        // the session, and never to the provider.
        const sealed = loginSealer.seal(
          {
            ...start.checks,
            expiresAt: now() + loginStateMaxAgeSeconds * 1000,
            returnTo: safeReturnPath(request.query.returnTo),
          },
          names.login,
        );
        reply.setCookie(names.login, sealed, { ...cookieOptions, maxAge: loginStateMaxAgeSeconds });
        return reply.redirect(start.url.href, 302);
      },
    );

    auth.get(
      '/auth/callback',
      { config: { access: 'public' }, onRequest: callbackLimit },
      async (request, reply) => {
        const sealed = request.cookies[names.login];
        // The login state is single use.
        reply.clearCookie(names.login, cookieOptions);
        const state = sealed === undefined ? undefined : loginSealer.unseal(sealed, names.login);
        if (!isLoginState(state) || state.expiresAt <= now()) {
          request.log.warn('sign-in rejected: login state missing, invalid or expired');
          return reply.redirect(signInFailed, 302);
        }

        const queryStart = request.url.indexOf('?');
        const search = queryStart === -1 ? '' : request.url.slice(queryStart);
        let claims: IdTokenClaims;
        try {
          claims = await oidc.finishLogin(search, state);
        } catch (error) {
          request.log.warn({ reason: describeError(error) }, 'sign-in rejected');
          return reply.redirect(signInFailed, 302);
        }

        // Session fixation defence: drop any session the browser brought, then issue a fresh id.
        const previous = request.cookies[names.session];
        if (previous !== undefined) await sessions.destroy(previous);
        const user = userFromClaims(claims, config.OIDC_ROLES_CLAIM, roleValues);
        const session = await sessions.create(user);
        reply.setCookie(names.session, session.id, {
          ...cookieOptions,
          maxAge: Math.floor(sessions.timeouts.absoluteMs / 1000),
        });
        request.log.info({ userId: user.id, roles: user.roles }, 'signed in');
        // Checked again: the cookie is sealed, but a path that isn't allowed never becomes a redirect.
        return reply.redirect(`${config.WEB_ORIGIN}${safeReturnPath(state.returnTo)}`, 302);
      },
    );

    auth.post('/auth/logout', { config: { access: 'public' } }, async (request, reply) => {
      const id = request.cookies[names.session];
      const ended = id === undefined ? undefined : await sessions.destroy(id);
      reply.clearCookie(names.session, cookieOptions);
      if (ended) request.log.info({ userId: ended.user.id }, 'signed out');

      let endSession: URL | null = null;
      try {
        endSession = await oidc.logoutUrl();
      } catch (error) {
        request.log.warn({ reason: describeError(error) }, 'end-session address unavailable');
      }
      // No address (a provider need not have one) or none known: the app's own session has ended.
      if (endSession === null) return reply.redirect(webHome, 303);
      return reply.type('text/html; charset=utf-8').send(leavingForEndSessionPage(endSession));
    });
  });
}

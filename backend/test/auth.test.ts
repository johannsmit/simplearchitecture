import type { ApiError, MeResponse, SpacePingResponse } from '@simplearchitecture/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppOptions } from '../src/app.js';
import type { Config } from '../src/config.js';
import {
  buildTestApp,
  captureLogs,
  clientId,
  idpOptions,
  leavesFor,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';

let idp: OAuth2Server;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  idp = await startMockIdp();
});

afterAll(async () => {
  await idp.stop();
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  idp.service.removeAllListeners('beforeResponse');
  await app?.close();
  app = undefined;
});

async function start(overrides: Partial<Config> = {}, options: AppOptions = {}) {
  app = await buildTestApp(overrides, idpOptions(idp, options));
  return app;
}

function get(target: FastifyInstance, url: string, cookie?: string) {
  return target.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
}

function logout(target: FastifyInstance, headers: Record<string, string>) {
  return target.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: '',
  });
}

const signInFailed = `${webOrigin}/?signin=failed`;

describe('GET /auth/login', () => {
  it('redirects to the provider with PKCE (S256), state and nonce', async () => {
    const target = await start();
    const res = await get(target, '/auth/login');

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(`${idp.issuer.url ?? ''}/authorize`);
    const params = location.searchParams;
    expect(params.get('response_type')).toBe('code');
    expect(params.get('response_mode')).toBe('query');
    expect(params.get('client_id')).toBe(clientId);
    expect(params.get('redirect_uri')).toBe('http://localhost:3000/auth/callback');
    expect(params.get('scope')?.split(' ')).toContain('openid');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.get('state')?.length).toBeGreaterThanOrEqual(32);
    expect(params.get('nonce')?.length).toBeGreaterThanOrEqual(32);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('keeps the login state in a short-lived, httpOnly, SameSite=Lax cookie that is sealed', async () => {
    const target = await start();
    const res = await get(target, '/auth/login');
    const params = new URL(res.headers.location as string).searchParams;

    const cookie = res.cookies.find((c) => c.name === '__Host-sa_login');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: true, path: '/' });
    expect(cookie?.maxAge).toBe(600);
    expect(cookie?.domain).toBeUndefined();
    // Encrypted: neither state nor nonce is readable from the cookie.
    const value = Buffer.from(cookie?.value ?? '', 'base64url').toString('latin1');
    expect(value).not.toContain(params.get('state'));
    expect(value).not.toContain(params.get('nonce'));
  });

  it('uses fresh state, nonce and PKCE challenge for every login', async () => {
    const target = await start();
    const a = new URL((await get(target, '/auth/login')).headers.location as string).searchParams;
    const b = new URL((await get(target, '/auth/login')).headers.location as string).searchParams;

    for (const name of ['state', 'nonce', 'code_challenge']) {
      expect(a.get(name)).not.toBe(b.get(name));
    }
  });

  it('answers 502 without details when the provider cannot be reached', async () => {
    app = await buildTestApp(
      {},
      { oidcIssuer: 'http://127.0.0.1:9/unreachable', allowInsecureOidcRequests: true },
    );
    const res = await get(app, '/auth/login');

    expect(res.statusCode).toBe(502);
    expect(res.json<ApiError>().message).toBe('Sign-in is unavailable. Try again later.');
    expect(res.cookies).toHaveLength(0);
  });
});

describe('GET /auth/callback', () => {
  it('signs in: sets the session cookie with the right flags and redirects to WEB_ORIGIN', async () => {
    const target = await start();
    const { callback, sessionCookie } = await signIn(target);

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(`${webOrigin}/`);
    const session = callback.cookies.find((c) => c.name === '__Host-sa_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', secure: true, path: '/' });
    expect(session?.domain).toBeUndefined();
    expect(session?.maxAge).toBe(8 * 60 * 60);
    expect(session?.value).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 random bits
    // The single-use login state is cleared.
    const login = callback.cookies.find((c) => c.name === '__Host-sa_login');
    expect(login?.value).toBe('');
    expect(sessionCookie).not.toBe('');
  });

  it('uses unprefixed, non-Secure cookies when COOKIE_SECURE is false (plain-HTTP development)', async () => {
    const target = await start({ COOKIE_SECURE: false });
    const { callback, sessionCookie } = await signIn(target);

    const session = callback.cookies.find((c) => c.name === 'sa_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(session?.secure).toBeUndefined();
    expect((await get(target, '/api/me', sessionCookie)).statusCode).toBe(200);
  });

  it.each([
    [
      'a tampered state',
      (url: URL) => {
        url.searchParams.set('state', 'attacker-state');
      },
    ],
    [
      'a missing state',
      (url: URL) => {
        url.searchParams.delete('state');
      },
    ],
    [
      'a tampered code',
      (url: URL) => {
        url.searchParams.set('code', 'attacker-code');
      },
    ],
    [
      'a provider error',
      (url: URL) => {
        url.search = '';
        url.searchParams.set('error', 'access_denied');
      },
    ],
  ])('rejects %s', async (_name, tamper) => {
    const target = await start();
    const { callback, sessionCookie } = await signIn(target, { tamper });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(signInFailed);
    expect(sessionCookie).toBe('');
  });

  it.each([
    ['a wrong nonce', { nonce: 'attacker-nonce' }],
    ['a wrong audience', { aud: 'another-client-id' }],
    ['a wrong issuer', { iss: 'https://idp.example.test/another-tenant' }],
    ['an expired ID token', { exp: Math.floor(Date.now() / 1000) - 600 }],
  ])('rejects an ID token with %s', async (_name, claims) => {
    const target = await start();
    withClaims(idp, claims);
    const { callback, sessionCookie } = await signIn(target);

    expect(callback.headers.location).toBe(signInFailed);
    expect(sessionCookie).toBe('');
  });

  it('rejects an ID token with an invalid signature', async () => {
    const target = await start();
    idp.service.on('beforeResponse', (response: { body: Record<string, unknown> }) => {
      const idToken = response.body.id_token as string;
      const [header, payload] = idToken.split('.');
      response.body.id_token = `${header ?? ''}.${payload ?? ''}.${'A'.repeat(342)}`;
    });
    const { callback, sessionCookie } = await signIn(target);

    expect(callback.headers.location).toBe(signInFailed);
    expect(sessionCookie).toBe('');
  });

  it('rejects a callback without the login cookie, or with a forged one', async () => {
    const target = await start();
    const login = await get(target, '/auth/login');
    const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
    const callbackUrl = new URL(authorize.headers.get('location') ?? '');
    const path = `${callbackUrl.pathname}${callbackUrl.search}`;

    const noCookie = await get(target, path);
    const forged = await get(
      target,
      path,
      '__Host-sa_login=Zm9yZ2VkLWxvZ2luLXN0YXRlLXZhbHVlLWhlcmU',
    );

    for (const res of [noCookie, forged]) {
      expect(res.headers.location).toBe(signInFailed);
      expect(res.cookies.find((c) => c.name === '__Host-sa_session')).toBeUndefined();
    }
  });

  it('rejects login state older than 10 minutes', async () => {
    let time = Date.now();
    const target = await start({}, { now: () => time });
    const login = await get(target, '/auth/login');
    const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
    const callbackUrl = new URL(authorize.headers.get('location') ?? '');
    const loginCookie = login.cookies.find((c) => c.name === '__Host-sa_login');
    time += 10 * 60 * 1000 + 1;

    const res = await get(
      target,
      `${callbackUrl.pathname}${callbackUrl.search}`,
      `__Host-sa_login=${loginCookie?.value ?? ''}`,
    );
    expect(res.headers.location).toBe(signInFailed);
  });

  it('cannot be replayed', async () => {
    const target = await start();
    let replay = '';
    const first = await signIn(target, {
      tamper: (url) => {
        replay = `${url.pathname}${url.search}`;
      },
    });
    const loginCookie = `__Host-sa_login=${first.login.cookies.find((c) => c.name === '__Host-sa_login')?.value ?? ''}`;
    expect(first.sessionCookie).not.toBe('');

    const second = await get(target, replay, loginCookie);
    expect(second.headers.location).toBe(signInFailed);
  });

  it('rotates the session id at sign-in and ends the previous session', async () => {
    const target = await start();
    const first = await signIn(target);
    const second = await signIn(target, { cookies: [first.sessionCookie] });

    expect(second.sessionCookie).not.toBe('');
    expect(second.sessionCookie).not.toBe(first.sessionCookie);
    expect((await get(target, '/api/me', first.sessionCookie)).statusCode).toBe(401);
    expect((await get(target, '/api/me', second.sessionCookie)).statusCode).toBe(200);
  });

  it('never redirects to a user-supplied URL', async () => {
    const target = await start();
    const evil = 'https://evil.example/steal';
    const login = await get(
      target,
      `/auth/login?returnTo=${encodeURIComponent(evil)}&redirect_uri=${encodeURIComponent(evil)}`,
    );
    const params = new URL(login.headers.location as string).searchParams;
    expect(params.get('redirect_uri')).toBe('http://localhost:3000/auth/callback');
    expect(login.headers.location).not.toContain('evil.example');

    const ok = await signIn(target, {
      tamper: (url) => {
        url.searchParams.set('returnTo', evil);
        url.searchParams.set('redirect', evil);
      },
    });
    expect(ok.callback.headers.location).toBe(`${webOrigin}/`);

    const failed = await signIn(target, {
      tamper: (url) => {
        url.searchParams.set('state', 'x');
        url.searchParams.set('returnTo', evil);
      },
    });
    expect(failed.callback.headers.location).toBe(signInFailed);
  });
});

describe('returning after sign-in (returnTo)', () => {
  const login = (returnTo: string) => `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;

  it.each([
    '/viewing',
    '/viewing/models/11111111-1111-4111-8111-111111111111/elements/a%22b%2Fc?depth=2',
    '/admin/models',
    '/modelling',
    '/agents',
    '/agents/connect?request=sa_rq_made-up',
  ])('goes back to %s on the web origin', async (path) => {
    const target = await start();
    const { callback } = await signIn(target, { loginUrl: login(path) });
    expect(callback.headers.location).toBe(`${webOrigin}${path}`);
  });

  it.each([
    'https://evil.example/steal',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\evil.example',
    '/viewing\\..\\..\\evil',
    'javascript:alert(1)',
    'data:text/html,hi',
    'evil.example',
    '/viewing/../../evil.example',
    '/viewing/%2e%2e/%2e%2e/elsewhere',
    '/viewingevil',
    '/admin@evil.example',
    '/auth/logout',
    '/api/models',
    '/oauth/authorize?client_id=sa_client_made-up',
    '/oauth/token',
    '/agents/../../evil.example',
    '/agentsx',
    '/mcp',
    ' /viewing',
    '/viewing\tx',
    '/viewing\nLocation: https://evil.example',
    `/viewing/${'a'.repeat(2000)}`,
    '',
  ])('falls back to / for %j', async (returnTo) => {
    const target = await start();
    const { callback } = await signIn(target, { loginUrl: login(returnTo) });
    expect(callback.headers.location).toBe(`${webOrigin}/`);
  });

  it('falls back to / when returnTo is given twice', async () => {
    const target = await start();
    const { callback } = await signIn(target, {
      loginUrl: '/auth/login?returnTo=%2Fviewing&returnTo=%2Fadmin',
    });
    expect(callback.headers.location).toBe(`${webOrigin}/`);
  });

  it('keeps the return path in the sealed login cookie only, not in the URL to the IdP', async () => {
    const target = await start();
    const path = '/viewing/models/secret-looking-path';
    const res = await get(target, login(path));
    expect(res.headers.location).not.toContain('secret-looking-path');
    const cookie = res.cookies.find((c) => c.name === '__Host-sa_login');
    expect(cookie?.value).not.toContain('secret-looking-path');
    expect(Buffer.from(cookie?.value ?? '', 'base64url').toString('latin1')).not.toContain(
      'secret-looking-path',
    );
  });

  it('ignores a returnTo added to the callback URL', async () => {
    const target = await start();
    const { callback } = await signIn(target, {
      loginUrl: login('/viewing'),
      tamper: (url) => {
        url.searchParams.set('returnTo', 'https://evil.example');
      },
    });
    expect(callback.headers.location).toBe(`${webOrigin}/viewing`);
  });
});

describe('GET /api/me', () => {
  it('returns 401 when signed out', async () => {
    const target = await start();
    const res = await get(target, '/api/me');

    expect(res.statusCode).toBe(401);
    expect(res.json<ApiError>()).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Sign in required',
    });
  });

  it('returns the user name, email, roles and allowed spaces', async () => {
    const target = await start();
    withClaims(idp, {
      name: 'Alex Morgan',
      preferred_username: 'alex@example.com',
      oid: 'object-id-1',
      roles: ['Modeller', 'Superuser'],
    });
    const { sessionCookie } = await signIn(target);
    const res = await get(target, '/api/me', sessionCookie);

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json<MeResponse>()).toEqual({
      name: 'Alex Morgan',
      email: 'alex@example.com',
      roles: ['Modeller'],
      spaces: ['viewing', 'modelling'],
    });
  });

  it('returns 401 and clears the cookie for an unknown session id', async () => {
    const target = await start();
    const res = await get(target, '/api/me', '__Host-sa_session=made-up-session-id');

    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === '__Host-sa_session')?.value).toBe('');
  });
});

describe('session timeouts', () => {
  const minutes = (n: number) => n * 60 * 1000;

  it('ends a session after the idle timeout', async () => {
    let time = Date.now();
    const target = await start({}, { now: () => time });
    const { sessionCookie } = await signIn(target);

    time += minutes(29);
    expect((await get(target, '/api/me', sessionCookie)).statusCode).toBe(200);
    time += minutes(29); // 58 minutes after sign-in, but only 29 idle
    expect((await get(target, '/api/me', sessionCookie)).statusCode).toBe(200);
    time += minutes(30);
    expect((await get(target, '/api/me', sessionCookie)).statusCode).toBe(401);
  });

  it('ends a session at the absolute timeout, even when active', async () => {
    let time = Date.now();
    const target = await start({}, { now: () => time });
    const { sessionCookie } = await signIn(target);

    for (let elapsed = 0; elapsed < minutes(8 * 60 - 20); elapsed += minutes(20)) {
      time += minutes(20);
      expect((await get(target, '/api/me', sessionCookie)).statusCode).toBe(200);
    }
    time += minutes(20);
    expect((await get(target, '/api/me', sessionCookie)).statusCode).toBe(401);
  });
});

describe('public routes and sessions', () => {
  const minutes = (n: number) => n * 60 * 1000;

  it('do not extend the idle timeout', async () => {
    let time = Date.now();
    const target = await start({}, { now: () => time });
    const { sessionCookie } = await signIn(target);

    // Health is polled with the cookie every 10 minutes; only /api/me counts as activity.
    for (let i = 0; i < 4; i++) {
      time += minutes(10);
      expect((await get(target, '/api/health', sessionCookie)).statusCode).toBe(200);
    }
    expect((await get(target, '/api/me', sessionCookie)).statusCode).toBe(401);
  });

  it('neither read nor clear the session cookie', async () => {
    const target = await start();
    const res = await get(target, '/api/health', '__Host-sa_session=made-up-session-id');

    expect(res.statusCode).toBe(200);
    expect(res.cookies).toHaveLength(0);
  });
});

describe('Cache-Control', () => {
  it('is no-store on every non-public /api response and every /auth response', async () => {
    const target = await start();
    withClaims(idp, { roles: ['Viewer'] });
    const { login, callback, sessionCookie } = await signIn(target);

    const responses = {
      'GET /auth/login': login,
      'GET /auth/callback': callback,
      'GET /api/me': await get(target, '/api/me', sessionCookie),
      'GET /api/viewing/ping (200)': await get(target, '/api/viewing/ping', sessionCookie),
      'GET /api/admin/ping (403)': await get(target, '/api/admin/ping', sessionCookie),
      'GET /api/modelling/ping (401)': await get(target, '/api/modelling/ping'),
      'GET /api/unknown (404)': await get(target, '/api/unknown', sessionCookie),
      'POST /auth/logout (403)': await logout(target, {}),
      'POST /auth/logout (303)': await logout(target, { origin: webOrigin, cookie: sessionCookie }),
    };
    for (const [name, res] of Object.entries(responses)) {
      expect(res.headers['cache-control'], name).toBe('no-store');
    }
  });

  it('is left to the route on public /api routes', async () => {
    const target = await start();
    expect((await get(target, '/api/health')).headers['cache-control']).toBeUndefined();
  });
});

describe('POST /auth/logout', () => {
  it('destroys the session, clears the cookie and sends the browser to end-session', async () => {
    const target = await start();
    const { sessionCookie } = await signIn(target);

    const res = await logout(target, { origin: webOrigin, cookie: sessionCookie });

    expect(res.statusCode).toBe(200);
    expect(res.headers.location).toBeUndefined();
    const location = leavesFor(res);
    expect(`${location.origin}${location.pathname}`).toBe(`${idp.issuer.url ?? ''}/endsession`);
    expect(location.searchParams.get('client_id')).toBe(clientId);
    expect(location.searchParams.has('id_token_hint')).toBe(false);
    expect(location.searchParams.has('post_logout_redirect_uri')).toBe(false);
    expect(res.cookies.find((c) => c.name === '__Host-sa_session')?.value).toBe('');
    // After sign-out, API calls return 401, even with the old cookie.
    expect((await get(target, '/api/me', sessionCookie)).statusCode).toBe(401);
    expect((await get(target, '/api/viewing/ping', sessionCookie)).statusCode).toBe(401);
  });

  it.each([
    ['no Origin header', {}],
    ['another origin', { origin: 'https://evil.example' }],
    ['another localhost port (same site)', { origin: 'http://localhost:3001' }],
    ['a null origin', { origin: 'null' }],
    ['the web origin with a trailing slash', { origin: `${webOrigin}/` }],
    ['the web origin in upper case', { origin: webOrigin.toUpperCase() }],
    ['only a Referer from the web app (no Referer fallback)', { referer: `${webOrigin}/viewing` }],
  ])('refuses a request with %s (CSRF) and keeps the session', async (_name, headers) => {
    const target = await start();
    const { sessionCookie } = await signIn(target);

    const res = await logout(target, { ...headers, cookie: sessionCookie });

    expect(res.statusCode).toBe(403);
    expect(res.json<ApiError>().message).toBe('Request origin not allowed');
    expect((await get(target, '/api/me', sessionCookie)).statusCode).toBe(200);
  });

  it('is POST only', async () => {
    const target = await start();
    expect((await get(target, '/auth/logout')).statusCode).toBe(404);
  });
});

describe('access per space', () => {
  const spaceUrls = {
    viewing: '/api/viewing/ping',
    modelling: '/api/modelling/ping',
    admin: '/api/admin/ping',
  };

  it.each(Object.entries(spaceUrls))('%s returns 401 when signed out', async (_space, url) => {
    const target = await start();
    const res = await get(target, url);

    expect(res.statusCode).toBe(401);
    expect(res.json<ApiError>().error).toBe('Unauthorized');
  });

  // Roles are cumulative; several roles give the union; no or unknown roles give nothing.
  it.each([
    [[], []],
    [['Superuser'], []],
    [['admin', 'VIEWER'], []], // role names are case-sensitive
    [['Viewer'], ['viewing']],
    [['Modeller'], ['viewing', 'modelling']],
    [['Admin'], ['viewing', 'modelling', 'admin']],
    [
      ['Viewer', 'Modeller'],
      ['viewing', 'modelling'],
    ],
    [
      ['Viewer', 'Admin'],
      ['viewing', 'modelling', 'admin'],
    ],
  ])('roles %j reach exactly %j', async (roles, allowed) => {
    const target = await start();
    withClaims(idp, { roles });
    const { sessionCookie } = await signIn(target);

    const me = (await get(target, '/api/me', sessionCookie)).json<MeResponse>();
    expect(me.spaces).toEqual(allowed);

    for (const [space, url] of Object.entries(spaceUrls)) {
      const res = await get(target, url, sessionCookie);
      if (allowed.includes(space)) {
        expect(res.statusCode, space).toBe(200);
        expect(res.json<SpacePingResponse>()).toEqual({ status: 'ok', space });
      } else {
        expect(res.statusCode, space).toBe(403);
        expect(res.json<ApiError>()).toEqual({
          statusCode: 403,
          error: 'Forbidden',
          message: 'You do not have access to this resource',
        });
      }
    }
  });

  it('maps the configured role values, and no longer the default names', async () => {
    const target = await start({
      OIDC_ROLE_ADMIN: 'EA.Admin',
      OIDC_ROLE_MODELLER: 'EA.Modeller',
      OIDC_ROLE_VIEWER: 'EA.Reader',
    });
    withClaims(idp, { roles: ['EA.Modeller', 'Admin'] });
    const { sessionCookie } = await signIn(target);

    const me = (await get(target, '/api/me', sessionCookie)).json<MeResponse>();
    expect(me.roles).toEqual(['Modeller']);
    expect(me.spaces).toEqual(['viewing', 'modelling']);
    expect((await get(target, '/api/admin/ping', sessionCookie)).statusCode).toBe(403);
  });

  it.each([
    ['a number', 7],
    ['an object', { Admin: true }],
    ['a list without text', [1, null, { value: 'Admin' }, ['Admin']]],
    ['several values in one text', 'Viewer Admin'],
    ['another case', 'admin'],
    ['surrounding spaces', ' Admin '],
  ])('treats a roles claim holding %s as no roles', async (_name, value) => {
    const target = await start();
    withClaims(idp, { roles: value });
    const { sessionCookie } = await signIn(target);

    expect((await get(target, '/api/me', sessionCookie)).json<MeResponse>().roles).toEqual([]);
    expect((await get(target, '/api/viewing/ping', sessionCookie)).statusCode).toBe(403);
  });

  it('HEAD, encoded and look-alike paths never get past the guard', async () => {
    const target = await start();
    withClaims(idp, { roles: ['Viewer'] });
    const { sessionCookie } = await signIn(target);
    const head = (url: string, cookie?: string) =>
      target.inject({ method: 'HEAD', url, headers: cookie ? { cookie } : {} });

    expect((await head('/api/admin/ping')).statusCode).toBe(401);
    expect((await head('/api/me')).statusCode).toBe(401);
    expect((await head('/api/admin/ping', sessionCookie)).statusCode).toBe(403);
    expect((await head('/api/viewing/ping', sessionCookie)).statusCode).toBe(200);
    // Percent-encoding matches the same route, so the same guard applies.
    expect((await get(target, '/api/%61dmin/ping')).statusCode).toBe(401);
    expect((await get(target, '/api/%61dmin/ping', sessionCookie)).statusCode).toBe(403);
    for (const url of [
      '/api/admin/ping/',
      '/API/admin/ping',
      '/api/Admin/ping',
      '//api/admin/ping',
    ]) {
      expect((await get(target, url, sessionCookie)).statusCode, url).toBe(404);
    }
    // OPTIONS has no route (and there is no CORS): nothing is served.
    const options = await target.inject({ method: 'OPTIONS', url: '/api/admin/ping' });
    expect(options.statusCode).toBe(404);
    expect(options.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('deny by default', () => {
  it('refuses to register a route without an access rule', async () => {
    const target = await start();
    expect(() => target.get('/api/unguarded', async () => 'open')).toThrow(/no access rule/);
  });

  it('checks Origin on every state-changing API route before anything else', async () => {
    const target = await start();
    target.post('/api/test-write', { config: { access: 'authenticated' } }, async () => 'written');
    const { sessionCookie } = await signIn(target);

    const crossSite = await target.inject({
      method: 'POST',
      url: '/api/test-write',
      headers: { origin: 'https://evil.example', cookie: sessionCookie },
    });
    const signedOut = await target.inject({
      method: 'POST',
      url: '/api/test-write',
      headers: { origin: webOrigin },
    });
    const ok = await target.inject({
      method: 'POST',
      url: '/api/test-write',
      headers: { origin: webOrigin, cookie: sessionCookie },
    });

    expect(crossSite.statusCode).toBe(403);
    expect(signedOut.statusCode).toBe(401);
    expect(ok.statusCode).toBe(200);
  });
});

describe('tokens never reach the browser or the logs', () => {
  it('no token appears in any response body, header or cookie; the only cookie value is the session id', async () => {
    const target = await start({ LOG_LEVEL: 'trace' });
    const logs = captureLogs(target);
    const tokens: string[] = [];
    idp.service.on('beforeResponse', (response: { body: Record<string, unknown> }) => {
      for (const key of ['access_token', 'id_token', 'refresh_token']) {
        const value = response.body[key];
        if (typeof value === 'string') tokens.push(value);
      }
    });
    withClaims(idp, { roles: ['Admin'], name: 'Alex Morgan' });

    let code = '';
    const { login, callback, sessionCookie } = await signIn(target, {
      tamper: (url) => {
        code = url.searchParams.get('code') ?? '';
      },
    });
    const responses: LightMyRequestResponse[] = [login, callback];
    for (const url of ['/api/me', '/api/viewing/ping', '/api/modelling/ping', '/api/admin/ping']) {
      responses.push(await get(target, url, sessionCookie));
    }
    responses.push(await logout(target, { origin: webOrigin, cookie: sessionCookie }));

    expect(tokens).toHaveLength(3);
    expect(code).not.toBe('');
    const sessionId = sessionCookie.split('=')[1];
    for (const res of responses) {
      const everything = `${res.body}\n${JSON.stringify(res.headers)}`;
      for (const token of tokens) {
        expect(everything).not.toContain(token);
        // Also no fragment of a JWT (its signature part).
        expect(everything).not.toContain(token.split('.')[2]);
      }
      for (const c of res.cookies) {
        expect(['__Host-sa_session', '__Host-sa_login']).toContain(c.name);
        if (c.name === '__Host-sa_session') expect([sessionId, '']).toContain(c.value);
      }
    }
    // Logs hold no tokens, no authorization code and no session id.
    const logged = logs.join('');
    expect(logged).toContain('signed in');
    for (const secret of [...tokens, code, sessionId ?? 'missing']) {
      expect(logged).not.toContain(secret);
    }
  });
});

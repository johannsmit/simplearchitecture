import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppOptions } from '../src/app.js';
import { DatabaseService } from '../src/db/service.js';
import {
  accessTokenLifetimeMs,
  codeLifetimeMs,
  connectionLifetimeMs,
  maxRegisteredClients,
  neverUsedClientLifetimeMs,
  unusedClientLifetimeMs,
} from '../src/mcp-auth/rules.js';
import { OAuthService } from '../src/mcp-auth/oauth-service.js';
import { registrationsPerMinute } from '../src/routes/oauth.js';
import {
  buildTestApp,
  captureLogs,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';
import {
  authorize,
  authorizeUrl,
  connect,
  decide,
  heldId,
  form,
  hostedRedirect,
  loopbackRedirect,
  mcp,
  newPkce,
  registerClient,
  resource,
  type Tokens,
} from './mcp-helpers.js';
import { createTestDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const user = { oid: 'made-up-agent-user', name: 'Made-up Architect' };

let db: TestDb;
let idp: OAuth2Server;
let app: FastifyInstance | undefined;
let time = Date.parse('2026-11-03T10:00:00Z');
const now = () => time;

beforeAll(async () => {
  db = await createTestDb();
  idp = await startMockIdp();
});

afterAll(async () => {
  await idp.stop();
  await db.close();
});

beforeEach(async () => {
  await resetTestDb(db);
  time = Date.parse('2026-11-03T10:00:00Z');
});

afterEach(async () => {
  idp.service.removeAllListeners('beforeTokenSigning');
  await app?.close();
  app = undefined;
});

async function start(options: AppOptions = {}, logLevel: 'silent' | 'trace' = 'silent') {
  app = await buildTestApp(
    { LOG_LEVEL: logLevel },
    idpOptions(idp, {
      database: DatabaseService.using(db, testConnection, silent),
      now,
      // Long enough for the clock moves below: the browser session isn't what is tested here.
      sessionTimeouts: { idleMs: 30 * 24 * 3_600_000, absoluteMs: 30 * 24 * 3_600_000 },
      ...options,
    }),
  );
  return app;
}

async function signedIn(
  roles: string[] = ['Viewer'],
  options: AppOptions = {},
  logLevel: 'silent' | 'trace' = 'silent',
) {
  const target = await start(options, logLevel);
  withClaims(idp, { roles, ...user });
  const { sessionCookie } = await signIn(target);
  expect(sessionCookie).not.toBe('');
  return { target, cookie: sessionCookie };
}

/** A code for a fresh client, as the agent receives it. */
async function codeFor(target: FastifyInstance, cookie: string) {
  const clientId = await registerClient(target);
  const pkce = newPkce();
  const back = await authorize(target, cookie, authorizeUrl(clientId, pkce));
  return { clientId, pkce, code: back.searchParams.get('code') ?? '' };
}

function exchange(
  target: FastifyInstance,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return form(target, '/oauth/token', { grant_type: 'authorization_code', ...fields }, headers);
}

function refresh(target: FastifyInstance, clientId: string, token: string) {
  return form(target, '/oauth/token', {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: token,
  });
}

async function mcpStatus(target: FastifyInstance, token: string): Promise<number> {
  return (await mcp(target, token, 'tools/list')).statusCode;
}

describe('metadata', () => {
  it('names the app as its own authorization server, all from its address', async () => {
    const target = await start();
    for (const url of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const res = await target.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        resource,
        authorization_servers: [webOrigin],
        bearer_methods_supported: ['header'],
        resource_name: 'SimpleArchitecture',
      });
    }
    const as = await target.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(as.json()).toMatchObject({
      issuer: webOrigin,
      authorization_endpoint: `${webOrigin}/oauth/authorize`,
      token_endpoint: `${webOrigin}/oauth/token`,
      registration_endpoint: `${webOrigin}/oauth/register`,
      revocation_endpoint: `${webOrigin}/oauth/revoke`,
      // Only `none`: clients pick their method from this list.
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      authorization_response_iss_parameter_supported: true,
    });
    expect(as.json()).not.toHaveProperty('client_id_metadata_document_supported');
    expect(as.json()).not.toHaveProperty('scopes_supported');
  });

  it('is not there without a database', async () => {
    app = await buildTestApp({}, idpOptions(idp));
    const res = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /oauth/register', () => {
  it('registers a public client', async () => {
    const target = await start();
    const res = await target.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: {
        redirect_uris: [hostedRedirect, loopbackRedirect],
        client_name: '  Made-up\u0007 agent‮ ',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        logo_uri: 'https://agent.example.test/logo.png',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const client = res.json<Record<string, unknown>>();
    expect(client).toMatchObject({
      client_name: 'Made-up agent',
      redirect_uris: [hostedRedirect, loopbackRedirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(client.client_id).toMatch(/^sa_client_[A-Za-z0-9_-]{22}$/);
    expect(client).not.toHaveProperty('client_secret');
  });

  it.each([
    ['no redirect URI', {}, 'invalid_redirect_uri'],
    ['an empty list', { redirect_uris: [] }, 'invalid_redirect_uri'],
    [
      'six redirect URIs',
      { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://a.example.test/${String(i)}`) },
      'invalid_redirect_uri',
    ],
    [
      'plain http elsewhere',
      { redirect_uris: ['http://agent.example.test/cb'] },
      'invalid_redirect_uri',
    ],
    ['another scheme', { redirect_uris: ['made-up-app://callback'] }, 'invalid_redirect_uri'],
    ['a fragment', { redirect_uris: ['https://agent.example.test/cb#x'] }, 'invalid_redirect_uri'],
    [
      'a user name',
      { redirect_uris: ['https://me@agent.example.test/cb'] },
      'invalid_redirect_uri',
    ],
    ['not an address', { redirect_uris: ['/callback'] }, 'invalid_redirect_uri'],
    [
      'a very long address',
      { redirect_uris: [`https://agent.example.test/${'a'.repeat(600)}`] },
      'invalid_redirect_uri',
    ],
    [
      'a client secret method',
      { redirect_uris: [hostedRedirect], token_endpoint_auth_method: 'client_secret_post' },
      'invalid_client_metadata',
    ],
    [
      'another grant type',
      { redirect_uris: [hostedRedirect], grant_types: ['client_credentials'] },
      'invalid_client_metadata',
    ],
    [
      'another response type',
      { redirect_uris: [hostedRedirect], response_types: ['token'] },
      'invalid_client_metadata',
    ],
    [
      'a name that is not text',
      { redirect_uris: [hostedRedirect], client_name: 7 },
      'invalid_client_metadata',
    ],
  ])('refuses %s', async (_case, payload, error) => {
    const target = await start();
    const res = await target.inject({ method: 'POST', url: '/oauth/register', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error });
    const [count] = await db.query<{ count: number }>(
      'select count(*)::int as count from mcp_clients',
    );
    expect(count?.count).toBe(0);
  });

  it('refuses another media type (415), a large body (413) and a foreign origin (403)', async () => {
    const target = await start();
    const asText = await target.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'text/plain' },
      payload: 'x',
    });
    expect(asText.statusCode).toBe(415);
    const large = await target.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: [hostedRedirect], client_name: 'x'.repeat(20_000) },
    });
    expect(large.statusCode).toBe(413);
    const foreign = await target.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { origin: 'https://elsewhere.example.test' },
      payload: { redirect_uris: [hostedRedirect] },
    });
    expect(foreign.statusCode).toBe(403);
    const own = await target.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { origin: webOrigin },
      payload: { redirect_uris: [hostedRedirect] },
    });
    expect(own.statusCode).toBe(201);
  });

  it('limits registrations per address', async () => {
    const target = await start();
    for (let i = 0; i < registrationsPerMinute; i++) await registerClient(target);
    const over = await target.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: [hostedRedirect] },
    });
    expect(over.statusCode).toBe(429);
    time += 61_000;
    await registerClient(target);
  });

  /** Fills the store with made-up clients: ones that got a token, or ones that never did. */
  async function fill(count: number, used: boolean) {
    await db.query(
      `insert into mcp_clients (id, name, redirect_uris, created_at, last_used_at)
       select 'made-up-' || n, 'Made-up', '[]'::jsonb,
         $2::timestamptz + n * interval '1 millisecond',
         $2::timestamptz + n * interval '1 millisecond' + $3 * interval '1 second'
       from generate_series(1, $1::int) as n`,
      [count, new Date(time - 60_000), used ? 30 : 0],
    );
  }

  it('waits only when every client kept has had a token', async () => {
    const target = await start();
    await fill(maxRegisteredClients, true);
    const res = await target.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: [hostedRedirect] },
    });
    expect(res.statusCode).toBe(503);
  });

  it('stays open through a flood: at the cap, the oldest client that never got a token makes room', async () => {
    const target = await start();
    await fill(maxRegisteredClients, false);
    const real = await registerClient(target);
    const [count] = await db.query<{ count: number }>(
      'select count(*)::int as count from mcp_clients',
    );
    expect(count?.count).toBe(maxRegisteredClients);
    const gone = await db.query("select id from mcp_clients where id = 'made-up-1'");
    expect(gone).toEqual([]);
    // The new client works: a user can go on and connect it.
    expect((await db.query('select id from mcp_clients where id = $1', [real])).length).toBe(1);
  });
});

describe('GET /oauth/authorize', () => {
  it('sends a signed-in Viewer back to the agent with a code, the state and the issuer', async () => {
    const { target, cookie } = await signedIn();
    const clientId = await registerClient(target);
    const back = await authorize(target, cookie, authorizeUrl(clientId, newPkce()));
    expect(`${back.origin}${back.pathname}`).toBe(loopbackRedirect);
    expect(back.searchParams.get('code')).toMatch(/^sa_ac_[A-Za-z0-9_-]{43}$/);
    expect(back.searchParams.get('state')).toBe('made-up-state');
    expect(back.searchParams.get('iss')).toBe(webOrigin);
  });

  it('accepts a loopback redirect on another port, and only there', async () => {
    const { target, cookie } = await signedIn();
    const clientId = await registerClient(target, {
      redirect_uris: [loopbackRedirect, hostedRedirect, 'http://localhost/callback'],
    });
    const pkce = newPkce();
    for (const redirect of ['http://127.0.0.1:51000/callback', 'http://localhost:3118/callback']) {
      const back = await authorize(
        target,
        cookie,
        authorizeUrl(clientId, pkce, { redirect_uri: redirect }),
      );
      expect(`${back.origin}${back.pathname}`).toBe(redirect);
    }
    for (const redirect of [
      'http://127.0.0.1:51000/other',
      'http://localhost:3118/callback?x=1',
      'http://[::1]:3118/callback',
      'https://agent.example.test:8443/oauth/callback',
      'https://agent.example.test/oauth/callback/',
    ]) {
      const res = await target.inject({
        method: 'GET',
        url: authorizeUrl(clientId, pkce, { redirect_uri: redirect }),
        headers: { cookie },
      });
      expect(res.statusCode, redirect).toBe(302);
      expect(res.headers.location, redirect).toBe('/agents/connect?error=invalid');
    }
  });

  it('never goes back to an unknown client or a missing redirect: the page says it is not valid', async () => {
    const { target, cookie } = await signedIn();
    const clientId = await registerClient(target);
    for (const url of [
      authorizeUrl('sa_client_madeupmadeupmadeup12', newPkce()),
      authorizeUrl(clientId, newPkce(), { redirect_uri: undefined }),
      `${authorizeUrl(clientId, newPkce())}&client_id=${clientId}`,
    ]) {
      const res = await target.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, url).toBe(302);
      expect(res.headers.location, url).toBe('/agents/connect?error=invalid');
    }
    const [held] = await db.query<{ count: number }>(
      'select count(*)::int as count from mcp_authorization_requests',
    );
    expect(held?.count).toBe(0);
  });

  it.each([
    ['no PKCE challenge', { code_challenge: undefined }, 'invalid_request'],
    ['the plain PKCE method', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['no PKCE method', { code_challenge_method: undefined }, 'invalid_request'],
    ['a short challenge', { code_challenge: 'short' }, 'invalid_request'],
    ['another response type', { response_type: 'token' }, 'unsupported_response_type'],
    ['another resource', { resource: 'https://elsewhere.example.test/mcp' }, 'invalid_target'],
    ['a state that is too long', { state: 'x'.repeat(501) }, 'invalid_request'],
  ])(
    "shows %s on the app's own page, never on the agent's address",
    async (_case, extra, error) => {
      const { target, cookie } = await signedIn(['Viewer'], {}, 'trace');
      const logs = captureLogs(target);
      const clientId = await registerClient(target);
      for (const headers of [{ cookie }, {}]) {
        const res = await target.inject({
          method: 'GET',
          url: authorizeUrl(clientId, newPkce(), extra),
          headers,
        });
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/agents/connect?error=invalid');
      }
      // The OAuth code is logged, for whoever looks into it; nothing from the request.
      expect(logs.join('\n')).toContain(`"error":"${error}"`);
      const [held] = await db.query<{ count: number }>(
        'select count(*)::int as count from mcp_authorization_requests',
      );
      expect(held?.count).toBe(0);
    },
  );

  it('accepts a request without a resource', async () => {
    const { target, cookie } = await signedIn();
    const clientId = await registerClient(target);
    const back = await authorize(
      target,
      cookie,
      authorizeUrl(clientId, newPkce(), { resource: undefined }),
    );
    expect(back.searchParams.get('code')).not.toBeNull();
  });

  it('sends a signed-out browser through the usual sign-in, straight on to the consent page', async () => {
    const target = await start();
    const clientId = await registerClient(target);
    const url = authorizeUrl(clientId, newPkce());
    const first = await target.inject({ method: 'GET', url });
    expect(first.statusCode).toBe(302);
    const login = first.headers.location as string;
    const returnTo = new URL(login, webOrigin).searchParams.get('returnTo') ?? '';
    expect(login.startsWith('/auth/login?returnTo=')).toBe(true);
    const id = heldId(returnTo);
    expect(id).toMatch(/^sa_rq_/);

    withClaims(idp, { roles: ['Viewer'], ...user });
    const { callback, sessionCookie } = await signIn(target, { loginUrl: login });
    expect(callback.headers.location).toBe(`${webOrigin}${returnTo}`);
    const decided = await decide(target, sessionCookie, id ?? '', true);
    expect(
      new URL(decided.json<{ location: string }>().location).searchParams.get('code'),
    ).not.toBeNull();
  });

  it('sends a signed-in browser straight to the consent page', async () => {
    const { target, cookie } = await signedIn();
    const clientId = await registerClient(target);
    const res = await target.inject({
      method: 'GET',
      url: authorizeUrl(clientId, newPkce()),
      headers: { cookie },
    });
    expect(res.statusCode).toBe(302);
    expect(heldId(res.headers.location as string)).toMatch(/^sa_rq_/);
  });

  it('sends the agent back with access_denied when the user says no', async () => {
    const { target, cookie } = await signedIn();
    const clientId = await registerClient(target);
    const back = await authorize(target, cookie, authorizeUrl(clientId, newPkce()), false);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('made-up-state');
    expect(back.searchParams.get('iss')).toBe(webOrigin);
  });
});

describe('POST /oauth/token: the authorization code', () => {
  it('gives a one-hour access token and a refresh token, never cached', async () => {
    const { target, cookie } = await signedIn();
    const { clientId, pkce, code } = await codeFor(target, cookie);
    const res = await exchange(target, {
      client_id: clientId,
      code,
      redirect_uri: loopbackRedirect,
      code_verifier: pkce.verifier,
      resource,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.pragma).toBe('no-cache');
    const tokens = res.json<Tokens>();
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.expires_in).toBe(accessTokenLifetimeMs / 1000);
    expect(tokens.access_token).toMatch(/^sa_at_[A-Za-z0-9_-]{43}$/);
    expect(tokens.refresh_token).toMatch(/^sa_rt_[A-Za-z0-9_-]{43}$/);
    expect(await mcpStatus(target, tokens.access_token)).toBe(200);
  });

  it('refuses a code used twice, and ends the connection the first use started', async () => {
    const { target, cookie } = await signedIn();
    const { clientId, pkce, code } = await codeFor(target, cookie);
    const fields = {
      client_id: clientId,
      code,
      redirect_uri: loopbackRedirect,
      code_verifier: pkce.verifier,
    };
    const first = await exchange(target, fields);
    expect(first.statusCode).toBe(200);
    const again = await exchange(target, fields);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await mcpStatus(target, first.json<Tokens>().access_token)).toBe(401);
  });

  it.each([
    ['an expired code', 'expired'],
    ['another client', 'client'],
    ['another redirect URI', 'redirect'],
    ['a wrong verifier', 'verifier'],
  ])('refuses %s, and the code is spent', async (_case, what) => {
    const { target, cookie } = await signedIn();
    const { clientId, pkce, code } = await codeFor(target, cookie);
    const other = await registerClient(target);
    if (what === 'expired') time += codeLifetimeMs + 1;
    const fields = {
      client_id: what === 'client' ? other : clientId,
      code,
      redirect_uri: what === 'redirect' ? 'http://127.0.0.1:33418/other' : loopbackRedirect,
      code_verifier: what === 'verifier' ? newPkce().verifier : pkce.verifier,
    };
    const res = await exchange(target, fields);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
    // Spent: even the right request can't use it now.
    const right = await exchange(target, {
      client_id: clientId,
      code,
      redirect_uri: loopbackRedirect,
      code_verifier: pkce.verifier,
    });
    expect(right.statusCode).toBe(400);
  });

  it.each([
    ['no verifier', { code_verifier: undefined }, 400, 'invalid_request'],
    ['another resource', { resource: 'https://elsewhere.example.test/mcp' }, 400, 'invalid_target'],
    ['a client secret', { client_secret: 'made-up' }, 401, 'invalid_client'],
    ['an unknown client', { client_id: 'sa_client_unknownunknownunkn' }, 401, 'invalid_client'],
    ['no client', { client_id: undefined }, 401, 'invalid_client'],
    ['another grant type', { grant_type: 'client_credentials' }, 400, 'unsupported_grant_type'],
    [
      'a made-up code',
      { code: 'sa_ac_madeupmadeupmadeupmadeupmadeupmadeupmad' },
      400,
      'invalid_grant',
    ],
    ['a repeated field', { code_verifier: ['a', 'b'] }, 400, 'invalid_request'],
  ])('refuses %s', async (_case, change, status, error) => {
    const { target, cookie } = await signedIn();
    const { clientId, pkce, code } = await codeFor(target, cookie);
    const fields: Record<string, string | string[]> = {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: loopbackRedirect,
      code_verifier: pkce.verifier,
    };
    for (const [name, value] of Object.entries(change) as [
      string,
      string | string[] | undefined,
    ][]) {
      if (value === undefined) Reflect.deleteProperty(fields, name);
      else fields[name] = value;
    }
    const res = await form(target, '/oauth/token', fields);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error });
  });

  it('refuses client credentials in a header, a JSON body and a foreign origin', async () => {
    const { target, cookie } = await signedIn();
    const { clientId, pkce, code } = await codeFor(target, cookie);
    const fields = {
      client_id: clientId,
      code,
      redirect_uri: loopbackRedirect,
      code_verifier: pkce.verifier,
    };
    const basic = await exchange(target, fields, {
      authorization: `Basic ${Buffer.from(`${clientId}:x`).toString('base64')}`,
    });
    expect(basic.statusCode).toBe(401);
    expect(basic.json()).toMatchObject({ error: 'invalid_client' });
    const json = await target.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: { grant_type: 'authorization_code', ...fields },
    });
    expect(json.statusCode).toBe(415);
    const foreign = await exchange(target, fields, { origin: 'https://elsewhere.example.test' });
    expect(foreign.statusCode).toBe(403);
    // None of these spent the code.
    expect((await exchange(target, fields)).statusCode).toBe(200);
  });
});

describe('POST /oauth/token: refreshing', () => {
  it('rotates the refresh token on every use', async () => {
    const { target, cookie } = await signedIn();
    const { clientId, tokens } = await connect(target, cookie);
    const res = await refresh(target, clientId, tokens.refresh_token);
    expect(res.statusCode).toBe(200);
    const next = res.json<Tokens>();
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    expect(next.access_token).not.toBe(tokens.access_token);
    expect(await mcpStatus(target, next.access_token)).toBe(200);
    expect((await refresh(target, clientId, next.refresh_token)).statusCode).toBe(200);
  });

  it('ends the whole connection when a used refresh token comes back', async () => {
    const { target, cookie } = await signedIn();
    const { clientId, tokens } = await connect(target, cookie);
    const next = (await refresh(target, clientId, tokens.refresh_token)).json<Tokens>();
    const reused = await refresh(target, clientId, tokens.refresh_token);
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toMatchObject({ error: 'invalid_grant' });
    expect(await mcpStatus(target, next.access_token)).toBe(401);
    expect((await refresh(target, clientId, next.refresh_token)).statusCode).toBe(400);
  });

  it('refuses a refresh token from another client and leaves it working', async () => {
    const { target, cookie } = await signedIn();
    const { clientId, tokens } = await connect(target, cookie);
    const other = await registerClient(target);
    const res = await refresh(target, other, tokens.refresh_token);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await refresh(target, clientId, tokens.refresh_token)).statusCode).toBe(200);
  });

  it('ends a connection 7 days after the sign-in, however often it refreshes', async () => {
    const { target, cookie } = await signedIn();
    const { clientId, tokens } = await connect(target, cookie);
    let refreshToken = tokens.refresh_token;
    // Just before the end, the access token lasts only until then.
    time += connectionLifetimeMs - 10 * 60_000;
    const late = await refresh(target, clientId, refreshToken);
    expect(late.statusCode).toBe(200);
    expect(late.json<Tokens>().expires_in).toBe(600);
    refreshToken = late.json<Tokens>().refresh_token;
    time += 10 * 60_000;
    expect(await mcpStatus(target, late.json<Tokens>().access_token)).toBe(401);
    const over = await refresh(target, clientId, refreshToken);
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('lets an access token lapse after an hour', async () => {
    const { target, cookie } = await signedIn();
    const { tokens } = await connect(target, cookie);
    time += accessTokenLifetimeMs - 1_000;
    expect(await mcpStatus(target, tokens.access_token)).toBe(200);
    time += 1_000;
    const res = await mcp(target, tokens.access_token, 'tools/list');
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });
});

describe('POST /oauth/revoke', () => {
  it.each(['access_token', 'refresh_token'] as const)(
    'ends the connection of a revoked %s at once',
    async (kind) => {
      const { target, cookie } = await signedIn();
      const { clientId, tokens } = await connect(target, cookie);
      const res = await form(target, '/oauth/revoke', { token: tokens[kind], client_id: clientId });
      expect(res.statusCode).toBe(200);
      expect(await mcpStatus(target, tokens.access_token)).toBe(401);
      expect((await refresh(target, clientId, tokens.refresh_token)).statusCode).toBe(400);
    },
  );

  it("answers an unknown token the same way, and leaves another client's token alone", async () => {
    const { target, cookie } = await signedIn();
    const { tokens } = await connect(target, cookie);
    const other = await registerClient(target);
    const made = await form(target, '/oauth/revoke', { token: 'made-up', client_id: other });
    expect(made.statusCode).toBe(200);
    const foreign = await form(target, '/oauth/revoke', {
      token: tokens.access_token,
      client_id: other,
    });
    expect(foreign.statusCode).toBe(200);
    expect(await mcpStatus(target, tokens.access_token)).toBe(200);
    const anonymous = await form(target, '/oauth/revoke', { token: tokens.access_token });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('storage and logs', () => {
  it('stores only hashes of codes and tokens, and never logs them', async () => {
    const { target, cookie } = await signedIn(['Viewer'], {}, 'trace');
    const logs = captureLogs(target);
    const { clientId, pkce, code } = await codeFor(target, cookie);
    const tokens = (
      await exchange(target, {
        client_id: clientId,
        code,
        redirect_uri: loopbackRedirect,
        code_verifier: pkce.verifier,
      })
    ).json<Tokens>();
    const next = (await refresh(target, clientId, tokens.refresh_token)).json<Tokens>();
    await mcp(target, next.access_token, 'tools/list');

    const secrets = [
      code,
      tokens.access_token,
      tokens.refresh_token,
      next.access_token,
      next.refresh_token,
    ];
    const tables = await db.query<{ rows: string }>(
      `select (select coalesce(json_agg(c), '[]')::text from mcp_codes c)
        || (select coalesce(json_agg(t), '[]')::text from mcp_tokens t)
        || (select coalesce(json_agg(n), '[]')::text from mcp_connections n) as rows`,
    );
    const stored = tables[0]?.rows ?? '';
    expect(stored).toContain('"kind":"refresh"');
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
      expect(stored).not.toContain(secret.slice(6));
      expect(logs.join('\n')).not.toContain(secret.slice(6));
    }
    expect(logs.join('\n')).toContain('"audit":"mcp-connected"');
  });

  it('removes a client that never got a token an hour after it registered', async () => {
    const { target, cookie } = await signedIn();
    const unused = await registerClient(target);
    // Registered, and the user is still signing in: a held request, no token yet.
    await target.inject({
      method: 'GET',
      url: authorizeUrl(unused, newPkce()),
      headers: { cookie },
    });
    const { clientId: connected } = await connect(target, cookie);
    const service = new OAuthService({ db, webOrigin, now, log: silent });
    const ids = async () =>
      (await db.query<{ id: string }>('select id from mcp_clients order by id')).map(
        (row) => row.id,
      );

    time += neverUsedClientLifetimeMs - 1;
    expect(await service.sweep()).toEqual({ connections: 0, clients: 0 });
    time += 1;
    expect(await service.sweep()).toEqual({ connections: 0, clients: 1 });
    expect(await ids()).toEqual([connected]);
  });

  it('keeps a client that got a token for 30 days after its last use', async () => {
    const { target, cookie } = await signedIn();
    // Registered and connected in the same millisecond: it still counts as used.
    const { clientId } = await connect(target, cookie);
    const service = new OAuthService({ db, webOrigin, now, log: silent });
    const count = async (table: string) =>
      (await db.query<{ count: number }>(`select count(*)::int as count from ${table}`))[0]?.count;

    time += connectionLifetimeMs - 1;
    expect(await service.sweep()).toEqual({ connections: 0, clients: 0 });
    time += 1;
    expect(await service.sweep()).toEqual({ connections: 1, clients: 0 });
    expect(await count('mcp_tokens')).toBe(0);
    expect(await count('mcp_clients')).toBe(1);
    time += unusedClientLifetimeMs - connectionLifetimeMs;
    expect(await service.sweep()).toEqual({ connections: 0, clients: 0 });
    // Its last use was moved a millisecond past its registration.
    time += 1;
    expect(await service.sweep()).toEqual({ connections: 0, clients: 1 });
    expect(await count('mcp_codes')).toBe(0);
    expect(clientId).toMatch(/^sa_client_/);
  });
});

/** Signs another made-up user in on the same app. */
async function otherSession(
  target: FastifyInstance,
  roles: string[] = ['Viewer'],
): Promise<string> {
  idp.service.removeAllListeners('beforeTokenSigning');
  withClaims(idp, { roles, oid: 'made-up-other-user', name: 'Made-up Other' });
  const { sessionCookie } = await signIn(target);
  return sessionCookie;
}

/** A held request for a fresh client, as the authorize step leaves it for the consent page. */
async function heldRequest(target: FastifyInstance, cookie: string, client: object = {}) {
  const clientId = await registerClient(target, {
    redirect_uris: [hostedRedirect],
    client_name: 'Made-up hosted agent',
    ...client,
  });
  const redirect = (client as { redirect_uris?: string[] }).redirect_uris?.[0] ?? hostedRedirect;
  const res = await target.inject({
    method: 'GET',
    url: authorizeUrl(clientId, newPkce(), { redirect_uri: redirect }),
    headers: { cookie },
  });
  const id = heldId(res.headers.location as string);
  if (id === undefined) throw new Error(`no held request: ${String(res.headers.location)}`);
  return id;
}

function readHeld(target: FastifyInstance, cookie: string, id: string) {
  return target.inject({
    method: 'GET',
    url: `/api/agents/requests/${encodeURIComponent(id)}`,
    headers: { cookie },
  });
}

describe('the consent page API', () => {
  it('shows what the page needs, and the decision uses the request once', async () => {
    const { target, cookie } = await signedIn();
    const id = await heldRequest(target, cookie);
    const shown = await readHeld(target, cookie, id);
    expect(shown.statusCode).toBe(200);
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(shown.json()).toEqual({
      clientName: 'Made-up hosted agent',
      redirectHost: 'agent.example.test',
      loopback: false,
      connectionEndsAt: new Date(time + connectionLifetimeMs).toISOString(),
    });
    const decided = await decide(target, cookie, id, true);
    expect(decided.statusCode).toBe(200);
    const back = new URL(decided.json<{ location: string }>().location);
    expect(`${back.origin}${back.pathname}`).toBe(hostedRedirect);
    expect(back.searchParams.get('code')).toMatch(/^sa_ac_/);
    expect(back.searchParams.get('state')).toBe('made-up-state');
    expect((await readHeld(target, cookie, id)).statusCode).toBe(404);
    expect((await decide(target, cookie, id, true)).statusCode).toBe(404);
    expect((await decide(target, cookie, id, false)).statusCode).toBe(404);
  });

  it('shows no name when the agent gave none, a loopback host, and strips bidi controls', async () => {
    const { target, cookie } = await signedIn();
    const unnamed = await heldRequest(target, cookie, {
      client_name: undefined,
      redirect_uris: ['http://localhost:53682/callback'],
    });
    expect((await readHeld(target, cookie, unnamed)).json()).toMatchObject({
      clientName: null,
      redirectHost: 'localhost:53682',
      loopback: true,
    });
    const tricky = await heldRequest(target, cookie, {
      client_name: '<b>Admin</b> \u202enimdA',
    });
    expect((await readHeld(target, cookie, tricky)).json<{ clientName: string }>().clientName).toBe(
      '<b>Admin</b> nimdA',
    );
  });

  it("belongs to the first user who opens it: another user's is not valid", async () => {
    const { target, cookie } = await signedIn();
    const id = await heldRequest(target, cookie);
    expect((await readHeld(target, cookie, id)).statusCode).toBe(200);
    const other = await otherSession(target);
    expect((await readHeld(target, other, id)).statusCode).toBe(404);
    expect((await decide(target, other, id, true)).statusCode).toBe(404);
    expect((await decide(target, cookie, id, true)).statusCode).toBe(200);
  });

  it('refuses Allow from a user without a role, who can still say no', async () => {
    const { target, cookie } = await signedIn([]);
    const id = await heldRequest(target, cookie);
    expect((await readHeld(target, cookie, id)).statusCode).toBe(200);
    const allow = await decide(target, cookie, id, true);
    expect(allow.statusCode).toBe(403);
    const deny = await decide(target, cookie, id, false);
    expect(deny.statusCode).toBe(200);
    const back = new URL(deny.json<{ location: string }>().location);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('expires after 10 minutes', async () => {
    const { target, cookie } = await signedIn();
    const id = await heldRequest(target, cookie);
    time += 10 * 60_000;
    expect((await readHeld(target, cookie, id)).statusCode).toBe(404);
    expect((await decide(target, cookie, id, true)).statusCode).toBe(404);
  });

  it('refuses a made-up id, a bad body, another origin and no session', async () => {
    const { target, cookie } = await signedIn();
    const id = await heldRequest(target, cookie);
    expect((await readHeld(target, cookie, 'sa_rq_madeup')).statusCode).toBe(404);
    const url = `/api/agents/requests/${id}`;
    const bad = await target.inject({
      method: 'POST',
      url,
      headers: { cookie, origin: webOrigin },
      payload: { allow: 'yes' },
    });
    expect(bad.statusCode).toBe(400);
    const foreign = await target.inject({
      method: 'POST',
      url,
      headers: { cookie, origin: 'https://elsewhere.example.test' },
      payload: { allow: true },
    });
    expect(foreign.statusCode).toBe(403);
    const signedOut = await target.inject({
      method: 'POST',
      url,
      headers: { origin: webOrigin },
      payload: { allow: true },
    });
    expect(signedOut.statusCode).toBe(401);
    // None of these used it up.
    expect((await decide(target, cookie, id, true)).statusCode).toBe(200);
  });

  it('never logs the request id', async () => {
    const { target, cookie } = await signedIn(['Viewer'], {}, 'trace');
    const logs = captureLogs(target);
    const id = await heldRequest(target, cookie);
    await readHeld(target, cookie, id);
    await decide(target, cookie, id, true);
    expect(logs.join('\n')).not.toContain(id.slice(6));
  });
});

describe('Connected apps API', () => {
  it("lists the user's own live connections, each Allow its own row, newest first", async () => {
    const { target, cookie } = await signedIn();
    const first = await connect(target, cookie);
    time += 60_000;
    const second = await connect(target, cookie);
    const other = await otherSession(target);
    await connect(target, other);
    time += 120_000;
    await mcp(target, second.tokens.access_token, 'tools/list');

    const res = await target.inject({ method: 'GET', url: '/api/agents', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { apps } = res.json<{ apps: Record<string, unknown>[] }>();
    expect(apps).toHaveLength(2);
    expect(apps[0]).toEqual({
      id: expect.any(String) as string,
      clientName: 'Made-up agent',
      redirectHost: '127.0.0.1:33418',
      loopback: true,
      connectedAt: '2026-11-03T10:01:00.000Z',
      lastUsedAt: '2026-11-03T10:03:00.000Z',
      expiresAt: new Date(Date.parse('2026-11-03T10:01:00Z') + connectionLifetimeMs).toISOString(),
    });
    expect(apps[1]).toMatchObject({ connectedAt: '2026-11-03T10:00:00.000Z', lastUsedAt: null });
    expect(first.clientId).not.toBe(second.clientId);
  });

  it("disconnects at once, only the user's own, and an unknown one is 404", async () => {
    const { target, cookie } = await signedIn();
    const first = await connect(target, cookie);
    time += 60_000;
    const second = await connect(target, cookie);
    const list = async (who: string) =>
      (await target.inject({ method: 'GET', url: '/api/agents', headers: { cookie: who } })).json<{
        apps: { id: string }[];
      }>().apps;
    const newest = (await list(cookie))[0]?.id ?? '';
    const remove = (who: string, id: string, origin = webOrigin) =>
      target.inject({
        method: 'DELETE',
        url: `/api/agents/${id}`,
        headers: { cookie: who, origin },
      });

    const other = await otherSession(target, []);
    expect((await remove(other, newest)).statusCode).toBe(404);
    expect((await remove(cookie, newest, 'https://elsewhere.example.test')).statusCode).toBe(403);
    expect((await remove(cookie, 'not-an-id')).statusCode).toBe(404);
    expect((await remove(cookie, newest)).statusCode).toBe(204);
    expect((await remove(cookie, newest)).statusCode).toBe(404);
    expect(await mcpStatus(target, second.tokens.access_token)).toBe(401);
    expect((await refresh(target, second.clientId, second.tokens.refresh_token)).statusCode).toBe(
      400,
    );
    expect(await mcpStatus(target, first.tokens.access_token)).toBe(200);
    expect(await list(cookie)).toHaveLength(1);
    // Someone without a role can see their own list (and so disconnect).
    expect(await list(other)).toEqual([]);
  });

  it('keeps apps connected when the browser signs out', async () => {
    const { target, cookie } = await signedIn();
    const { tokens } = await connect(target, cookie);
    const out = await target.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { origin: webOrigin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect([303, 200]).toContain(out.statusCode);
    expect(await mcpStatus(target, tokens.access_token)).toBe(200);
    const again = await otherSession(target);
    expect(again).not.toBe('');
  });
});

describe('Admin → Connected apps API', () => {
  /** Two made-up users with connections: the signed-in Admin (two) and another user (one). */
  async function setUp() {
    const { target, cookie } = await signedIn(['Admin']);
    const mine = [await connect(target, cookie)];
    time += 60_000;
    mine.push(await connect(target, cookie));
    const other = await otherSession(target);
    time += 60_000;
    const theirs = await connect(target, other);
    return { target, cookie, other, mine, theirs };
  }

  const call = (target: FastifyInstance, cookie: string, method: 'GET' | 'DELETE', url: string) =>
    target.inject({ method, url, headers: { cookie, origin: webOrigin } });

  const auditRows = () =>
    db.query<{ action: string; user_id: string; user_name: string; details: unknown }>(
      "select action, user_id, user_name, details from audit where action like 'mcp-%' order by id",
    );

  it("lists every user's connections with who they are", async () => {
    const { target, cookie } = await setUp();
    const res = await call(target, cookie, 'GET', '/api/admin/agents');
    expect(res.statusCode).toBe(200);
    const { apps } = res.json<{ apps: Record<string, unknown>[] }>();
    expect(apps.map((app) => app.userId)).toEqual(['made-up-other-user', user.oid, user.oid]);
    expect(apps[0]).toMatchObject({
      userName: 'Made-up Other',
      clientName: 'Made-up agent',
      redirectHost: '127.0.0.1:33418',
    });
    expect(apps[1]).toMatchObject({ userName: user.name });
  });

  it('is for Admins only', async () => {
    const { target, other } = await setUp();
    for (const [method, url] of [
      ['GET', '/api/admin/agents'],
      ['DELETE', '/api/admin/agents'],
      ['DELETE', `/api/admin/agents/users/${user.oid}`],
      ['DELETE', '/api/admin/agents/11111111-1111-4111-8111-111111111111'],
    ] as const) {
      expect((await call(target, other, method, url)).statusCode, url).toBe(403);
    }
    expect((await call(target, '', 'GET', '/api/admin/agents')).statusCode).toBe(401);
    expect(await auditRows()).toEqual([]);
  });

  it('disconnects one connection of any user, at once, and audits it', async () => {
    const { target, cookie, mine, theirs } = await setUp();
    const { apps } = (await call(target, cookie, 'GET', '/api/admin/agents')).json<{
      apps: { id: string; userId: string }[];
    }>();
    const theirId = apps[0]?.id ?? '';
    expect((await call(target, cookie, 'DELETE', `/api/admin/agents/${theirId}`)).statusCode).toBe(
      204,
    );
    expect(await mcpStatus(target, theirs.tokens.access_token)).toBe(401);
    for (const own of mine) expect(await mcpStatus(target, own.tokens.access_token)).toBe(200);
    expect((await call(target, cookie, 'DELETE', `/api/admin/agents/${theirId}`)).statusCode).toBe(
      404,
    );
    expect(await auditRows()).toEqual([
      {
        action: 'mcp-admin-disconnected',
        user_id: user.oid,
        user_name: user.name,
        details: { connectionId: theirId, connections: 1 },
      },
    ]);
  });

  it("disconnects all of one user's connections, and only theirs", async () => {
    const { target, cookie, mine, theirs } = await setUp();
    const res = await call(target, cookie, 'DELETE', `/api/admin/agents/users/${user.oid}`);
    expect(res.json()).toEqual({ disconnected: 2 });
    for (const own of mine) expect(await mcpStatus(target, own.tokens.access_token)).toBe(401);
    expect(await mcpStatus(target, theirs.tokens.access_token)).toBe(200);
    const none = await call(target, cookie, 'DELETE', '/api/admin/agents/users/nobody');
    expect(none.json()).toEqual({ disconnected: 0 });
    expect(await auditRows()).toEqual([
      {
        action: 'mcp-admin-disconnected-user',
        user_id: user.oid,
        user_name: user.name,
        details: { targetUserId: user.oid, connections: 2 },
      },
    ]);
  });

  it('disconnects everything, and audits the count with no names or tokens', async () => {
    const { target, cookie, mine, theirs } = await setUp();
    const res = await call(target, cookie, 'DELETE', '/api/admin/agents');
    expect(res.json()).toEqual({ disconnected: 3 });
    for (const connection of [...mine, theirs]) {
      expect(await mcpStatus(target, connection.tokens.access_token)).toBe(401);
    }
    const rows = await auditRows();
    expect(rows).toEqual([
      {
        action: 'mcp-admin-disconnected-all',
        user_id: user.oid,
        user_name: user.name,
        details: { connections: 3 },
      },
    ]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain('Made-up agent');
    expect(text).not.toContain(theirs.tokens.access_token.slice(6));
    expect((await call(target, cookie, 'GET', '/api/admin/agents')).json()).toEqual({ apps: [] });
  });
});

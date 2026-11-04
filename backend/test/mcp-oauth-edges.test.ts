import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { connectionLifetimeMs } from '../src/mcp-auth/rules.js';
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
  authorizeUrl,
  callTool,
  connect,
  hostedRedirect,
  mcp,
  newPkce,
  registerClient,
} from './mcp-helpers.js';
import { createTestDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

/**
 * Edges of the agents' OAuth server and MCP endpoint that the main tests don't walk: cumulative
 * roles, what a signed-out browser is sent to, what the logs leave out, and the Admin counts.
 * Made-up users and agents only.
 */

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const user = { oid: 'made-up-edge-user', name: 'Made-up Edge Architect' };

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

async function start(logLevel: 'silent' | 'trace' = 'silent') {
  app = await buildTestApp(
    { LOG_LEVEL: logLevel },
    idpOptions(idp, {
      database: DatabaseService.using(db, testConnection, silent),
      now,
      sessionTimeouts: { idleMs: 30 * 24 * 3_600_000, absoluteMs: 30 * 24 * 3_600_000 },
    }),
  );
  return app;
}

async function signedIn(roles: string[], logLevel: 'silent' | 'trace' = 'silent') {
  const target = await start(logLevel);
  withClaims(idp, { roles, ...user });
  const { sessionCookie } = await signIn(target);
  return { target, cookie: sessionCookie };
}

describe('roles are cumulative, as in the web app', () => {
  it.each([[['Modeller']], [['Admin']]])(
    'lets a user with only %j connect an agent and read through it',
    async (roles) => {
      const { target, cookie } = await signedIn(roles);
      const { tokens } = await connect(target, cookie);
      const listed = await callTool(target, tokens.access_token, 'list_models');
      expect(listed.isError).toBe(false);
      expect(listed.value).toEqual({ models: [] });
    },
  );
});

describe('the MCP endpoint takes the token from the header only', () => {
  it('refuses a token in the query or in a form-style body field', async () => {
    const { target, cookie } = await signedIn(['Viewer']);
    const { tokens } = await connect(target, cookie);
    const inQuery = await target.inject({
      method: 'POST',
      url: `/mcp?access_token=${tokens.access_token}`,
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(inQuery.statusCode).toBe(401);
    expect(inQuery.headers['www-authenticate']).toContain('resource_metadata=');
    const otherScheme = await mcp(
      target,
      undefined,
      'tools/list',
      {},
      {
        authorization: `Basic ${tokens.access_token}`,
      },
    );
    expect(otherScheme.statusCode).toBe(401);
    // A refresh token is no access token.
    expect((await mcp(target, tokens.refresh_token, 'tools/list')).statusCode).toBe(401);
  });
});

describe('a signed-out browser on /oauth/authorize', () => {
  it("never logs the agent's state, PKCE challenge or the held request id", async () => {
    const target = await start('trace');
    const logs = captureLogs(target);
    const clientId = await registerClient(target);
    const pkce = newPkce();
    const res = await target.inject({ method: 'GET', url: authorizeUrl(clientId, pkce) });
    expect(res.statusCode).toBe(302);
    const login = res.headers.location as string;
    const held = new URL(
      new URL(login, webOrigin).searchParams.get('returnTo') ?? '',
      webOrigin,
    ).searchParams.get('request');
    expect(held).toMatch(/^sa_rq_/);
    // The sign-in step the browser goes to next carries the held request id in its query.
    await target.inject({ method: 'GET', url: login });
    const text = logs.join('\n');
    expect(text).not.toContain('made-up-state');
    expect(text).not.toContain(pkce.challenge);
    expect(text).not.toContain((held ?? '').slice(6));
  });

  // RFC 9700 section 4.11.2: an authorization server must not redirect automatically to a
  // redirect URI it has no reason to trust, and any https address can be registered without
  // signing in. Before anyone has signed in and seen the consent page, an error is shown on the
  // app's own page, not sent to the registered address.
  it("never sends a signed-out browser straight on to a newly registered agent's address", async () => {
    const target = await start();
    const clientId = await registerClient(target, {
      redirect_uris: [hostedRedirect],
      client_name: 'Made-up agent',
    });
    const res = await target.inject({
      method: 'GET',
      url: authorizeUrl(clientId, newPkce(), {
        redirect_uri: hostedRedirect,
        response_type: 'made-up',
      }),
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string, webOrigin);
    expect(location.origin).toBe(webOrigin);
  });
});

describe('Admin → Connected apps counts', () => {
  // The confirmation says how many end, from the list, so the answer and the audit row count only
  // the connections that were still live.
  it('ends, and counts, only the connections the page listed (not ones already over)', async () => {
    const { target, cookie } = await signedIn(['Admin']);
    await connect(target, cookie);
    // That connection is over; the sweep has not run yet. A new one is live.
    time += connectionLifetimeMs + 60_000;
    await connect(target, cookie);
    const call = (method: 'GET' | 'DELETE', url: string) =>
      target.inject({ method, url, headers: { cookie, origin: webOrigin } });
    const listed = (await call('GET', '/api/admin/agents')).json<{ apps: unknown[] }>().apps;
    expect(listed).toHaveLength(1);
    const ended = await call('DELETE', `/api/admin/agents/users/${user.oid}`);
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toEqual({ disconnected: 1 });
    const [audit] = await db.query<{ details: { connections: number } }>(
      "select details from audit where action = 'mcp-admin-disconnected-user'",
    );
    expect(audit?.details.connections).toBe(1);
  });
});

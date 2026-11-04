import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { webOrigin } from './helpers.js';

/** Made-up AI agents: a native one on a loopback port, and a hosted one. */
export const loopbackRedirect = 'http://127.0.0.1:33418/callback';
export const hostedRedirect = 'https://agent.example.test/oauth/callback';
export const resource = 'http://localhost:5173/mcp';

export interface Pkce {
  verifier: string;
  challenge: string;
}

export function newPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function registerClient(
  app: FastifyInstance,
  body: object = { redirect_uris: [loopbackRedirect], client_name: 'Made-up agent' },
): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/oauth/register', payload: body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ client_id: string }>().client_id;
}

export function authorizeUrl(
  clientId: string,
  pkce: Pkce,
  extra: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams();
  const all: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: loopbackRedirect,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: 'made-up-state',
    resource,
    ...extra,
  };
  for (const [name, value] of Object.entries(all)) if (value !== undefined) params.set(name, value);
  return `/oauth/authorize?${params.toString()}`;
}

/** The user's decision on the consent page (POST /api/agents/requests/:id). */
export function decide(
  app: FastifyInstance,
  cookie: string,
  id: string,
  allow: boolean,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: `/api/agents/requests/${encodeURIComponent(id)}`,
    headers: { cookie, origin: webOrigin },
    payload: { allow },
  });
}

/** The held request's id from the consent page address the authorize step sends the browser to. */
export function heldId(location: string): string | undefined {
  if (!location.startsWith('/agents/connect?')) return undefined;
  return new URL(location, webOrigin).searchParams.get('request') ?? undefined;
}

/**
 * The authorize step for a signed-in browser, then the consent page's decision: the address the
 * agent is sent back to.
 */
export async function authorize(
  app: FastifyInstance,
  cookie: string,
  url: string,
  allow = true,
): Promise<URL> {
  const res = await app.inject({ method: 'GET', url, headers: { cookie } });
  expect(res.statusCode, res.body).toBe(302);
  const location = res.headers.location as string;
  const id = heldId(location);
  // An error is shown on the app's own page, without the consent page.
  if (id === undefined) return new URL(location, webOrigin);
  const decided = await decide(app, cookie, id, allow);
  expect(decided.statusCode, decided.body).toBe(200);
  return new URL(decided.json<{ location: string }>().location);
}

export function form(
  app: FastifyInstance,
  url: string,
  fields: Record<string, string | string[]>,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    for (const item of [value].flat()) body.append(name, item);
  }
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    payload: body.toString(),
  });
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

/** The whole flow for a signed-in browser: register, authorize (allowed), exchange the code. */
export async function connect(
  app: FastifyInstance,
  cookie: string,
): Promise<{ clientId: string; tokens: Tokens }> {
  const clientId = await registerClient(app);
  const pkce = newPkce();
  const back = await authorize(app, cookie, authorizeUrl(clientId, pkce));
  const code = back.searchParams.get('code');
  expect(code).not.toBeNull();
  const res = await form(app, '/oauth/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    code: code ?? '',
    redirect_uri: loopbackRedirect,
    code_verifier: pkce.verifier,
    resource,
  });
  expect(res.statusCode, res.body).toBe(200);
  return { clientId, tokens: res.json<Tokens>() };
}

let nextId = 1;

/** One JSON-RPC call to /mcp with an access token. */
export function mcp(
  app: FastifyInstance,
  token: string | undefined,
  method: string,
  params: object = {},
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    payload: { jsonrpc: '2.0', id: nextId++, method, params },
  });
}

/** Calls a tool and returns its text result parsed, or the error text. */
export async function callTool(
  app: FastifyInstance,
  token: string,
  name: string,
  args: object = {},
): Promise<{ isError: boolean; value: unknown; text: string }> {
  const res = await mcp(app, token, 'tools/call', { name, arguments: args });
  expect(res.statusCode, res.body).toBe(200);
  const result = res.json<{
    result?: { isError?: boolean; content: { type: string; text: string }[] };
    error?: unknown;
  }>();
  if (result.result === undefined) throw new Error(`no result: ${res.body}`);
  const text = result.result.content[0]?.text ?? '';
  const isError = result.result.isError === true;
  return { isError, text, value: isError ? undefined : (JSON.parse(text) as unknown) };
}

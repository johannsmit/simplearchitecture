import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { OAuth2Server } from 'oauth2-mock-server';
import { buildApp, type AppOptions } from '../src/app.js';
import type { Config } from '../src/config.js';
import { loadOefMapping } from '../src/oef/mapping-config.js';

export const webOrigin = 'http://localhost:5173';
export const clientId = '11111111-2222-3333-4444-555555555555';

export const testConfig: Config = {
  PORT: 0,
  HOST: 'localhost',
  TRUST_PROXY: 0,
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  OIDC_ISSUER: 'https://idp.example.test/tenant-a',
  OIDC_ROLES_CLAIM: 'roles',
  OIDC_CLIENT_ID: clientId,
  OIDC_CLIENT_SECRET: 'test-client-secret',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough',
  OIDC_ROLE_ADMIN: 'Admin',
  OIDC_ROLE_MODELLER: 'Modeller',
  OIDC_ROLE_VIEWER: 'Viewer',
  WEB_ORIGIN: webOrigin,
  AUTH_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  COOKIE_SECURE: true,
  // Never the real data/: buildTestApp gives each app its own temporary DATA_DIR. Used directly,
  // this path can't be created, so the app refuses to start instead of writing anywhere.
  DATA_DIR: '/dev/null/use-buildTestApp',
  DATABASE_WAIT_SECONDS: 0,
};

/** A new, empty temporary directory for models. */
export function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'sa-models-'));
}

/**
 * The OEF mapping defaults, pinned for tests. config/oef-mapping.json can change at any time
 * without code changes, so tests don't depend on it.
 */
export const agreedMappingPath = fileURLToPath(
  new URL('./fixtures/oef-mapping-agreed.json', import.meta.url),
);
export const agreedMapping = loadOefMapping(agreedMappingPath);

/**
 * Builds the app with the test config and the pinned OEF mapping. Unless the test sets DATA_DIR
 * or a model store, models go to a temporary directory that is removed when the app closes.
 */
export async function buildTestApp(
  overrides: Partial<Config> = {},
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const ownDataDir =
    overrides.DATA_DIR === undefined && options.modelStore === undefined
      ? tempDataDir()
      : undefined;
  const app = await buildApp(
    { ...testConfig, ...(ownDataDir === undefined ? {} : { DATA_DIR: ownDataDir }), ...overrides },
    {
      oefMapping: agreedMapping,
      ...options,
    },
  );
  if (ownDataDir !== undefined) {
    app.addHook('onClose', () => {
      rmSync(ownDataDir, { recursive: true, force: true });
    });
  }
  return app;
}

/**
 * A local OIDC provider (oauth2-mock-server). It offers both secret methods, as Entra ID does, unless
 * `metadata` says otherwise: its entries replace those of the discovery document, undefined removes one.
 */
export async function startMockIdp(metadata: Record<string, unknown> = {}): Promise<OAuth2Server> {
  const idp = new OAuth2Server();
  await idp.issuer.keys.generate('RS256');
  idp.service.on('beforeWellKnownOpenIdConfiguration', (response: { body: object }) => {
    response.body = JSON.parse(
      JSON.stringify({
        ...response.body,
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        ...metadata,
      }),
    ) as object;
  });
  // Not `idp.start`: its server keeps connections alive for 5 s, and `fetch` in this process reuses
  // them. A long synchronous stretch (PGlite starting) stops both from noticing the time, so the
  // next sign-in writes to a socket the server closes in that moment: ECONNRESET, and the app
  // answers 502. Closing each connection after its response leaves nothing to reuse.
  const server = createServer((request, response) => {
    response.setHeader('Connection', 'close');
    idp.service.requestHandler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  idp.issuer.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  idp.stop = () =>
    new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  return idp;
}

export function idpOptions(idp: OAuth2Server, options: AppOptions = {}): AppOptions {
  if (idp.issuer.url === undefined) throw new Error('mock IdP not started');
  return { oidcIssuer: idp.issuer.url, allowInsecureOidcRequests: true, ...options };
}

/** Adds claims to every token the mock IdP signs until the listener is removed. */
export function withClaims(idp: OAuth2Server, claims: Record<string, unknown>): void {
  idp.service.on('beforeTokenSigning', (token: { payload: Record<string, unknown> }) => {
    Object.assign(token.payload, claims);
  });
}

export function cookieHeader(res: LightMyRequestResponse, name: string): string {
  const cookie = res.cookies.find((c) => c.name === name);
  if (!cookie) throw new Error(`no ${name} cookie in response`);
  return `${name}=${cookie.value}`;
}

export interface SignInResult {
  login: LightMyRequestResponse;
  callback: LightMyRequestResponse;
  /** `name=value` of the session cookie, ready for a Cookie header. Empty if sign-in failed. */
  sessionCookie: string;
}

/**
 * Runs the whole browser flow: /auth/login, the IdP's authorize endpoint (it signs in at once),
 * then /auth/callback with the login cookie. `tamper` can change the callback URL first.
 */
export async function signIn(
  app: FastifyInstance,
  options: { cookies?: string[]; tamper?: (callback: URL) => void; loginUrl?: string } = {},
): Promise<SignInResult> {
  const login = await app.inject({ method: 'GET', url: options.loginUrl ?? '/auth/login' });
  if (login.statusCode !== 302) throw new Error(`login failed: ${login.statusCode}`);
  const authorize = await fetch(login.headers.location as string, { redirect: 'manual' });
  const callbackUrl = new URL(authorize.headers.get('location') ?? '');
  options.tamper?.(callbackUrl);

  const loginCookie = login.cookies.find((c) => c.name.endsWith('sa_login'));
  const cookies = [
    ...(loginCookie ? [`${loginCookie.name}=${loginCookie.value}`] : []),
    ...(options.cookies ?? []),
  ];
  const callback = await app.inject({
    method: 'GET',
    url: `${callbackUrl.pathname}${callbackUrl.search}`,
    headers: cookies.length > 0 ? { cookie: cookies.join('; ') } : {},
  });
  const session = callback.cookies.find((c) => c.name.endsWith('sa_session') && c.value !== '');
  return { login, callback, sessionCookie: session ? `${session.name}=${session.value}` : '' };
}

/**
 * Captures the app's log lines in memory instead of writing them to stdout.
 * Test-only coupling to pino internals: the logger keeps its destination under the `pino.stream`
 * symbol. If pino changes that, this throws instead of silently passing.
 */
export function captureLogs(target: FastifyInstance): string[] {
  const lines: string[] = [];
  for (
    let obj: object | null = target.log;
    obj;
    obj = Object.getPrototypeOf(obj) as object | null
  ) {
    const symbol = Object.getOwnPropertySymbols(obj).find((s) => s.description === 'pino.stream');
    if (symbol) {
      const stream = (
        target.log as unknown as Record<symbol, { write: (line: string) => boolean }>
      )[symbol];
      if (!stream) break;
      stream.write = (line) => {
        lines.push(line);
        return true;
      };
      return lines;
    }
  }
  throw new Error('pino log stream not found: update captureLogs');
}

/** The address a sign-out page (see auth/auth.ts) sends the browser on to, from its automatic refresh. */
export function leavesFor(res: LightMyRequestResponse): URL {
  const content = /http-equiv="refresh" content="0;url=([^"]*)"/.exec(res.body)?.[1];
  if (content === undefined) throw new Error('not a sign-out page');
  return new URL(content.replaceAll('&amp;', '&'));
}

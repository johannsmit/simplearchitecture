import { randomUUID } from 'node:crypto';
import { spacesForRoles, type Role } from '@simplearchitecture/shared';
import { z } from 'zod';
import type { McpAuth } from '../auth/access.js';
import type { Db } from '../db/db.js';
import {
  adminActions,
  OAuthStore,
  type AdminScope,
  type ConnectionListing,
  type IssuedHashes,
  type StoredCode,
} from './oauth-store.js';
import {
  accessTokenLifetimeMs,
  codeLifetimeMs,
  connectionLifetimeMs,
  heldRequestLifetimeMs,
  hashSecret,
  isPkceValue,
  isSecretOf,
  maxClientNameLength,
  maxRedirectUris,
  maxRegisteredClients,
  maxScopeLength,
  maxStateLength,
  newClientId,
  newSecret,
  oauthSweepIntervalMs,
  pkceMatches,
  redirectUriMatches,
  redirectUriProblem,
} from './rules.js';

/**
 * The app's own small OAuth 2.1 authorization server, for AI agents (MCP clients) only. Public
 * clients register themselves (RFC 7591), the user signs in with the app's usual sign-in and
 * allows the agent, and the agent gets short-lived tokens tied to that user and the roles they
 * had at sign-in. Everything is derived from the app's address: no settings of its own.
 *
 * The rules live here, so the routes stay thin. Input is `unknown` (or loosely typed query and
 * form fields) and checked here.
 */

export interface OAuthLog {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

/** An OAuth error answer (RFC 6749 section 5.2, RFC 7591 section 3.2.2, RFC 8707). */
export interface OAuthError {
  error: string;
  error_description: string;
}

export type RegistrationResult =
  | { ok: true; client: Record<string, unknown> }
  | { ok: false; status: 400 | 503; body: OAuthError };

/** A checked authorize request, ready for the consent step. */
export interface AuthorizationRequest {
  clientId: string;
  /** As the client registered it: self-asserted, so shown as text only, with the redirect host. */
  clientName: string;
  redirectUri: string;
  /** Where the browser goes back to: the host the user should recognise. */
  redirectHost: string;
  codeChallenge: string;
  state: string | undefined;
  resource: string;
}

/** A held request as the consent page shows it. Nothing secret: the request itself stays here. */
export interface HeldAuthorization {
  /** As the client registered it: self-asserted, so shown as text only. Null: none given. */
  clientName: string | null;
  redirectHost: string;
  /** The browser goes back to this computer (a native client such as Claude Code). */
  loopback: boolean;
  /** When the connection would end if allowed now (7 days, ms since 1970). */
  connectionEndsAt: number;
}

export type AuthorizationCheck =
  /**
   * Shown on the app's own page, never sent to the client: anyone can register any https
   * address, so until a signed-in user has chosen this client on the consent page, its redirect
   * address is no reason to send a browser there (RFC 9700 section 4.11.2). `error` is the OAuth
   * code, for the log.
   */
  | { kind: 'invalid'; error: string; message: string }
  | { kind: 'valid'; request: AuthorizationRequest };

export type DecisionResult =
  /** Back to the client with a code. */
  | { kind: 'approved'; location: string }
  /** The user said no: back to the client with `access_denied`. */
  | { kind: 'denied'; location: string }
  /** Allow from a user whose roles don't open Viewing: refused, and the request is kept. */
  | { kind: 'not-allowed' };

export interface TokenResult {
  status: 200 | 400 | 401;
  body: object;
}

/** Query and form fields as they arrive: a repeated field is a list. */
export type Fields = Readonly<Record<string, string | string[] | undefined>>;

/** The user who allows an agent: their id, display name and the roles of their browser sign-in. */
export interface ConsentingUser {
  id: string;
  name: string;
  roles: readonly Role[];
}

/** The Admin who disconnects: recorded in the audit row. */
export interface AdminActor {
  id: string;
  name: string;
}

/** The app's address, everything the OAuth server's addresses are built from. */
export function oauthAddresses(webOrigin: string) {
  return {
    issuer: webOrigin,
    resource: `${webOrigin}/mcp`,
    resourceMetadata: `${webOrigin}/.well-known/oauth-protected-resource/mcp`,
    authorization: `${webOrigin}/oauth/authorize`,
    token: `${webOrigin}/oauth/token`,
    registration: `${webOrigin}/oauth/register`,
    revocation: `${webOrigin}/oauth/revoke`,
  };
}

const registrationSchema = z.looseObject({
  redirect_uris: z.array(z.string()).min(1).max(maxRedirectUris),
  client_name: z.string().optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

const grantTypes = ['authorization_code', 'refresh_token'];

function oauthError(error: string, description: string): OAuthError {
  return { error, error_description: description };
}

/**
 * A client's name as plain text on one line, cut to length: control characters and bidi controls
 * (which could reverse what is shown) become spaces. Empty when it gave none.
 */
function cleanName(value: string | undefined): string {
  const controls =
    // eslint-disable-next-line no-control-regex -- control characters are what this removes
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
  const text = (value ?? '').replace(controls, ' ');
  return text.replace(/\s+/g, ' ').trim().slice(0, maxClientNameLength).trim();
}

/** One value of a field, or undefined when it is missing; a repeated field is an error. */
function single(fields: Fields, name: string): string | undefined | Error {
  const value = Object.hasOwn(fields, name) ? fields[name] : undefined;
  if (Array.isArray(value)) return new Error(`The ${name} parameter is repeated.`);
  return value === undefined || value === '' ? undefined : value;
}

export class OAuthService {
  readonly addresses: ReturnType<typeof oauthAddresses>;
  readonly #store: OAuthStore;
  readonly #now: () => number;
  readonly #log: OAuthLog;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: { db: Db; webOrigin: string; now?: () => number; log: OAuthLog }) {
    this.#store = new OAuthStore(options.db);
    this.addresses = oauthAddresses(options.webOrigin);
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
  }

  /** RFC 8414 authorization server metadata. */
  authorizationServerMetadata(): Record<string, unknown> {
    const a = this.addresses;
    return {
      issuer: a.issuer,
      authorization_endpoint: a.authorization,
      token_endpoint: a.token,
      registration_endpoint: a.registration,
      revocation_endpoint: a.revocation,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: grantTypes,
      // Public clients only. Clients pick their method from this list, so it holds only `none`.
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** RFC 9728 protected resource metadata for the MCP endpoint. */
  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.addresses.resource,
      authorization_servers: [this.addresses.issuer],
      bearer_methods_supported: ['header'],
      resource_name: 'SimpleArchitecture',
    };
  }

  /** RFC 7591 dynamic client registration, for public clients. */
  async register(input: unknown): Promise<RegistrationResult> {
    const parsed = registrationSchema.safeParse(input);
    if (!parsed.success) {
      const uris = (input as { redirect_uris?: unknown } | null)?.redirect_uris;
      return {
        ok: false,
        status: 400,
        body:
          uris === undefined ||
          !Array.isArray(uris) ||
          uris.length === 0 ||
          uris.length > maxRedirectUris
            ? oauthError('invalid_redirect_uri', `Send 1 to ${maxRedirectUris} redirect_uris.`)
            : oauthError('invalid_client_metadata', 'The client metadata is not valid.'),
      };
    }
    const metadata = parsed.data;
    for (const uri of metadata.redirect_uris) {
      const problem = redirectUriProblem(uri);
      if (problem !== undefined) {
        return { ok: false, status: 400, body: oauthError('invalid_redirect_uri', problem) };
      }
    }
    const method = metadata.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none') {
      return {
        ok: false,
        status: 400,
        body: oauthError(
          'invalid_client_metadata',
          'Only public clients can register: token_endpoint_auth_method must be none (PKCE).',
        ),
      };
    }
    if (metadata.grant_types?.some((grant) => !grantTypes.includes(grant))) {
      return {
        ok: false,
        status: 400,
        body: oauthError(
          'invalid_client_metadata',
          'Only the authorization_code and refresh_token grant types are supported.',
        ),
      };
    }
    if (metadata.response_types?.some((type) => type !== 'code')) {
      return {
        ok: false,
        status: 400,
        body: oauthError('invalid_client_metadata', 'Only the code response type is supported.'),
      };
    }
    const at = this.#now();
    const redirectUris = [...new Set(metadata.redirect_uris)];
    const client = {
      id: newClientId(),
      name: cleanName(metadata.client_name),
      redirectUris,
    };
    if (!(await this.#store.insertClient(client, at, maxRegisteredClients))) {
      this.#log.warn({ maxClients: maxRegisteredClients }, 'mcp client registration refused: full');
      return {
        ok: false,
        status: 503,
        body: oauthError(
          'temporarily_unavailable',
          'Too many registered clients. Try again later.',
        ),
      };
    }
    this.#log.info(
      { audit: 'mcp-client-registered', clientId: client.id },
      'mcp client registered',
    );
    return {
      ok: true,
      client: {
        client_id: client.id,
        client_id_issued_at: Math.floor(at / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    };
  }

  /**
   * Checks an authorize request (OAuth 2.1 with PKCE S256): the client and redirect URI, then the
   * rest. Every error is shown on the app's own page; only the user's decision on the consent
   * page goes back to the client (with its state and this server's `iss`, RFC 9207).
   */
  async checkAuthorization(query: Fields): Promise<AuthorizationCheck> {
    const clientId = single(query, 'client_id');
    const redirectUri = single(query, 'redirect_uri');
    if (clientId instanceof Error || redirectUri instanceof Error) {
      return {
        kind: 'invalid',
        error: 'invalid_request',
        message: 'The request repeats client_id or redirect_uri.',
      };
    }
    const client = clientId === undefined ? undefined : await this.#store.getClient(clientId);
    if (client === undefined) {
      return {
        kind: 'invalid',
        error: 'invalid_client',
        message: 'The agent is not registered with this app.',
      };
    }
    if (
      redirectUri === undefined ||
      !client.redirectUris.some((registered) => redirectUriMatches(registered, redirectUri))
    ) {
      return {
        kind: 'invalid',
        error: 'invalid_request',
        message: "The agent's redirect address is not one it registered.",
      };
    }

    const state = single(query, 'state');
    const back = (error: string, message: string) => ({ kind: 'invalid' as const, error, message });
    if (state instanceof Error) return back('invalid_request', state.message);
    if (state !== undefined && state.length > maxStateLength) {
      return back('invalid_request', `The state may be at most ${maxStateLength} characters.`);
    }
    const responseType = single(query, 'response_type');
    if (responseType instanceof Error) return back('invalid_request', responseType.message);
    if (responseType !== 'code') {
      return back('unsupported_response_type', 'Only response_type=code is supported.');
    }
    const challenge = single(query, 'code_challenge');
    const method = single(query, 'code_challenge_method');
    if (challenge instanceof Error || method instanceof Error) {
      return back('invalid_request', 'The request repeats a PKCE parameter.');
    }
    if (challenge === undefined || method !== 'S256' || !isPkceValue(challenge)) {
      return back('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    }
    const resource = single(query, 'resource');
    if (resource instanceof Error) return back('invalid_target', resource.message);
    if (resource !== undefined && resource !== this.addresses.resource) {
      return back('invalid_target', `Tokens are only for ${this.addresses.resource}.`);
    }
    const scope = single(query, 'scope');
    if (scope instanceof Error || (scope !== undefined && scope.length > maxScopeLength)) {
      return back('invalid_scope', 'The scope is not valid.');
    }
    // The scope is ignored: the user's roles decide what the agent may read.

    return {
      kind: 'valid',
      request: {
        clientId: client.id,
        clientName: client.name,
        redirectUri,
        redirectHost: new URL(redirectUri).host,
        codeChallenge: challenge,
        state,
        resource: this.addresses.resource,
      },
    };
  }

  /**
   * The user allowed the agent: a code for it, bound to the client, the redirect URI and the PKCE
   * challenge, valid for a minute. The caller has checked the user's roles.
   */
  async #approve(request: AuthorizationRequest, user: ConsentingUser): Promise<string> {
    const at = this.#now();
    const code = newSecret('code');
    const stored: StoredCode = {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      userId: user.id,
      userName: user.name,
      roles: [...user.roles],
      expiresAt: at + codeLifetimeMs,
    };
    await this.#store.insertCode(hashSecret(code), stored, at);
    this.#log.info({ userId: user.id, clientId: request.clientId }, 'mcp agent allowed');
    return this.#back(request, { code });
  }

  /** The user said no: back to the agent with `access_denied`. */
  deny(request: AuthorizationRequest): string {
    return this.#back(request, {
      error: 'access_denied',
      error_description: 'The user did not allow the agent.',
    });
  }

  /**
   * Keeps a checked authorize request for the consent page, for 10 minutes, under a random id
   * (only its hash is stored). The id is what the page's address carries, through the sign-in.
   */
  async holdAuthorization(request: AuthorizationRequest): Promise<string> {
    const id = newSecret('request');
    await this.#store.holdRequest(hashSecret(id), request, this.#now() + heldRequestLifetimeMs);
    return id;
  }

  /**
   * What the consent page shows for a held request: who asks (as the agent says), where the
   * browser goes back to, whether that is this computer, and when the connection would end.
   * The first user to open it holds it. Undefined when the id is unknown, used, expired or held
   * by another user.
   */
  async heldAuthorization(id: string, userId: string): Promise<HeldAuthorization | undefined> {
    const request = await this.#held(id, userId, false);
    if (request === undefined) return undefined;
    const url = new URL(request.redirectUri);
    return {
      clientName: request.clientName === '' ? null : request.clientName,
      redirectHost: request.redirectHost,
      loopback: url.protocol === 'http:',
      connectionEndsAt: this.#now() + connectionLifetimeMs,
    };
  }

  /**
   * The user's decision on a held request, used once: where the browser goes next (back to the
   * agent with a code, or with `access_denied`). A user whose roles don't open Viewing can't
   * allow: that is refused and the request stays, so they can still deny it. Undefined when the
   * id is unknown, used, expired or held by another user.
   */
  async decide(
    id: string,
    user: ConsentingUser,
    allow: boolean,
  ): Promise<DecisionResult | undefined> {
    if (allow && !spacesForRoles(user.roles).includes('viewing')) {
      const held = await this.#held(id, user.id, false);
      if (held === undefined) return undefined;
      this.#log.info({ userId: user.id, clientId: held.clientId }, 'mcp consent refused: no role');
      return { kind: 'not-allowed' };
    }
    const request = await this.#held(id, user.id, true);
    if (request === undefined) return undefined;
    if (!allow) {
      this.#log.info({ userId: user.id, clientId: request.clientId }, 'mcp agent denied');
      return { kind: 'denied', location: this.deny(request) };
    }
    return { kind: 'approved', location: await this.#approve(request, user) };
  }

  /**
   * The token endpoint: the authorization code grant (with the PKCE verifier) and the refresh
   * token grant. Public clients only: the client is named by `client_id`, with no secret.
   */
  async token(form: Fields, sentClientCredentials: boolean): Promise<TokenResult> {
    const bad = (status: 400 | 401, error: string, description: string): TokenResult => ({
      status,
      body: oauthError(error, description),
    });
    if (sentClientCredentials || Object.hasOwn(form, 'client_secret')) {
      return bad(401, 'invalid_client', 'Public clients only: send client_id, with no secret.');
    }
    const fields = {
      grantType: single(form, 'grant_type'),
      clientId: single(form, 'client_id'),
      code: single(form, 'code'),
      redirectUri: single(form, 'redirect_uri'),
      verifier: single(form, 'code_verifier'),
      refreshToken: single(form, 'refresh_token'),
      resource: single(form, 'resource'),
    };
    const repeated = Object.values(fields).find((value) => value instanceof Error);
    if (repeated instanceof Error) return bad(400, 'invalid_request', repeated.message);
    const { grantType, clientId, code, redirectUri, verifier, refreshToken, resource } =
      fields as Record<keyof typeof fields, string | undefined>;

    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      return bad(400, 'unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }
    const client = clientId === undefined ? undefined : await this.#store.getClient(clientId);
    if (client === undefined) return bad(401, 'invalid_client', 'Unknown client.');
    if (resource !== undefined && resource !== this.addresses.resource) {
      return bad(400, 'invalid_target', `Tokens are only for ${this.addresses.resource}.`);
    }

    const at = this.#now();
    const access = newSecret('access');
    const refresh = newSecret('refresh');
    const issue = (connectionEnds: number): IssuedHashes => ({
      accessHash: hashSecret(access),
      accessExpiresAt: Math.min(at + accessTokenLifetimeMs, connectionEnds),
      refreshHash: hashSecret(refresh),
    });
    const tokens = (hashes: IssuedHashes): TokenResult => ({
      status: 200,
      body: {
        access_token: access,
        token_type: 'Bearer',
        expires_in: Math.max(1, Math.floor((hashes.accessExpiresAt - at) / 1000)),
        refresh_token: refresh,
      },
    });

    if (grantType === 'authorization_code') {
      if (code === undefined || redirectUri === undefined || verifier === undefined) {
        return bad(400, 'invalid_request', 'Send code, redirect_uri and code_verifier.');
      }
      if (!isSecretOf('code', code)) return bad(400, 'invalid_grant', 'The code is not valid.');
      const connectionEnds = at + connectionLifetimeMs;
      const hashes = issue(connectionEnds);
      const outcome = await this.#store.exchangeCode(
        hashSecret(code),
        at,
        (stored) => this.#codeProblem(stored, client.id, redirectUri, verifier, at),
        { id: randomUUID(), expiresAt: connectionEnds, hashes },
      );
      switch (outcome.kind) {
        case 'unknown':
          return bad(400, 'invalid_grant', 'The code is not valid.');
        case 'reused':
          this.#log.warn(
            { clientId: client.id, connectionId: outcome.endedConnection },
            'mcp code used twice: its connection ended',
          );
          return bad(400, 'invalid_grant', 'The code was already used.');
        case 'refused':
          this.#log.info({ clientId: client.id }, 'mcp code refused');
          return bad(400, 'invalid_grant', outcome.reason);
        case 'issued':
          this.#log.info(
            {
              audit: 'mcp-connected',
              userId: outcome.connection.userId,
              clientId: client.id,
              connectionId: outcome.connection.id,
            },
            'mcp agent connected',
          );
          return tokens(hashes);
      }
    }

    if (refreshToken === undefined) return bad(400, 'invalid_request', 'Send refresh_token.');
    if (!isSecretOf('refresh', refreshToken)) {
      return bad(400, 'invalid_grant', 'The refresh token is not valid.');
    }
    let hashes: IssuedHashes | undefined;
    const outcome = await this.#store.rotateRefresh(
      hashSecret(refreshToken),
      client.id,
      at,
      (c) => {
        hashes = issue(c.expiresAt);
        return hashes;
      },
    );
    switch (outcome.kind) {
      case 'unknown':
      case 'wrong-client':
        return bad(400, 'invalid_grant', 'The refresh token is not valid.');
      case 'expired':
        return bad(400, 'invalid_grant', 'The connection has ended. Sign in again.');
      case 'reused':
        this.#log.warn(
          {
            audit: 'mcp-refresh-reused',
            clientId: client.id,
            connectionId: outcome.endedConnection,
          },
          'mcp refresh token used twice: its connection ended',
        );
        return bad(400, 'invalid_grant', 'The refresh token was already used. Sign in again.');
      case 'rotated':
        if (hashes === undefined) throw new Error('refresh rotated without new tokens');
        return tokens(hashes);
    }
  }

  /**
   * RFC 7009 revocation: the connection the token belongs to ends, with all its tokens. Always
   * answered the same way, so it says nothing about the token.
   */
  async revoke(form: Fields, sentClientCredentials: boolean): Promise<TokenResult> {
    if (sentClientCredentials || Object.hasOwn(form, 'client_secret')) {
      return {
        status: 401,
        body: oauthError('invalid_client', 'Public clients only: send client_id, with no secret.'),
      };
    }
    const token = single(form, 'token');
    const clientId = single(form, 'client_id');
    if (token instanceof Error || clientId instanceof Error || token === undefined) {
      return { status: 400, body: oauthError('invalid_request', 'Send one token.') };
    }
    if (clientId === undefined || (await this.#store.getClient(clientId)) === undefined) {
      return { status: 401, body: oauthError('invalid_client', 'Unknown client.') };
    }
    if (isSecretOf('access', token) || isSecretOf('refresh', token)) {
      const ended = await this.#store.endConnectionOfToken(hashSecret(token), clientId);
      if (ended !== undefined) {
        this.#log.info(
          { audit: 'mcp-revoked', userId: ended.userId, clientId, connectionId: ended.id },
          'mcp connection revoked by the agent',
        );
      }
    }
    return { status: 200, body: {} };
  }

  /**
   * Whom an access token is for, or undefined when it is unknown, expired, revoked, from an ended
   * connection or for another address. The roles are those of the sign-in.
   */
  async verifyAccessToken(token: string): Promise<McpAuth | undefined> {
    if (!isSecretOf('access', token)) return undefined;
    const connection = await this.#store.findByAccessToken(hashSecret(token), this.#now());
    if (connection === undefined || connection.resource !== this.addresses.resource)
      return undefined;
    return {
      userId: connection.userId,
      roles: connection.roles,
      clientId: connection.clientId,
      connectionId: connection.id,
    };
  }

  /** The user's own live connections, newest first (the Connected apps page). */
  async listConnections(userId: string): Promise<ConnectionListing[]> {
    return this.#store.listConnections(userId, this.#now());
  }

  /** Disconnects one of the user's agents: its tokens stop working at once. Whether it existed. */
  async disconnect(userId: string, connectionId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/.test(connectionId)) return false;
    const ended = await this.#store.endConnection(userId, connectionId);
    if (ended) {
      this.#log.info({ audit: 'mcp-disconnected', userId, connectionId }, 'mcp agent disconnected');
    }
    return ended;
  }

  /** Every user's live connections, newest first (Admin → Connected apps). */
  async listAllConnections(): Promise<ConnectionListing[]> {
    return this.#store.listConnections(undefined, this.#now());
  }

  /** An Admin disconnects any one connection. Whether it existed. Audited. */
  async disconnectAny(admin: AdminActor, connectionId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/.test(connectionId)) return false;
    return (await this.#adminEnd({ kind: 'one', connectionId }, admin)) > 0;
  }

  /** An Admin disconnects all of one user's connections. How many ended. Audited. */
  async disconnectAllForUser(admin: AdminActor, userId: string): Promise<number> {
    return this.#adminEnd({ kind: 'user', userId }, admin);
  }

  /** An Admin disconnects every connection. How many ended. Audited. */
  async disconnectAll(admin: AdminActor): Promise<number> {
    return this.#adminEnd({ kind: 'all' }, admin);
  }

  async #adminEnd(scope: AdminScope, admin: AdminActor): Promise<number> {
    const count = await this.#store.endConnectionsAsAdmin(scope, admin, this.#now());
    if (count > 0) {
      this.#log.info(
        {
          audit: adminActions[scope.kind],
          userId: admin.id,
          ...(scope.kind === 'one' ? { connectionId: scope.connectionId } : {}),
          ...(scope.kind === 'user' ? { targetUserId: scope.userId } : {}),
          connections: count,
        },
        'mcp connections disconnected by an Admin',
      );
    }
    return count;
  }

  /** Removes what is over now, and then every `intervalMs`. */
  startSweeping(intervalMs: number = oauthSweepIntervalMs): void {
    const run = () => {
      this.sweep().catch((error: unknown) => {
        this.#log.warn({ err: error }, 'expired mcp connections not removed');
      });
    };
    run();
    this.#timer = setInterval(run, intervalMs);
    this.#timer.unref();
  }

  async sweep(): Promise<{ connections: number; clients: number }> {
    const removed = await this.#store.sweep(this.#now());
    if (removed.connections > 0 || removed.clients > 0) {
      this.#log.info(removed, 'ended mcp connections and unused clients removed');
    }
    return removed;
  }

  close(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #codeProblem(
    code: StoredCode,
    clientId: string,
    redirectUri: string,
    verifier: string,
    at: number,
  ): string | undefined {
    if (code.clientId !== clientId) return 'The code was issued to another client.';
    if (code.expiresAt <= at) return 'The code has expired.';
    if (code.redirectUri !== redirectUri)
      return 'The redirect_uri is not the one the code was issued for.';
    if (!isPkceValue(verifier) || !pkceMatches(verifier, code.codeChallenge)) {
      return 'The code_verifier does not match.';
    }
    return undefined;
  }

  async #held(
    id: string,
    userId: string,
    take: boolean,
  ): Promise<AuthorizationRequest | undefined> {
    if (!isSecretOf('request', id)) return undefined;
    const held = await this.#store.heldRequest(hashSecret(id), this.#now(), userId, take);
    return held === undefined
      ? undefined
      : { ...held, redirectHost: new URL(held.redirectUri).host };
  }

  #back(request: AuthorizationRequest, params: Record<string, string>): string {
    return this.#redirect(request.redirectUri, {
      ...params,
      ...(request.state === undefined ? {} : { state: request.state }),
    });
  }

  /** The client's redirect URI with the answer added to its query, and this server's `iss`. */
  #redirect(redirectUri: string, params: Record<string, string>): string {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries({ ...params, iss: this.addresses.issuer })) {
      url.searchParams.set(name, value);
    }
    return url.href;
  }
}

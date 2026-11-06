import { readFile } from 'node:fs/promises';
import { codeOf, DatabaseError } from './db.js';

/**
 * Azure Database for PostgreSQL with Microsoft Entra sign-in: the password of an Entra role is an
 * access token for this resource. The app gets it with the workload's own token (Azure Workload
 * Identity), so it holds no database password.
 */
export const postgresTokenScope = 'https://ossrdbms-aad.database.windows.net/.default';
const jwtBearer = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** A token is renewed this long before it expires, so no connection starts with a stale one. */
export const renewBeforeExpiryMs = 5 * 60_000;
const requestTimeoutMs = 10_000;
/** Entra couldn't be reached: worth waiting for, unlike an answer that refuses the identity. */
export const entraUnreachable = 'ENTRA_UNREACHABLE';

export interface WorkloadIdentity {
  /** Entra's sign-in address, e.g. https://login.microsoftonline.com/ (AZURE_AUTHORITY_HOST). */
  authorityHost: string;
  tenantId: string;
  /** The identity that is a role on the server (AZURE_CLIENT_ID). */
  clientId: string;
  /** The platform's token for the workload (AZURE_FEDERATED_TOKEN_FILE). */
  tokenFile: string;
}

export interface EntraTokenOptions {
  /** Tests: a fake token endpoint and clock. */
  fetch?: typeof fetch;
  now?: () => number;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  error_codes?: unknown;
}

/**
 * The password for node-postgres, called for each new connection: an Entra access token for the
 * server, kept until shortly before it expires and shared by concurrent connections. Failures are
 * DatabaseErrors of kind `identity` whose code is Entra's error number, never its text or a token.
 */
export function entraTokenPassword(
  identity: WorkloadIdentity,
  options: EntraTokenOptions = {},
): () => Promise<string> {
  const post = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const base = identity.authorityHost.endsWith('/')
    ? identity.authorityHost
    : `${identity.authorityHost}/`;
  const endpoint = new URL(`${encodeURIComponent(identity.tenantId)}/oauth2/v2.0/token`, base);
  let current: { token: string; renewAt: number } | undefined;
  let pending: Promise<string> | undefined;

  async function request(): Promise<string> {
    let assertion: string;
    try {
      // Read every time: the platform replaces the file before the token in it expires.
      assertion = (await readFile(identity.tokenFile, 'utf8')).trim();
    } catch (error) {
      throw new DatabaseError('identity', codeOf(error) ?? 'TOKEN_FILE');
    }
    let response: Response;
    try {
      response = await post(endpoint, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: identity.clientId,
          scope: postgresTokenScope,
          client_assertion_type: jwtBearer,
          client_assertion: assertion,
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new DatabaseError('identity', entraUnreachable);
    }
    const json = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok || typeof json.access_token !== 'string' || json.access_token === '') {
      // E.g. AADSTS700213: no federated credential matches the workload's token.
      const [first] = Array.isArray(json.error_codes) ? (json.error_codes as unknown[]) : [];
      throw new DatabaseError(
        'identity',
        Number.isSafeInteger(first) && (first as number) > 0
          ? `AADSTS${String(first)}`
          : `HTTP_${String(response.status)}`,
      );
    }
    // Entra sends the lifetime in seconds (a number, or a string on older endpoints). Without a
    // usable one the token isn't kept: the next connection asks again rather than risk a stale one.
    const lifetimeMs = Number(json.expires_in) * 1_000;
    current =
      Number.isFinite(lifetimeMs) && lifetimeMs > renewBeforeExpiryMs
        ? { token: json.access_token, renewAt: now() + lifetimeMs - renewBeforeExpiryMs }
        : undefined;
    return json.access_token;
  }

  return () => {
    if (current !== undefined && now() < current.renewAt) return Promise.resolve(current.token);
    pending ??= request().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

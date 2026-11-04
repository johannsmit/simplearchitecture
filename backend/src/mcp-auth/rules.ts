import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long things last. A connection's end is fixed at sign-in: refreshing never moves it. */
export const codeLifetimeMs = 60 * 1000;
/** An authorize request waits this long for the user to sign in and decide. */
export const heldRequestLifetimeMs = 10 * 60 * 1000;
export const accessTokenLifetimeMs = 60 * 60 * 1000;
export const connectionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
/** A registered client that has no connection and hasn't been used for this long is removed. */
export const unusedClientLifetimeMs = 30 * 24 * 60 * 60 * 1000;
/**
 * A client that never got a token is removed this long after it registered: long enough to sign
 * in and allow it (claude.ai registers a new client for every connection), short enough that
 * registrations nobody finished don't pile up.
 */
export const neverUsedClientLifetimeMs = 60 * 60 * 1000;
/** How often expired codes, tokens, connections and unused clients are removed. */
export const oauthSweepIntervalMs = 10 * 60 * 1000;

/** Caps on a registration, checked before anything is stored. */
export const registrationBodyLimit = 16 * 1024;
export const maxRedirectUris = 5;
export const maxRedirectUriLength = 512;
export const maxClientNameLength = 100;
/**
 * Most clients kept at once. At the cap, a registration replaces the oldest client that never got
 * a token; only when every client kept has had a token does registration wait.
 */
export const maxRegisteredClients = 5_000;
/** The token and revocation endpoints take a small form. */
export const tokenBodyLimit = 8 * 1024;
/** A client's `state`, returned as it was sent. */
export const maxStateLength = 500;
export const maxScopeLength = 500;

/** Prefixes say what a token is (and help secret scanners); the rest is 256 random bits. */
const prefixes = {
  access: 'sa_at_',
  refresh: 'sa_rt_',
  code: 'sa_ac_',
  request: 'sa_rq_',
} as const;
export type SecretKind = keyof typeof prefixes;

export function newSecret(kind: SecretKind): string {
  return `${prefixes[kind]}${randomBytes(32).toString('base64url')}`;
}

/** A client id: random, but not a secret (public clients). */
export function newClientId(): string {
  return `sa_client_${randomBytes(16).toString('base64url')}`;
}

/** Only this is stored: someone who reads the tables can't use a code or token. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Whether a text has the shape of one of our secrets (so others are refused without a lookup). */
export function isSecretOf(kind: SecretKind, value: string): boolean {
  const prefix = prefixes[kind];
  return value.startsWith(prefix) && /^[A-Za-z0-9_-]{43}$/.test(value.slice(prefix.length));
}

// RFC 7636: 43 to 128 characters of [A-Z] [a-z] [0-9] - . _ ~
const pkcePattern = /^[A-Za-z0-9._~-]{43,128}$/;

export function isPkceValue(value: string): boolean {
  return pkcePattern.test(value);
}

/** S256: BASE64URL(SHA256(verifier)) equals the challenge sent with the authorize request. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost']);

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && loopbackHosts.has(url.hostname);
}

/**
 * Why a redirect URI can't be registered, or undefined when it can: `https:` anywhere, or plain
 * http on this computer only (127.0.0.1, [::1] or localhost: native clients such as Claude Code).
 * No fragment or user name (RFC 6749 section 3.1.2), and no other scheme.
 */
export function redirectUriProblem(value: string): string | undefined {
  if (value.length > maxRedirectUriLength) {
    return `A redirect URI may be at most ${maxRedirectUriLength} characters.`;
  }
  if (!URL.canParse(value)) return 'A redirect URI must be an absolute address.';
  const url = new URL(value);
  if (url.protocol !== 'https:' && !isLoopback(url)) {
    return 'A redirect URI must use https, or http on 127.0.0.1, [::1] or localhost.';
  }
  // On the text too: the parsed address hides an empty fragment or user name.
  if (url.hash !== '' || value.includes('#')) return 'A redirect URI must not have a fragment.';
  if (url.username !== '' || url.password !== '' || /^[^/]*\/\/[^/]*@/.test(value)) {
    return 'A redirect URI must not have a user name or password.';
  }
  return undefined;
}

/**
 * Whether a requested redirect URI is one the client registered: exactly the same text, except
 * that on a loopback address the port may differ (RFC 8252 section 7.3: native clients take any
 * free port). Claude Code registers `http://localhost:<port>/callback` and its port changes.
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  if (!URL.canParse(registered) || !URL.canParse(requested)) return false;
  const a = new URL(registered);
  const b = new URL(requested);
  if (!isLoopback(a) || !isLoopback(b)) return false;
  if (requested.includes('#') || b.username !== '' || b.password !== '') return false;
  return (
    a.hostname === b.hostname &&
    a.pathname === b.pathname &&
    a.search === b.search &&
    // The text after the port must be the same too, not just the parsed parts.
    afterPort(registered) === afterPort(requested)
  );
}

function afterPort(value: string): string {
  const start = value.indexOf('//') + 2;
  const pathStart = value.indexOf('/', start);
  return pathStart === -1 ? '' : value.slice(pathStart);
}

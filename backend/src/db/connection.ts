/**
 * The PostgreSQL connection from DATABASE_URL. Parsed here (not by the driver), so the rules are
 * explicit: TLS with a verified certificate, unless the URL asks for a plain connection with
 * `sslmode=disable` to this machine or to a host with a one-word name (a Compose or Kubernetes
 * service, such as `db`), which can't be a host on the internet. Nothing else in the URL can weaken
 * that. Messages never contain the URL or any part of it.
 */
export interface DatabaseConnection {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** TLS is on. When it is, the certificate and host name are always verified. */
  tls: boolean;
}

export type ParsedDatabaseUrl =
  { ok: true; connection: DatabaseConnection } | { ok: false; message: string };

const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
const tlsModes = new Set(['require', 'verify-ca', 'verify-full']);
// Weaker than verified TLS, but not a plain connection asked for: always refused.
const weakModes = new Set(['allow', 'prefer', 'no-verify']);
// One DNS label with a letter in it. Not all digits or hex: a resolver may read `3221225994` or
// `0xc000020a` as an IPv4 address.
const singleLabel = /^(?!0x[0-9a-f]+$)(?=[0-9-]*[a-z])[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const urlShape =
  'must be a URL like postgres://user:password@host:5432/database?sslmode=verify-full';

export function isLocalHost(host: string): boolean {
  return localHosts.has(host);
}

/** Where a plain connection may go: this machine, or a host with a one-word name. */
function mayBePlain(host: string): boolean {
  return isLocalHost(host) || singleLabel.test(host);
}

const plainRule =
  'may ask for a plain connection (sslmode=disable) only to localhost or a one-word host name such as a Compose service; for any other host, use TLS with a verified certificate: sslmode=verify-full, or leave sslmode out';

export function parseDatabaseUrl(value: string): ParsedDatabaseUrl {
  const fail = (message: string): ParsedDatabaseUrl => ({ ok: false, message });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(urlShape);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return fail(urlShape);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (host === '') return fail(`${urlShape} (the host is missing)`);
  let user: string;
  let password: string;
  let database: string;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    return fail('has a badly percent-encoded user, password or database name');
  }
  if (user === '') return fail(`${urlShape} (the user is missing)`);
  if (database === '' || database.includes('/')) {
    return fail(`${urlShape} (one database name is needed)`);
  }
  const params = [...url.searchParams.keys()];
  if (params.some((key) => key !== 'sslmode') || url.searchParams.getAll('sslmode').length > 1) {
    return fail('supports one parameter only: sslmode');
  }
  const sslmode = url.searchParams.get('sslmode');
  if (
    sslmode !== null &&
    !tlsModes.has(sslmode) &&
    !weakModes.has(sslmode) &&
    sslmode !== 'disable'
  ) {
    return fail('has an unknown sslmode (use verify-full)');
  }
  if (
    sslmode !== null &&
    (weakModes.has(sslmode) || (sslmode === 'disable' && !mayBePlain(host)))
  ) {
    return fail(plainRule);
  }
  return {
    ok: true,
    connection: {
      host,
      port: url.port === '' ? 5432 : Number(url.port),
      database,
      user,
      password,
      // Always on, and verified, unless sslmode=disable asked for a plain connection it allows.
      tls: sslmode !== 'disable',
    },
  };
}

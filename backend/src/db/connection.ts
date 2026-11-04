/**
 * The PostgreSQL connection from DATABASE_URL. Parsed here (not by the driver), so the rules are
 * explicit: TLS with a verified certificate for every host but this machine, and nothing in the
 * URL that could weaken that. Messages never contain the URL or any part of it.
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
const plainModes = new Set(['disable', 'allow', 'prefer', 'no-verify']);
const urlShape =
  'must be a URL like postgres://user:password@host:5432/database?sslmode=verify-full';

export function isLocalHost(host: string): boolean {
  return localHosts.has(host);
}

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
  if (sslmode !== null && !tlsModes.has(sslmode) && !plainModes.has(sslmode)) {
    return fail('has an unknown sslmode (use verify-full)');
  }
  const local = isLocalHost(host);
  if (!local && sslmode !== null && plainModes.has(sslmode)) {
    return fail(
      'must use TLS with a verified certificate for a host other than localhost: use sslmode=verify-full or leave sslmode out',
    );
  }
  return {
    ok: true,
    connection: {
      host,
      port: url.port === '' ? 5432 : Number(url.port),
      database,
      user,
      password,
      // Off for this machine unless asked for; always on (and verified) for any other host.
      tls: local ? sslmode !== null && tlsModes.has(sslmode) : true,
    },
  };
}

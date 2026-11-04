import pg from 'pg';
import type { DatabaseConnection } from './connection.js';

/**
 * The little the app needs from PostgreSQL, so the stores run on node-postgres in the app and on
 * PGlite in tests. Every query is parameterised: `query` takes the values separately, and `exec`
 * (several statements, no values) is for the migration files only.
 */
export interface Queryable {
  query<R extends object>(text: string, values?: readonly unknown[]): Promise<R[]>;
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  /** Runs `task` in a transaction: committed when it resolves, rolled back when it throws. */
  transaction<T>(task: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Opens a fresh connection and runs `select 1`, within `timeoutMs`. Throws DatabaseError. */
  ping(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export type DatabaseFailure =
  'unreachable' | 'tls' | 'auth' | 'missing-database' | 'timeout' | 'other';

/**
 * A database call failed. Driver messages can name the host, the user or values from a query,
 * so they are never kept: only the kind of failure and the error code (a SQLSTATE or a Node code).
 */
export class DatabaseError extends Error {
  override name = 'DatabaseError';
  constructor(
    readonly failure: DatabaseFailure,
    readonly code: string | undefined,
  ) {
    super(`Database call failed (${failure}${code === undefined ? '' : `, ${code}`})`);
  }
}

const unreachableCodes = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ECONNRESET',
  'EPIPE',
]);

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  // Only well-formed codes: never anything that could carry text from the server.
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
}

export function classifyDatabaseError(error: unknown): DatabaseFailure {
  if (error instanceof DatabaseError) return error.failure;
  const code = codeOf(error);
  const message = error instanceof Error ? error.message : '';
  if (code === '28P01' || code === '28000') return 'auth';
  if (code === '3D000') return 'missing-database';
  if (code === '57014' || code === 'ETIMEDOUT') return 'timeout';
  if (code !== undefined && unreachableCodes.has(code)) return 'unreachable';
  if (
    code !== undefined &&
    /^(ERR_TLS|ERR_SSL)|CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)
  ) {
    return 'tls';
  }
  if (/does not support SSL|SSL|TLS/i.test(message)) return 'tls';
  if (/timeout|timed out/i.test(message)) return 'timeout';
  if (/Connection terminated|connect/i.test(message)) return 'unreachable';
  return 'other';
}

export function toDatabaseError(error: unknown): DatabaseError {
  return error instanceof DatabaseError
    ? error
    : new DatabaseError(classifyDatabaseError(error), codeOf(error));
}

/** Small and bounded: the API's queries are few and short. */
export const poolSize = 5;
export const statementTimeoutMs = 15_000;
const connectTimeoutMs = 5_000;

export interface PgDbOptions {
  connection: DatabaseConnection;
  /** Told about errors on idle connections (which would otherwise crash the process). */
  onIdleError: (error: DatabaseError) => void;
}

function clientConfig(options: PgDbOptions): pg.ClientConfig {
  const { connection } = options;
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    // Never `rejectUnauthorized: false`. node-postgres also checks the host name (SNI).
    ssl: connection.tls ? { rejectUnauthorized: true } : false,
    application_name: 'simplearchitecture',
  };
}

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<R extends object>(text: string, values?: readonly unknown[]) {
      try {
        const result = await client.query<R>(text, values === undefined ? undefined : [...values]);
        return result.rows;
      } catch (error) {
        throw toDatabaseError(error);
      }
    },
    async exec(sql: string) {
      try {
        // No values: the simple query protocol, which runs several statements.
        await client.query(sql);
      } catch (error) {
        throw toDatabaseError(error);
      }
    },
  };
}

/** node-postgres behind the Db interface: a small pool with a statement timeout. */
export function createPgDb(options: PgDbOptions): Db {
  const config = clientConfig(options);
  const pool = new pg.Pool({
    ...config,
    max: poolSize,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: connectTimeoutMs,
    statement_timeout: statementTimeoutMs,
    query_timeout: statementTimeoutMs + 5_000,
  });
  pool.on('error', (error) => {
    options.onIdleError(toDatabaseError(error));
  });
  const queries = wrap(pool);
  return {
    ...queries,
    async transaction<T>(task: (tx: Queryable) => Promise<T>): Promise<T> {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        throw toDatabaseError(error);
      }
      const tx = wrap(client);
      let broken = false;
      try {
        await tx.exec('begin');
        const result = await task(tx);
        await tx.exec('commit');
        return result;
      } catch (error) {
        try {
          await client.query('rollback');
        } catch {
          broken = true;
        }
        // The task's own errors (e.g. the store is full) pass through as they are.
        throw error;
      } finally {
        client.release(broken);
      }
    },
    async ping(timeoutMs: number): Promise<void> {
      const client = new pg.Client({
        ...config,
        connectionTimeoutMillis: timeoutMs,
        statement_timeout: timeoutMs,
        query_timeout: timeoutMs,
      });
      // An error after the test (e.g. the server closing) must not crash the process.
      client.on('error', () => undefined);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new DatabaseError('timeout', undefined));
        }, timeoutMs + 1_000);
      });
      try {
        await Promise.race([
          (async () => {
            await client.connect();
            await client.query('select 1');
          })(),
          timeout,
        ]);
      } catch (error) {
        throw toDatabaseError(error);
      } finally {
        clearTimeout(timer);
        await client.end().catch(() => undefined);
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

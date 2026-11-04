import type { DatabaseStatus, DatabaseTestResult } from '@simplearchitecture/shared';
import type { DatabaseConfig } from '../config.js';
import { parseDatabaseUrl, type DatabaseConnection } from './connection.js';
import {
  classifyDatabaseError,
  createPgDb,
  DatabaseError,
  toDatabaseError,
  type DatabaseFailure,
  type Db,
} from './db.js';
import {
  appliedCount,
  loadMigrations,
  migrate,
  MigrationError,
  type Migration,
} from './migrate.js';

/** How long Test connection waits. */
export const connectionTestTimeoutMs = 5_000;

export const notConfiguredMessage = 'Not configured: using file storage.';
export const connectedMessage = 'Connected to the database.';

/** The only texts a failed test can show: driver messages can contain the host or the user. */
export const failureMessages: Record<DatabaseFailure, string> = {
  unreachable: "Can't reach the database server. Check the host, the port and the firewall.",
  tls: 'The secure (TLS) connection failed. Check the server certificate.',
  auth: 'The database refused the sign-in. Check the user and password in DATABASE_URL.',
  'missing-database': "The database doesn't exist on the server. Check the name in DATABASE_URL.",
  timeout: "The database didn't answer in time. Try again later.",
  other: 'The connection test failed. See the API log.',
};

/** How long startup waits for an unreachable database (e.g. one still starting), and how. */
export interface DatabaseWait {
  totalMs: number;
  /** Tests: a fake clock and sleep. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}
const maxRetryDelayMs = 10_000;

/** Failures that waiting can fix. 57P03: the server is starting up or shutting down. */
function worthRetrying(error: unknown): boolean {
  const { failure, code } = toDatabaseError(error);
  return failure === 'unreachable' || failure === 'timeout' || code === '57P03';
}

/**
 * Runs `attempt` until it succeeds, fails in a way waiting won't fix (a wrong password, a bad
 * migration), or `wait.totalMs` has passed, then throws the last error. Waits 1, 2, 4 … 10 seconds
 * between attempts and logs each retry with the kind of failure only (never the URL or password).
 */
export async function waitForDatabase<T>(
  attempt: () => Promise<T>,
  log: DatabaseLogger,
  wait: DatabaseWait,
): Promise<T> {
  const now = wait.now ?? Date.now;
  const sleep =
    wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const start = now();
  for (let tries = 1; ; tries++) {
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof MigrationError || !worthRetrying(error)) throw error;
      const delay = Math.min(
        1_000 * 2 ** (tries - 1),
        maxRetryDelayMs,
        wait.totalMs - (now() - start),
      );
      if (delay <= 0) throw error;
      log.warn(
        {
          failure: classifyDatabaseError(error),
          attempt: tries,
          retryInSeconds: Math.round(delay / 100) / 10,
        },
        'database not reachable yet, retrying',
      );
      await sleep(delay);
    }
  }
}

/** The database can't be used at startup. The message is safe to print (no URL or password). */
export class DatabaseStartError extends Error {
  override name = 'DatabaseStartError';
}

export interface DatabaseLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
  error(details: object, message: string): void;
}

/** What the Admin page may show about the connection: never the password. */
export type ConnectionInfo = Omit<DatabaseConnection, 'password'>;

/**
 * The database behind the API, if any: its status and the connection test for Admin → Database.
 * Routes (and later the MCP server) call this; they never touch the driver.
 */
export class DatabaseService {
  private constructor(
    readonly db: Db | undefined,
    readonly connection: ConnectionInfo | undefined,
    readonly migrations: readonly Migration[],
    private readonly log: DatabaseLogger | undefined,
  ) {}

  /** No DATABASE_URL: file storage. */
  static notConfigured(migrations: readonly Migration[] = loadMigrations()): DatabaseService {
    return new DatabaseService(undefined, undefined, migrations, undefined);
  }

  /** An already open (and migrated) database, e.g. PGlite in tests. */
  static using(
    db: Db,
    connection: ConnectionInfo,
    log: DatabaseLogger,
    migrations: readonly Migration[] = loadMigrations(),
  ): DatabaseService {
    return new DatabaseService(db, connection, migrations, log);
  }

  /**
   * Connects with DATABASE_URL and applies the migrations, before the API listens, waiting a
   * bounded time for a database that isn't reachable yet. Throws DatabaseStartError or
   * MigrationError with a safe message.
   */
  static async connect(
    config: DatabaseConfig,
    log: DatabaseLogger,
    wait: DatabaseWait = { totalMs: config.DATABASE_WAIT_SECONDS * 1_000 },
  ): Promise<DatabaseService> {
    const parsed =
      config.DATABASE_URL === undefined ? undefined : parseDatabaseUrl(config.DATABASE_URL);
    if (!parsed?.ok) throw new DatabaseStartError('DATABASE_URL is not set or not valid.');
    const { host, port, database, user, tls } = parsed.connection;
    const connection: ConnectionInfo = { host, port, database, user, tls };
    const db = createPgDb({
      connection: parsed.connection,
      onIdleError: (error) => {
        log.warn({ failure: error.failure, code: error.code }, 'database connection lost');
      },
    });
    const migrations = loadMigrations();
    try {
      const ran = await waitForDatabase(() => migrate(db, migrations), log, wait);
      log.info({ ran, total: migrations.length }, 'database migrations checked');
    } catch (error) {
      await db.close().catch(() => undefined);
      if (error instanceof MigrationError) throw error;
      const failure = classifyDatabaseError(error);
      const waited = worthRetrying(error)
        ? ` Gave up after waiting ${Math.round(wait.totalMs / 1_000)} seconds.`
        : '';
      throw new DatabaseStartError(
        `The database can't be used. ${failureMessages[failure]}${waited}`,
      );
    }
    return new DatabaseService(db, connection, migrations, log);
  }

  get configured(): boolean {
    return this.db !== undefined;
  }

  async status(): Promise<DatabaseStatus> {
    const total = this.migrations.length;
    const { db, connection } = this;
    if (db === undefined || connection === undefined) {
      return {
        configured: false,
        connected: false,
        host: null,
        port: null,
        database: null,
        user: null,
        tls: false,
        tlsVerified: false,
        serverVersion: null,
        migrations: { applied: null, total },
      };
    }
    const shown = {
      configured: true,
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      tls: connection.tls,
      // TLS is never on without verification (no rejectUnauthorized: false anywhere).
      tlsVerified: connection.tls,
    };
    try {
      const [row] = await db.query<{ version: string }>(
        "select current_setting('server_version') as version",
      );
      const applied = await appliedCount(db, this.migrations);
      return {
        ...shown,
        connected: true,
        serverVersion: row?.version ?? null,
        migrations: { applied, total },
      };
    } catch (error) {
      this.#logFailure(error, 'database status not read');
      return {
        ...shown,
        connected: false,
        serverVersion: null,
        migrations: { applied: null, total },
      };
    }
  }

  /** Opens a fresh connection and runs `select 1`. The message is always one of the fixed texts. */
  async test(): Promise<DatabaseTestResult> {
    if (this.db === undefined) return { ok: false, message: notConfiguredMessage };
    try {
      await this.db.ping(connectionTestTimeoutMs);
      return { ok: true, message: connectedMessage };
    } catch (error) {
      const failure = this.#logFailure(error, 'database connection test failed');
      return { ok: false, message: failureMessages[failure] };
    }
  }

  async close(): Promise<void> {
    await this.db?.close();
  }

  /** Logs the kind of failure and its code only, never the driver's message. */
  #logFailure(error: unknown, message: string): DatabaseFailure {
    const failure = classifyDatabaseError(error);
    const code = error instanceof DatabaseError ? error.code : undefined;
    this.log?.warn({ failure, ...(code === undefined ? {} : { code }) }, message);
    return failure;
  }
}

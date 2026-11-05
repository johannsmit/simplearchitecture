import { PGlite } from '@electric-sql/pglite';
import { toDatabaseError, type Db, type Queryable } from '../src/db/db.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import type { ConnectionInfo } from '../src/db/service.js';

/**
 * PostgreSQL in the test process (PGlite: PostgreSQL compiled to WebAssembly), so tests need no
 * server or Docker. One instance per test file; `resetTestDb` empties it between tests.
 */
interface PgliteLike {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- PGlite's own signature
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  exec(sql: string): Promise<unknown>;
}

function wrap(target: PgliteLike): Queryable {
  return {
    async query<R extends object>(text: string, values?: readonly unknown[]) {
      try {
        return (await target.query<R>(text, values === undefined ? undefined : [...values])).rows;
      } catch (error) {
        throw toDatabaseError(error);
      }
    },
    async exec(sql: string) {
      try {
        await target.exec(sql);
      } catch (error) {
        throw toDatabaseError(error);
      }
    },
  };
}

export interface TestDb extends Db {
  pglite: PGlite;
  /** Makes the next pings fail with this error (undefined: succeed). */
  failPing: unknown;
}

export function pgliteDb(pglite: PGlite): TestDb {
  const db: TestDb = {
    pglite,
    failPing: undefined,
    ...wrap(pglite),
    transaction: (task) => pglite.transaction((tx) => task(wrap(tx))),
    async ping() {
      if (db.failPing !== undefined) throw toDatabaseError(db.failPing);
      await db.query('select 1');
    },
    async close() {
      await pglite.close();
    },
  };
  return db;
}

/** A new in-process database with every migration applied. */
export async function createTestDb(): Promise<TestDb> {
  const db = pgliteDb(new PGlite());
  await migrate(db, loadMigrations());
  return db;
}

/** Removes every row (the schema stays). */
export async function resetTestDb(db: Db): Promise<void> {
  await db.exec(
    'truncate models, elements, relationships, views, view_elements, view_relationships, audit, sessions, branding, mcp_clients, mcp_connections, mcp_authorization_requests, mcp_codes, mcp_tokens',
  );
}

/** Made-up connection details, shown on Admin → Database in tests. */
export const testConnection: ConnectionInfo = {
  host: 'db.example.test',
  port: 5432,
  database: 'made_up_db',
  user: 'made_up_user',
  tls: true,
};

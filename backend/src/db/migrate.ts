import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFromRepoRoot } from '../paths.js';
import type { Db, Queryable } from './db.js';

export interface Migration {
  /** The file's number, e.g. `001`. */
  version: string;
  name: string;
  sql: string;
  checksum: string;
}

/** The schema can't be brought up to date. The message is safe to print. */
export class MigrationError extends Error {
  override name = 'MigrationError';
}

export const migrationsDir = resolveFromRepoRoot('backend/migrations');

const fileName = /^(\d{3})_([a-z0-9_]+)\.sql$/;
// Two API processes starting at once take turns (any fixed number would do).
const migrationLock = 4_120_001;

const trackingTable = `create table if not exists schema_migrations (
  version text primary key,
  name text not null,
  checksum text not null,
  applied_at timestamptz not null default now()
)`;

/** The numbered `.sql` files, in order. Any other `.sql` file is a mistake and refused. */
export function loadMigrations(dir: string = migrationsDir): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const match = fileName.exec(file);
    if (!match) throw new MigrationError(`Migration file ${file} isn't named like 001_name.sql.`);
    const [, version = '', name = ''] = match;
    if (migrations.some((other) => other.version === version)) {
      throw new MigrationError(`Two migration files have the number ${version}.`);
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    migrations.push({
      version,
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

async function appliedMigrations(tx: Queryable): Promise<Map<string, string>> {
  const rows = await tx.query<{ version: string; checksum: string }>(
    'select version, checksum from schema_migrations',
  );
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

/**
 * Applies the migrations that haven't run yet, in order, all in one transaction, and records each
 * in `schema_migrations`. Running it again changes nothing. Refuses a database that has a
 * migration this API doesn't know (it is newer), or whose applied file has since changed.
 */
export async function migrate(db: Db, migrations: readonly Migration[]): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1::bigint)', [migrationLock]);
    await tx.exec(trackingTable);
    const applied = await appliedMigrations(tx);
    for (const version of applied.keys()) {
      if (!migrations.some((migration) => migration.version === version)) {
        throw new MigrationError(
          `The database has migration ${version}, which this version of the API doesn't know. Use a newer API.`,
        );
      }
    }
    let ran = 0;
    for (const migration of migrations) {
      const checksum = applied.get(migration.version);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new MigrationError(
            `Migration ${migration.version} was changed after it was applied. Add a new migration instead.`,
          );
        }
        continue;
      }
      await tx.exec(migration.sql);
      await tx.query(
        'insert into schema_migrations (version, name, checksum) values ($1, $2, $3)',
        [migration.version, migration.name, migration.checksum],
      );
      ran += 1;
    }
    return ran;
  });
}

/** How many of the known migrations the database has. */
export async function appliedCount(db: Db, migrations: readonly Migration[]): Promise<number> {
  const [table] = await db.query<{ present: boolean }>(
    "select to_regclass('schema_migrations') is not null as present",
  );
  if (!table?.present) return 0;
  const applied = await appliedMigrations(db);
  return migrations.filter((migration) => applied.has(migration.version)).length;
}

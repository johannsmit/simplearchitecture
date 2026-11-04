import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migrate, MigrationError } from '../src/db/migrate.js';
import { pgliteDb, type TestDb } from './pglite.js';

const all = loadMigrations();
const through006 = all.filter((migration) => migration.version <= '006');
// Later migrations aren't this test's: it counts what 007 does on top of 006.
const through007 = all.filter((migration) => migration.version <= '007');

const tableExists = async (db: TestDb, name: string): Promise<boolean> => {
  const [row] = await db.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [name],
  );
  return row?.present === true;
};

describe('migration 007', () => {
  const opened: TestDb[] = [];

  const database = async (migrations = through006): Promise<TestDb> => {
    const db = pgliteDb(new PGlite());
    opened.push(db);
    await migrate(db, migrations);
    return db;
  };

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  it('drops the table on a database that holds a stored licence, and keeps everything else', async () => {
    const db = await database();
    await db.query('update licence set licence_file = $1, latest_time_seen_ms = $2 where id = 1', [
      '{"payload":"bWFkZS11cA==","signature":"bWFkZS11cA=="}',
      1_000,
    ]);
    await db.query(
      `insert into models (id, name, created_at, created_by_id, created_by_name, node_count,
         edge_count, graph, metadata, has_nodes, has_edges)
       values ('11111111-1111-4111-8111-111111111111', 'Made-up', now(), 'oid-1', 'Made-up', 0, 0,
         '{"directed":true}', '{}', false, false)`,
    );

    expect(await migrate(db, through007)).toBe(1);

    expect(await tableExists(db, 'licence')).toBe(false);
    expect(await db.query('select id from models')).toHaveLength(1);
  });

  it('keeps the audit rows, also those about licence uploads, and the sessions and branding', async () => {
    const db = await database();
    await db.query(
      `insert into audit (action, user_id, user_name, details)
       values ('licence-uploaded', 'oid-1', 'Made-up', $1)`,
      [JSON.stringify({ licenceId: 'made-up', type: 'annual', expiresAt: '2099-01-01' })],
    );
    const before = await db.query('select * from audit order by id');
    expect(before).toHaveLength(1);

    expect(await migrate(db, through007)).toBe(1);

    expect(await db.query('select * from audit order by id')).toEqual(before);
    for (const table of ['models', 'elements', 'relationships', 'audit', 'sessions', 'branding']) {
      expect(await tableExists(db, table), table).toBe(true);
    }
  });

  it('leaves the licence table as it was if the migration fails', async () => {
    const db = await database();
    await db.query('update licence set licence_file = $1 where id = 1', [
      '{"payload":"bWFkZS11cA=="}',
    ]);
    const failing = through007.map((migration) =>
      migration.version === '007'
        ? { ...migration, sql: `${migration.sql}\nselect 1/0;` }
        : migration,
    );
    await expect(migrate(db, failing)).rejects.toThrow();
    expect(await tableExists(db, 'licence')).toBe(true);
    expect(await db.query('select licence_file from licence')).toHaveLength(1);
    expect(await migrate(db, through007)).toBe(1);
  });

  it('runs on a database whose licence row is empty', async () => {
    const db = await database();
    expect(await migrate(db, through007)).toBe(1);
    expect(await tableExists(db, 'licence')).toBe(false);
  });

  it('runs on a brand new database, and running again changes nothing', async () => {
    const db = await database(all);
    expect(await tableExists(db, 'licence')).toBe(false);
    expect(await migrate(db, all)).toBe(0);
  });

  it('means an older image refuses the migrated database', async () => {
    const db = await database(all);
    await expect(migrate(db, through006)).rejects.toThrow(MigrationError);
  });

  it('leaves the applied migrations byte for byte as they were: the API refuses to start if not', () => {
    expect(
      Object.fromEntries(through006.map((migration) => [migration.version, migration.checksum])),
    ).toEqual({
      '001': '884ce0e35691243ced77707d4f8123fa8339ec1254b103fa8a9b2e0627099bbf',
      '002': 'e819fde833f1a754ada6014d135e2451305a7c62b14309cd374e5b0063b1cfc8',
      '003': '238e13ee87fea6c3fffcc2d15256f493ade710d002fff1284ffe42b4109f38e0',
      '004': '792ec9ac2ccd20ee39e4a985ea9a2b22d7870cc01ec23aef4c5dbc9281492559',
      '005': '66a1fedabbb997ca83a4d788238445abc8184be214a3e75fa1aa229d27d36a54',
      '006': '385114328467c2e9f7fbeae0da3d626bb79b44ad2408a4977544463487df26a3',
    });
  });
});

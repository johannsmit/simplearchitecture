import type { LogsResponse } from '@simplearchitecture/shared';
import type { FastifyInstance } from 'fastify';
import type { OAuth2Server } from 'oauth2-mock-server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from '../src/db/service.js';
import { LogAccessError, LogQueryError, LogService } from '../src/logs/log-service.js';
import { AppLogSink, retentionMs, rowOf } from '../src/logs/log-sink.js';
import {
  buildTestApp,
  captureLogs,
  idpOptions,
  signIn,
  startMockIdp,
  webOrigin,
  withClaims,
} from './helpers.js';
import { callTool, connect, mcp } from './mcp-helpers.js';
import { createTestDb, resetTestDb, testConnection, type TestDb } from './pglite.js';

/** Admin → Logs and get_logs: the app's log lines, stored in app_logs and read back. */

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
const admin = ['Admin'];
const reader = { userId: 'made-up-admin', roles: admin, via: 'web' } as const;
const hour = 3_600_000;
const day = 24 * hour;
// A fixed day, noon UTC: 2026-03-10.
const noon = Date.UTC(2026, 2, 10, 12);

let db: TestDb;
let idp: OAuth2Server;

beforeAll(async () => {
  db = await createTestDb();
  idp = await startMockIdp();
});

afterAll(async () => {
  await idp.stop();
  await db.close();
});

beforeEach(async () => {
  await resetTestDb(db);
});

async function insert(
  time: number,
  level: number,
  msg: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.query('insert into app_logs (time, level, msg, extra) values ($1, $2, $3, $4)', [
    new Date(time).toISOString(),
    level,
    msg,
    JSON.stringify(extra),
  ]);
}

async function storedCount(): Promise<number> {
  const [row] = await db.query<{ count: number }>('select count(*)::int as count from app_logs');
  return row?.count ?? 0;
}

describe('LogService', () => {
  const service = () => new LogService(db, silent, () => noon);

  it('returns the entries of the days asked for, newest first', async () => {
    await insert(noon - day, 30, 'the day before');
    await insert(noon - 12 * hour, 30, 'first thing'); // 00:00 UTC
    await insert(noon, 30, 'midday');
    await insert(noon + 11 * hour, 40, 'late');
    await insert(noon + 12 * hour, 30, 'the next day'); // 00:00 UTC next day

    const result = await service().query(reader, { from: '2026-03-10', to: '2026-03-10' });
    expect(result.truncated).toBe(false);
    expect(result.entries.map((entry) => entry.msg)).toEqual(['late', 'midday', 'first thing']);
    expect(result.entries[0]).toMatchObject({
      time: new Date(noon + 11 * hour).toISOString(),
      level: 'warn',
      extra: {},
    });
    expect(result.entries[0]?.id).toMatch(/^\d+$/);

    const both = await service().query(reader, { from: '2026-03-09', to: '2026-03-10' });
    expect(both.entries.map((entry) => entry.msg)).toContain('the day before');
  });

  it('reads the days at the offset from UTC it is given', async () => {
    await insert(noon - 12 * hour - 30 * 60_000, 30, '23:30 UTC the day before');
    await insert(noon + 11 * hour + 30 * 60_000, 30, '23:30 UTC');
    // One hour ahead of UTC (Date.getTimezoneOffset: -60): the day starts at 23:00 UTC.
    const result = await service().query(reader, {
      from: '2026-03-10',
      to: '2026-03-10',
      tzOffset: '-60',
    });
    expect(result.entries.map((entry) => entry.msg)).toEqual(['23:30 UTC the day before']);
  });

  it('reads each end of the range at its own offset when a clock change falls between', async () => {
    // Two hours ahead of UTC on 2026-03-28, one hour ahead on 2026-03-30 (made-up clock change):
    // the range starts at 22:00 UTC on 2026-03-27 and ends at 23:00 UTC on 2026-03-30.
    const start = Date.UTC(2026, 2, 27, 22);
    const end = Date.UTC(2026, 2, 30, 23);
    await insert(start - 60_000, 30, 'just before the start');
    await insert(start, 30, 'the start');
    await insert(end - 60_000, 30, 'just before the end');
    await insert(end, 30, 'the end');
    const result = await service().query(reader, {
      from: '2026-03-28',
      to: '2026-03-30',
      tzOffset: '-120',
      toTzOffset: '-60',
    });
    expect(result.entries.map((entry) => entry.msg)).toEqual(['just before the end', 'the start']);

    // Without toTzOffset both ends use tzOffset: one offset for the whole range ends it an hour
    // early, or starts it an hour late.
    const same = await service().query(reader, {
      from: '2026-03-28',
      to: '2026-03-30',
      tzOffset: '-120',
    });
    expect(same.entries.map((entry) => entry.msg)).toEqual(['the start']);
    const shifted = await service().query(reader, {
      from: '2026-03-28',
      to: '2026-03-30',
      tzOffset: '-60',
    });
    expect(shifted.entries.map((entry) => entry.msg)).toEqual(['just before the end']);
  });

  it('keeps the entries at the level asked for or above', async () => {
    await insert(noon, 20, 'debug');
    await insert(noon + 1, 30, 'info');
    await insert(noon + 2, 40, 'warn');
    await insert(noon + 3, 50, 'error');
    await insert(noon + 4, 60, 'fatal');
    const at = async (level?: string) =>
      (await service().query(reader, { from: '2026-03-10', to: '2026-03-10', level })).entries.map(
        (entry) => entry.level,
      );
    expect(await at()).toEqual(['fatal', 'error', 'warn', 'info', 'debug']);
    expect(await at('warn')).toEqual(['fatal', 'error', 'warn']);
    expect(await at('error')).toEqual(['fatal', 'error']);
  });

  it('returns the newest 1,000 and says when more matched', async () => {
    await db.query(
      `insert into app_logs (time, level, msg, extra)
       select $1::timestamptz + make_interval(secs => n), 30, 'entry ' || n, '{}'::jsonb
       from generate_series(1, 1001) as n`,
      [new Date(noon - 6 * hour).toISOString()],
    );
    const result = await service().query(reader, { from: '2026-03-10', to: '2026-03-10' });
    expect(result.entries).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(result.entries[0]?.msg).toBe('entry 1001');
    expect(result.entries.at(-1)?.msg).toBe('entry 2');

    await db.query(`delete from app_logs where msg = 'entry 1'`);
    expect(
      (await service().query(reader, { from: '2026-03-10', to: '2026-03-10' })).truncated,
    ).toBe(false);
  });

  it('never returns a field named like a credential, at any depth', async () => {
    await insert(noon, 30, 'stored before the checks', {
      headers: { authorization: 'Bearer made-up-token', accept: 'text/html' },
      password: 'made-up-password',
      nested: [{ clientSecret: 'made-up-secret', refresh_token: 'made-up-refresh' }],
      userId: 'made-up-user',
    });
    const [entry] = (await service().query(reader, { from: '2026-03-10', to: '2026-03-10' }))
      .entries;
    expect(entry?.extra).toEqual({
      headers: { authorization: '[Redacted]', accept: 'text/html' },
      password: '[Redacted]',
      nested: [{ clientSecret: '[Redacted]', refresh_token: '[Redacted]' }],
      userId: 'made-up-user',
    });
    expect(JSON.stringify(entry)).not.toMatch(/made-up-(token|password|secret|refresh)/);
  });

  it('masks user ids and client addresses for an agent, and keeps them in full on the web', async () => {
    const extra = {
      audit: 'model-saved',
      userId: 'made-up-user-0001',
      targetUserId: 'made-up-user-0002',
      req: { method: 'GET', url: '/api/models', remoteAddress: '203.0.113.45', remotePort: 51234 },
      nested: { list: [{ userId: 'made-up-user-0003' }] },
      clientId: 'made-up-client',
    };
    await insert(noon, 30, 'request completed', extra);
    const query = { from: '2026-03-10', to: '2026-03-10' };

    const web = await service().query(reader, query);
    expect(web.entries[0]?.extra).toEqual(extra);

    const agent = await service().query({ ...reader, via: 'mcp' }, query);
    expect(agent.entries[0]).toMatchObject({ msg: 'request completed', level: 'info' });
    expect(agent.entries[0]?.extra).toEqual({
      audit: 'model-saved',
      userId: '*****0001',
      targetUserId: '*****0002',
      req: { method: 'GET', url: '/api/models', remoteAddress: '*****3.45', remotePort: 51234 },
      nested: { list: [{ userId: '*****0003' }] },
      clientId: 'made-up-client',
    });
    expect(JSON.stringify(agent)).not.toMatch(/made-up-user|203\.0\.113/);
  });

  it.each([
    ['no dates', {}, 'Choose a From date.'],
    ['no To', { from: '2026-03-10' }, 'Choose a To date.'],
    ['a date that does not exist', { from: '2026-02-30', to: '2026-03-01' }, 'YYYY-MM-DD'],
    ['another date format', { from: '10/03/2026', to: '2026-03-10' }, 'YYYY-MM-DD'],
    ['To before From', { from: '2026-03-10', to: '2026-03-09' }, "To can't be before From."],
    ['32 days', { from: '2026-03-01', to: '2026-04-01' }, 'Choose 31 days or fewer.'],
    ['an unknown level', { from: '2026-03-10', to: '2026-03-10', level: 'loud' }, 'level'],
    ['an offset too far', { from: '2026-03-10', to: '2026-03-10', tzOffset: 900 }, 'tzOffset'],
    [
      'an offset that is not a number',
      { from: '2026-03-10', to: '2026-03-10', tzOffset: 'x' },
      'tzOffset',
    ],
    [
      'an end offset too far',
      { from: '2026-03-10', to: '2026-03-10', tzOffset: 0, toTzOffset: -900 },
      'toTzOffset must be a whole number of minutes',
    ],
    [
      'an end offset that is not whole',
      { from: '2026-03-10', to: '2026-03-10', toTzOffset: '30.5' },
      'toTzOffset must be a whole number of minutes',
    ],
  ])('refuses %s', async (_name, query, message) => {
    const error = await service()
      .query(reader, query)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LogQueryError);
    expect((error as Error).message).toContain(message);
  });

  it('accepts 31 days, both counted', async () => {
    await insert(Date.UTC(2026, 2, 1, 1), 30, 'first day');
    await insert(Date.UTC(2026, 2, 31, 23), 30, 'last day');
    const result = await service().query(reader, { from: '2026-03-01', to: '2026-03-31' });
    expect(result.entries.map((entry) => entry.msg)).toEqual(['last day', 'first day']);
  });

  it('is for Admins only, whatever the caller', async () => {
    await insert(noon, 30, 'secret-free but Admin only');
    for (const roles of [['Modeller'], ['Viewer'], [], ['admin']]) {
      await expect(
        service().query({ ...reader, roles }, { from: '2026-03-10', to: '2026-03-10' }),
      ).rejects.toBeInstanceOf(LogAccessError);
    }
  });

  it('logs each answered read with the reader, the days and counts, never the entries', async () => {
    await insert(noon, 30, 'made-up entry text', { ip: '192.0.2.1' });
    const lines: { details: Record<string, unknown>; message: string }[] = [];
    const log = {
      info: (details: object, message: string) => lines.push({ details: { ...details }, message }),
    };
    const logged = new LogService(db, log, () => noon);

    await logged.query(reader, { from: '2026-03-10', to: '2026-03-10' });
    await logged.query(
      { userId: 'made-up-agent-user', roles: admin, via: 'mcp' },
      { from: '2026-03-09', to: '2026-03-10', level: 'warn' },
    );
    expect(lines).toEqual([
      {
        message: 'logs read',
        details: {
          audit: 'logs-read',
          userId: 'made-up-admin',
          via: 'web',
          from: '2026-03-10',
          to: '2026-03-10',
          minLevel: null,
          entries: 1,
          truncated: false,
        },
      },
      {
        message: 'logs read',
        details: {
          audit: 'logs-read',
          userId: 'made-up-agent-user',
          via: 'mcp',
          from: '2026-03-09',
          to: '2026-03-10',
          minLevel: 'warn',
          entries: 0,
          truncated: false,
        },
      },
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/made-up entry text|192\.0\.2\.1/);
  });

  it('logs no read when it refuses the caller or the query', async () => {
    const lines: object[] = [];
    const logged = new LogService(db, { info: (details) => lines.push(details) }, () => noon);
    await expect(
      logged.query({ ...reader, roles: ['Modeller'] }, { from: '2026-03-10', to: '2026-03-10' }),
    ).rejects.toBeInstanceOf(LogAccessError);
    await expect(
      logged.query(reader, { from: '2026-03-10', to: '2026-03-01' }),
    ).rejects.toBeInstanceOf(LogQueryError);
    expect(lines).toEqual([]);
  });

  it('gives today in UTC', () => {
    expect(new LogService(db, silent, () => Date.UTC(2026, 2, 10, 23, 59)).today()).toBe(
      '2026-03-10',
    );
  });
});

describe('AppLogSink', () => {
  const line = (fields: Record<string, unknown>) =>
    `${JSON.stringify({ level: 30, time: noon, pid: 1, hostname: 'made-up-host', msg: 'hello', ...fields })}\n`;

  it('keeps the message, level and time in columns and the other fields as details', () => {
    expect(rowOf(line({ reqId: 'req-1', res: { statusCode: 200 } }), 0)).toEqual({
      time: new Date(noon).toISOString(),
      level: 30,
      msg: 'hello',
      extra: { reqId: 'req-1', res: { statusCode: 200 } },
    });
    expect(rowOf('not json', 0)).toBeUndefined();
    expect(rowOf('[1, 2]', 0)).toBeUndefined();
    expect(rowOf(JSON.stringify({ msg: 'no level' }), 0)).toBeUndefined();
  });

  it('blanks credential-named fields, cuts long messages and leaves out huge details', () => {
    const row = rowOf(
      line({
        msg: 'x'.repeat(5000),
        cookie: 'sid=made-up-cookie',
        req: { headers: { 'x-api-key': 'made-up-key' } },
        DATABASE_URL: 'postgres://made-up',
        note: 'nul\u0000char',
        half: 'a\ud800b',
      }),
      0,
    );
    expect(row?.msg).toHaveLength(2000);
    expect(row?.extra).toEqual({
      cookie: '[Redacted]',
      req: { headers: { 'x-api-key': '[Redacted]' } },
      DATABASE_URL: '[Redacted]',
      note: 'nulchar',
      half: 'a\ufffdb',
    });
    expect(rowOf(line({ big: 'y'.repeat(40_000) }), 0)?.extra).toEqual({
      detailsLeftOut: 'The details were too large to keep.',
    });
  });

  it('stores lines in batches, including those queued before the database was there', async () => {
    const sink = new AppLogSink({ now: () => noon, batchSize: 2, flushMs: 60_000 });
    sink.write(line({ msg: 'before' }));
    sink.attach(db);
    sink.write(line({ msg: 'after' }));
    sink.write(line({ msg: 'third' }));
    await sink.flush();
    const rows = await db.query<{ msg: string }>('select msg from app_logs order by id');
    expect(rows.map((row) => row.msg)).toEqual(['before', 'after', 'third']);
    await sink.close();
    sink.write(line({ msg: 'after close' }));
    await sink.flush();
    expect(await storedCount()).toBe(3);
  });

  it('removes entries older than 30 days as it writes', async () => {
    const now = noon;
    await insert(now - retentionMs - hour, 30, 'too old');
    await insert(now - retentionMs + hour, 30, 'kept');
    const sink = new AppLogSink({ now: () => now, flushMs: 60_000 });
    sink.attach(db);
    sink.write(line({ msg: 'new' }));
    await sink.close();
    const rows = await db.query<{ msg: string }>('select msg from app_logs order by time');
    expect(rows.map((row) => row.msg)).toEqual(['kept', 'new']);
  });

  it('drops lines it cannot store, says so once, and never throws', async () => {
    const problems: string[] = [];
    let time = noon;
    const failing = {
      query: () => Promise.reject(new Error('made-up failure')),
      exec: () => Promise.reject(new Error('made-up failure')),
    };
    const sink = new AppLogSink({
      now: () => time,
      flushMs: 60_000,
      maxQueued: 2,
      onProblem: (message) => problems.push(message),
    });
    sink.attach(failing);
    sink.write(line({}));
    await sink.flush();
    sink.write(line({}));
    await sink.flush();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not stored');
    expect(problems[0]).not.toContain('made-up failure');

    // A full queue drops the newest lines.
    for (let i = 0; i < 5; i++) sink.write(line({}));
    time += 2 * 60_000;
    await sink.flush();
    expect(problems).toHaveLength(2);
    await sink.close();
  });
});

describe('capture from the app', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const database = () => DatabaseService.using(db, testConnection, silent);

  it('stores what the app logs, redacted, at LOG_LEVEL and above', async () => {
    const sink = new AppLogSink({ flushMs: 60_000 });
    app = await buildTestApp({ LOG_LEVEL: 'info' }, { database: database(), appLogs: sink });
    // Standard output is kept for the test; the database still gets every line.
    const lines = captureLogs(app);
    app.get('/log-things', { config: { access: 'public' } }, (request) => {
      request.log.debug('below the level');
      request.log.warn(
        { headers: { authorization: 'Bearer made-up-app-token' }, clientSecret: 'made-up-secret' },
        'something to look at',
      );
      return 'ok';
    });
    await app.inject({ method: 'GET', url: '/log-things' });
    await sink.flush();

    const rows = await db.query<{ level: number; msg: string; extra: Record<string, unknown> }>(
      'select level, msg, extra from app_logs order by id',
    );
    const messages = rows.map((row) => row.msg);
    expect(messages).toContain('incoming request');
    expect(messages).toContain('request completed');
    expect(messages).toContain('something to look at');
    expect(messages).not.toContain('below the level');
    expect(rows.find((row) => row.msg === 'something to look at')).toMatchObject({
      level: 40,
      extra: { headers: { authorization: '[Redacted]' }, clientSecret: '[Redacted]' },
    });
    expect(JSON.stringify(rows)).not.toMatch(/made-up-app-token|made-up-secret/);
    expect(lines.join('')).toContain('something to look at');
  });

  it('stores nothing when the level is silent, and nothing at all when switched off', async () => {
    const sink = new AppLogSink({ flushMs: 60_000 });
    app = await buildTestApp({ LOG_LEVEL: 'silent' }, { database: database(), appLogs: sink });
    await app.inject({ method: 'GET', url: '/api/health' });
    await sink.flush();
    expect(await storedCount()).toBe(0);
    await app.close();

    app = await buildTestApp({ LOG_LEVEL: 'info' }, { database: database(), appLogs: false });
    const lines = captureLogs(app);
    await app.inject({ method: 'GET', url: '/api/health' });
    expect(lines.join('')).toContain('request completed');
    expect(await storedCount()).toBe(0);
  });

  it('writes what is queued when the app closes', async () => {
    app = await buildTestApp({ LOG_LEVEL: 'info' }, { database: database() });
    captureLogs(app);
    await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();
    app = undefined;
    const rows = await db.query<{ msg: string }>('select msg from app_logs');
    expect(rows.map((row) => row.msg)).toContain('request completed');
  });
});

describe('GET /api/admin/logs', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    idp.service.removeAllListeners('beforeTokenSigning');
    await app?.close();
    app = undefined;
  });

  async function started(logLevel: 'silent' | 'info' = 'silent'): Promise<FastifyInstance> {
    app = await buildTestApp(
      { LOG_LEVEL: logLevel },
      idpOptions(idp, {
        database: DatabaseService.using(db, testConnection, silent),
        appLogs: false,
      }),
    );
    return app;
  }

  async function cookieFor(target: FastifyInstance, roles: string[]): Promise<string> {
    idp.service.removeAllListeners('beforeTokenSigning');
    withClaims(idp, { roles, oid: `made-up-${roles.join('-') || 'none'}`, name: 'Made-up Person' });
    return (await signIn(target)).sessionCookie;
  }

  const get = (target: FastifyInstance, query: string, cookie?: string) =>
    target.inject({
      method: 'GET',
      url: `/api/admin/logs${query}`,
      headers: cookie === undefined ? {} : { cookie },
    });

  it('is for Admins only', async () => {
    const target = await started();
    const query = '?from=2026-03-10&to=2026-03-10';
    expect((await get(target, query)).statusCode).toBe(401);
    for (const roles of [['Modeller'], ['Viewer']]) {
      const res = await get(target, query, await cookieFor(target, roles));
      expect(res.statusCode, roles.join()).toBe(403);
    }
  });

  it('returns the entries for an Admin, newest first, at the level asked for', async () => {
    await insert(noon, 30, 'info entry', { reqId: 'req-7' });
    await insert(noon + 1000, 50, 'error entry');
    const target = await started();
    const cookie = await cookieFor(target, admin);

    const res = await get(target, '?from=2026-03-10&to=2026-03-10', cookie);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<LogsResponse>();
    expect(body.truncated).toBe(false);
    expect(body.entries.map(({ level, msg, extra }) => ({ level, msg, extra }))).toEqual([
      { level: 'error', msg: 'error entry', extra: {} },
      { level: 'info', msg: 'info entry', extra: { reqId: 'req-7' } },
    ]);

    const errors = await get(target, '?from=2026-03-10&to=2026-03-10&level=error', cookie);
    expect(errors.json<LogsResponse>().entries.map((entry) => entry.msg)).toEqual(['error entry']);
  });

  it('returns user ids and client addresses in full', async () => {
    const extra = { userId: 'made-up-user-0001', req: { remoteAddress: '203.0.113.45' } };
    await insert(noon, 30, 'signed in', extra);
    const target = await started();
    const res = await get(target, '?from=2026-03-10&to=2026-03-10', await cookieFor(target, admin));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<LogsResponse>().entries[0]?.extra).toEqual(extra);
  });

  it('logs who read the logs, once per read, and nothing for a refused or invalid read', async () => {
    await insert(noon, 30, 'made-up entry text');
    const target = await started('info');
    const modeller = await cookieFor(target, ['Modeller']);
    const cookie = await cookieFor(target, admin);
    const lines = captureLogs(target);
    const reads = () =>
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.audit === 'logs-read');

    expect((await get(target, '?from=2026-03-10&to=2026-03-10', modeller)).statusCode).toBe(403);
    expect((await get(target, '?from=2026-03-10&to=2026-03-01', cookie)).statusCode).toBe(400);
    expect(reads()).toEqual([]);

    const res = await get(target, '?from=2026-03-09&to=2026-03-10&level=info', cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(reads()).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'logs read',
        audit: 'logs-read',
        userId: 'made-up-Admin',
        via: 'web',
        from: '2026-03-09',
        to: '2026-03-10',
        minLevel: 'info',
        entries: 1,
        truncated: false,
      }),
    ]);
    expect(lines.join('')).not.toContain('made-up entry text');
  });

  it.each([
    ['no dates', '', 'Choose a From date.'],
    ['no To', '?from=2026-03-10', 'Choose a To date.'],
    ['To before From', '?from=2026-03-10&to=2026-03-01', "To can't be before From."],
    ['more than 31 days', '?from=2026-01-01&to=2026-03-10', 'Choose 31 days or fewer.'],
    ['a bad date', '?from=2026-13-01&to=2026-03-10', 'YYYY-MM-DD'],
    ['a bad level', '?from=2026-03-10&to=2026-03-10&level=verbose', 'level'],
    ['an offset too far', '?from=2026-03-10&to=2026-03-10&tzOffset=-9999', 'tzOffset'],
    [
      'an end offset too far',
      '?from=2026-03-10&to=2026-03-10&tzOffset=-60&toTzOffset=x',
      'toTzOffset must be',
    ],
    ['a date given twice', '?from=2026-03-10&from=2026-03-11&to=2026-03-12', 'from'],
  ])('refuses %s with 400', async (_name, query, message) => {
    const target = await started();
    const res = await get(target, query, await cookieFor(target, admin));
    expect(res.statusCode).toBe(400);
    expect(res.json<{ message: string }>().message).toContain(message);
  });
});

describe('get_logs (MCP)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    idp.service.removeAllListeners('beforeTokenSigning');
    await app?.close();
    app = undefined;
  });

  async function agentFor(
    roles: string[],
    logLevel: 'silent' | 'info' = 'silent',
  ): Promise<{ target: FastifyInstance; token: string }> {
    app = await buildTestApp(
      { LOG_LEVEL: logLevel },
      idpOptions(idp, {
        database: DatabaseService.using(db, testConnection, silent),
        appLogs: false,
        now: () => noon,
      }),
    );
    withClaims(idp, { roles, oid: 'made-up-agent-user', name: 'Made-up Agent User' });
    const { sessionCookie } = await signIn(app);
    const { tokens } = await connect(app, sessionCookie);
    return { target: app, token: tokens.access_token };
  }

  const toolNames = async (target: FastifyInstance, token: string) =>
    (await mcp(target, token, 'tools/list'))
      .json<{ result: { tools: { name: string }[] } }>()
      .result.tools.map((tool) => tool.name);

  it('gives an Admin get_logs, for today in UTC by default', async () => {
    await insert(noon - day, 30, 'yesterday');
    await insert(noon - 2 * hour, 30, 'this morning');
    await insert(noon - hour, 50, 'just now');
    const { target, token } = await agentFor(admin);
    expect(await toolNames(target, token)).toContain('get_logs');

    const today = await callTool(target, token, 'get_logs');
    expect(today.isError, today.text).toBe(false);
    const body = today.value as LogsResponse;
    expect(body.truncated).toBe(false);
    expect(body.entries.map((entry) => entry.msg)).toEqual(['just now', 'this morning']);

    const errors = await callTool(target, token, 'get_logs', { level: 'error' });
    expect((errors.value as LogsResponse).entries.map((entry) => entry.msg)).toEqual(['just now']);

    const twoDays = await callTool(target, token, 'get_logs', { from: '2026-03-09' });
    expect((twoDays.value as LogsResponse).entries).toHaveLength(3);
  });

  it('masks user ids and client addresses to their last 4 characters', async () => {
    await insert(noon - hour, 30, 'signed in', {
      userId: 'made-up-user-0001',
      roles: ['Admin'],
      req: { method: 'GET', remoteAddress: '203.0.113.45', remotePort: 51234 },
    });
    await insert(noon - 2 * hour, 30, 'mcp connections disconnected by an Admin', {
      userId: 'abc',
      targetUserId: 'made-up-user-0002',
    });
    const { target, token } = await agentFor(admin);
    const result = await callTool(target, token, 'get_logs');
    expect(result.isError, result.text).toBe(false);
    expect((result.value as LogsResponse).entries.map((entry) => entry.extra)).toEqual([
      {
        userId: '*****0001',
        roles: ['Admin'],
        req: { method: 'GET', remoteAddress: '*****3.45', remotePort: 51234 },
      },
      { userId: '*****', targetUserId: '*****0002' },
    ]);
    expect(result.text).not.toMatch(/made-up-user|203\.0\.113|"abc"/);

    const tools = (await mcp(target, token, 'tools/list')).json<{
      result: { tools: { name: string; description: string }[] };
    }>().result.tools;
    expect(tools.find((tool) => tool.name === 'get_logs')?.description).toContain(
      'User ids and client addresses are masked',
    );
  });

  it('masks a user id in a request path, and Admin → Logs shows it in full', async () => {
    const sink = new AppLogSink({ flushMs: 60_000 });
    app = await buildTestApp(
      { LOG_LEVEL: 'info' },
      idpOptions(idp, {
        database: DatabaseService.using(db, testConnection, silent),
        appLogs: sink,
      }),
    );
    captureLogs(app);
    withClaims(idp, { roles: admin, oid: 'made-up-agent-user', name: 'Made-up Agent User' });
    const { sessionCookie } = await signIn(app);
    const { tokens } = await connect(app, sessionCookie);
    const path = '/api/admin/agents/users/made-up-user-0002';
    const ended = await app.inject({
      method: 'DELETE',
      url: path,
      headers: { cookie: sessionCookie, origin: webOrigin },
    });
    expect(ended.statusCode, ended.body).toBe(200);
    await sink.flush();

    const urls = (logged: LogsResponse) =>
      logged.entries
        .map((entry) => (entry.extra.req as { url?: string } | undefined)?.url)
        .filter((url) => url?.startsWith('/api/admin/agents/users/'));

    const result = await callTool(app, tokens.access_token, 'get_logs');
    expect(result.isError, result.text).toBe(false);
    expect(urls(result.value as LogsResponse)).toEqual(['/api/admin/agents/users/*****0002']);
    expect(result.text).not.toContain('made-up-user-0002');

    const day = new Date().toISOString().slice(0, 10);
    const web = await app.inject({
      method: 'GET',
      url: `/api/admin/logs?from=${day}&to=${day}`,
      headers: { cookie: sessionCookie },
    });
    expect(web.statusCode, web.body).toBe(200);
    expect(urls(web.json<LogsResponse>())).toEqual([path]);
  });

  it.each([
    ['To before From', { from: '2026-03-10', to: '2026-03-09' }, "To can't be before From."],
    ['more than 31 days', { from: '2026-01-01', to: '2026-03-10' }, 'Choose 31 days or fewer.'],
    ['a date that does not exist', { from: '2026-02-30' }, 'YYYY-MM-DD'],
  ])('refuses %s', async (_name, args, message) => {
    const { target, token } = await agentFor(admin);
    const result = await callTool(target, token, 'get_logs', args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
  });

  it("logs the read with the agent user's id, beside the tool call, and no read when refused", async () => {
    await insert(noon - hour, 30, 'made-up entry text');
    const { target, token } = await agentFor(admin, 'info');
    const lines = captureLogs(target);
    const audited = (audit: string) =>
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.audit === audit);

    const refused = await callTool(target, token, 'get_logs', {
      from: '2026-03-10',
      to: '2026-03-09',
    });
    expect(refused.isError).toBe(true);
    expect(audited('logs-read')).toEqual([]);

    const result = await callTool(target, token, 'get_logs', { level: 'info' });
    expect(result.isError, result.text).toBe(false);
    expect(audited('logs-read')).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'logs read',
        userId: 'made-up-agent-user',
        via: 'mcp',
        from: '2026-03-10',
        to: '2026-03-10',
        minLevel: 'info',
        entries: 1,
        truncated: false,
      }),
    ]);
    expect(audited('mcp-tool')).toEqual([
      expect.objectContaining({ tool: 'get_logs', refused: true }),
      expect.objectContaining({ tool: 'get_logs', userId: 'made-up-agent-user', entries: 1 }),
    ]);
    expect(lines.join('')).not.toContain('made-up entry text');
  });

  it('refuses a date in another format before the tool runs', async () => {
    const { target, token } = await agentFor(admin);
    const result = await callTool(target, token, 'get_logs', { from: '10/03/2026' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('YYYY-MM-DD');
  });

  it.each([['Modeller'], ['Viewer']])(
    'is not there for a %s, even when asked for',
    async (role) => {
      await insert(noon, 30, 'for Admins only');
      const { target, token } = await agentFor([role]);
      expect(await toolNames(target, token)).not.toContain('get_logs');
      const forced = await mcp(target, token, 'tools/call', { name: 'get_logs', arguments: {} });
      expect(forced.statusCode).toBe(200);
      expect(forced.body).not.toContain('for Admins only');
      expect(forced.json<{ error?: { message: string } }>().error?.message).toBe(
        'Tool get_logs not found',
      );
    },
  );
});

import {
  logDayOf,
  logDayStart,
  logLevelNames,
  logLevels,
  logRangeProblems,
  maxLogEntries,
  maxTzOffset,
  minTzOffset,
  spacesForRoles,
  type LogEntry,
  type LogLevelName,
  type LogsResponse,
} from '@simplearchitecture/shared';
import { z } from 'zod';
import type { Queryable } from '../db/db.js';
import { redactSecrets } from './redact.js';

/**
 * Reads the app's stored log entries (see log-sink.ts) for Admin → Logs and the get_logs agent
 * tool, which both call `query`. Deny by default: only roles that open Admin may read them.
 * A range is whole calendar days, at the caller's offset from UTC (the browser's, or UTC for an
 * agent), at most 31 days; the answer is the newest 1,000 entries, newest first. The offset can
 * differ at the two ends when the range crosses a clock change: `tzOffset` is the one at the start
 * of `from`, `toTzOffset` the one at the end of `to` (the same as `tzOffset` when left out).
 * Each answered read is logged with the reader's user id (audit 'logs-read'), never the entries.
 */

/** The request can't be answered as asked. The message is safe to show. */
export class LogQueryError extends Error {
  override name = 'LogQueryError';
}

/** The caller's roles don't open Admin. */
export class LogAccessError extends Error {
  override name = 'LogAccessError';
  constructor() {
    super('Reading the logs needs the Admin role.');
  }
}

export const logQuerySchema = z
  .object({
    from: z.string().max(10).optional().default(''),
    to: z.string().max(10).optional().default(''),
    level: z.enum(logLevelNames as [LogLevelName, ...LogLevelName[]]).optional(),
    // Minutes behind UTC, as Date.getTimezoneOffset gives them; a query string sends text.
    tzOffset: z.coerce.number().int().min(minTzOffset).max(maxTzOffset).optional().default(0),
    // The offset at the end of the range (local midnight after `to`); `tzOffset` when left out.
    toTzOffset: z.coerce.number().int().min(minTzOffset).max(maxTzOffset).optional(),
  })
  .superRefine((query, context) => {
    for (const problem of logRangeProblems(query.from, query.to)) {
      context.addIssue({ code: 'custom', path: [problem.field], message: problem.message });
    }
  });

export type LogQuery = z.input<typeof logQuerySchema>;

/** Who reads the logs, and from where: Admin → Logs ('web') or an agent's get_logs ('mcp'). */
export interface LogReader {
  userId: string;
  roles: readonly string[];
  via: 'web' | 'mcp';
}

/** Where the service records each read (the app's logger). */
export interface LogReadLog {
  info(details: object, message: string): void;
}

interface LogRow {
  id: string | number | bigint;
  time: Date | string;
  level: number;
  msg: string;
  extra: unknown;
}

const dayMs = 86_400_000;

/** A level number as its name: the highest named level at or below it. */
function levelName(level: number): LogLevelName {
  let name: LogLevelName = 'trace';
  for (const each of logLevelNames) if (logLevels[each] <= level) name = each;
  return name;
}

function entryOf(row: LogRow): LogEntry {
  const extra = redactSecrets(row.extra);
  return {
    id: String(row.id),
    time: new Date(row.time).toISOString(),
    level: levelName(row.level),
    msg: row.msg,
    extra:
      typeof extra === 'object' && extra !== null && !Array.isArray(extra)
        ? (extra as Record<string, unknown>)
        : {},
  };
}

/** The first message of a failed parse, for the 400 or the tool's error. */
function firstMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'The request is not valid.';
  if (issue.code === 'custom') return issue.message;
  const field = issue.path.join('.');
  if (field === 'level') return `level must be one of ${logLevelNames.join(', ')}.`;
  if (field === 'tzOffset' || field === 'toTzOffset') {
    return `${field} must be a whole number of minutes from ${minTzOffset} to ${maxTzOffset}.`;
  }
  return `${field || 'The request'} is not valid.`;
}

export class LogService {
  constructor(
    private readonly db: Queryable,
    private readonly log: LogReadLog,
    private readonly now: () => number = Date.now,
  ) {}

  /** Today's date in UTC, `YYYY-MM-DD`: the agent tool's default range. */
  today(): string {
    return logDayOf(this.now());
  }

  /**
   * The entries of the days `from` to `to` (both counted, `YYYY-MM-DD`), at `level` or above,
   * newest first. Throws LogAccessError unless the reader's roles open Admin, LogQueryError for a
   * bad query; neither is logged as a read.
   */
  async query(reader: LogReader, input: unknown): Promise<LogsResponse> {
    if (!spacesForRoles(reader.roles).includes('admin')) throw new LogAccessError();
    const parsed = logQuerySchema.safeParse(input ?? {});
    if (!parsed.success) throw new LogQueryError(firstMessage(parsed.error));
    const { from, to, level, tzOffset, toTzOffset = tzOffset } = parsed.data;
    // Checked by the schema: both are days. Each end at its own offset, for a clock change between.
    const start = (logDayStart(from) ?? 0) + tzOffset * 60_000;
    const end = (logDayStart(to) ?? 0) + dayMs + toTzOffset * 60_000;
    const rows = await this.db.query<LogRow>(
      `select id, time, level, msg, extra from app_logs
       where time >= $1 and time < $2 and level >= $3
       order by time desc, id desc
       limit $4`,
      [
        new Date(start).toISOString(),
        new Date(end).toISOString(),
        level === undefined ? 0 : logLevels[level],
        maxLogEntries + 1,
      ],
    );
    const entries = rows.slice(0, maxLogEntries).map(entryOf);
    const truncated = rows.length > maxLogEntries;
    // Who read which days: ids and counts only, never what the entries say. The level asked for
    // is `minLevel`: `level` is the log line's own.
    this.log.info(
      {
        audit: 'logs-read',
        userId: reader.userId,
        via: reader.via,
        from,
        to,
        minLevel: level ?? null,
        entries: entries.length,
        truncated,
      },
      'logs read',
    );
    return { entries, truncated };
  }
}

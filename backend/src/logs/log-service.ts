import {
  defaultMinLogLevel,
  isLogLevelValue,
  logLevelLabel,
  logLevels,
  logRangeDays,
  logRangeProblems,
  maxLogLines,
  spacesForRoles,
  utcDayStart,
  utcToday,
  type LogLine,
  type LogsResponse,
} from '@simplearchitecture/shared';
import type { Queryable } from '../db/db.js';
import { RateLimiter } from '../rate-limit.js';
import { LogStore } from './log-store.js';

/**
 * The application's log lines for Admins: Admin → Logs (REST) and the get_logs MCP tool both call
 * this. Deny by default: every call checks again that the roles open Admin. A request covers whole
 * UTC days, both included (today when none is given), at most maxLogDays of them, and returns the
 * newest maxLogLines lines at or above a level.
 */

/** Reads per user per minute, REST and MCP together: each can scan a month of lines. */
export const logReadsPerMinute = 30;
export const tooManyLogReadsMessage = 'Too many log requests. Wait a minute and try again.';
export const logsNeedAdminMessage = 'Reading the logs needs the Admin role.';
export const logLevelMessage = `The level must be one of ${logLevels.map((level) => String(level.value)).join(', ')}.`;

const dayMs = 86_400_000;

export interface LogQuery {
  /** `YYYY-MM-DD`, UTC. Default: today. */
  from?: string | undefined;
  to?: string | undefined;
  /** Default: Info (30). */
  minLevel?: number | undefined;
}

/** Who is asking: their id (for the rate limit) and roles. */
export interface LogReader {
  userId: string;
  roles: readonly string[];
}

/** The request can't be answered as asked. The message says why, and is safe to show. */
export class LogQueryError extends Error {
  override name = 'LogQueryError';
  constructor(
    readonly reason: 'invalid' | 'forbidden' | 'rate-limited',
    message: string,
  ) {
    super(message);
  }
}

const fixedKeys = new Set(['level', 'time', 'msg']);

function lineOf(row: { time: string; level: number; msg: string | null; line: object }): LogLine {
  const fields = Object.fromEntries(
    Object.entries(row.line).filter(([key]) => !fixedKeys.has(key)),
  );
  return {
    time: row.time,
    level: row.level,
    levelLabel: logLevelLabel(row.level),
    msg: row.msg,
    fields,
  };
}

export class LogService {
  readonly #store: LogStore;
  readonly #now: () => number;
  readonly #limiter: RateLimiter;

  constructor(db: Queryable, now: () => number = Date.now) {
    this.#store = new LogStore(db);
    this.#now = now;
    this.#limiter = new RateLimiter(logReadsPerMinute, 60_000, now);
  }

  async query(reader: LogReader, input: LogQuery = {}): Promise<LogsResponse> {
    if (!spacesForRoles(reader.roles).includes('admin')) {
      throw new LogQueryError('forbidden', logsNeedAdminMessage);
    }
    const today = utcToday(this.#now());
    const from = input.from ?? today;
    const to = input.to ?? today;
    const [problem] = logRangeProblems(from, to);
    if (problem) throw new LogQueryError('invalid', problem.message);
    const minLevel = input.minLevel ?? defaultMinLogLevel;
    if (!isLogLevelValue(minLevel)) throw new LogQueryError('invalid', logLevelMessage);
    if (!this.#limiter.allow(reader.userId)) {
      throw new LogQueryError('rate-limited', tooManyLogReadsMessage);
    }

    // Checked above: both are real days, from on or before to.
    const fromMs = utcDayStart(from) ?? 0;
    const toMs = fromMs + (logRangeDays(from, to) ?? 1) * dayMs;
    const rows = await this.#store.query({ fromMs, toMs, minLevel, limit: maxLogLines + 1 });
    const truncated = rows.length > maxLogLines;
    return {
      from,
      to,
      minLevel,
      lines: rows.slice(0, maxLogLines).map(lineOf),
      truncated,
    };
  }
}

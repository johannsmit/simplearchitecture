/**
 * Admin → Logs and the `get_logs` agent tool: what the server logged, read back from the
 * database for a range of days. The rules here are checked in the browser and again at the server.
 */

/** The logger's levels, lowest first, with pino's numbers. */
export const logLevels = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;
export type LogLevelName = keyof typeof logLevels;
export const logLevelNames = Object.keys(logLevels) as LogLevelName[];

export function isLogLevelName(value: unknown): value is LogLevelName {
  return typeof value === 'string' && Object.hasOwn(logLevels, value);
}

/** The longest range one request may ask for, both days counted. */
export const maxLogDays = 31;
/** The most entries one answer holds, newest first. */
export const maxLogEntries = 1000;
/** How long the server keeps its log entries. */
export const logRetentionDays = 30;

/** The browser's offset from UTC in minutes, as `Date.getTimezoneOffset` gives it. */
export const minTzOffset = -840;
export const maxTzOffset = 720;

/** One entry: when, how serious, the message and the entry's other fields. */
export interface LogEntry {
  id: string;
  /** ISO 8601, UTC. */
  time: string;
  level: LogLevelName;
  msg: string;
  /** The entry's other fields as logged (credentials always shown as [Redacted]). */
  extra: Record<string, unknown>;
}

/** Response body of `GET /api/admin/logs` (Admin only), and the `get_logs` tool's result. */
export interface LogsResponse {
  entries: LogEntry[];
  /** More entries matched than `maxLogEntries`: these are the newest. */
  truncated: boolean;
}

export const logRangeMessages = {
  fromMissing: 'Choose a From date.',
  toMissing: 'Choose a To date.',
  invalidDate: 'Enter a date as YYYY-MM-DD.',
  toBeforeFrom: "To can't be before From.",
  tooLong: `Choose ${maxLogDays} days or fewer.`,
} as const;

const dayMs = 86_400_000;

/** A calendar day `YYYY-MM-DD` as the UTC time of its midnight, or undefined when it isn't one. */
export function logDayStart(day: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return undefined;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const time = Date.UTC(year, month - 1, date);
  const back = new Date(time);
  // Not 2026-02-30: the date must come back as written.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1) return undefined;
  if (back.getUTCDate() !== date) return undefined;
  return time;
}

export interface LogRangeProblem {
  field: 'from' | 'to';
  message: string;
}

/** What is wrong with a range of days, field by field; empty when it is fine. */
export function logRangeProblems(from: string, to: string): LogRangeProblem[] {
  const problems: LogRangeProblem[] = [];
  const start = from === '' ? undefined : logDayStart(from);
  const end = to === '' ? undefined : logDayStart(to);
  if (from === '') {
    problems.push({ field: 'from', message: logRangeMessages.fromMissing });
  } else if (start === undefined) {
    problems.push({ field: 'from', message: logRangeMessages.invalidDate });
  }
  if (to === '') {
    problems.push({ field: 'to', message: logRangeMessages.toMissing });
  } else if (end === undefined) {
    problems.push({ field: 'to', message: logRangeMessages.invalidDate });
  }
  if (start === undefined || end === undefined) return problems;
  if (end < start) problems.push({ field: 'to', message: logRangeMessages.toBeforeFrom });
  else if ((end - start) / dayMs + 1 > maxLogDays) {
    problems.push({ field: 'to', message: logRangeMessages.tooLong });
  }
  return problems;
}

/** A time as the calendar day `YYYY-MM-DD` it falls on, at `tzOffset` minutes behind UTC. */
export function logDayOf(time: number, tzOffset = 0): string {
  return new Date(time - tzOffset * 60_000).toISOString().slice(0, 10);
}

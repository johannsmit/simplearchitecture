/**
 * Admin → Logs and the get_logs MCP tool: the application's log lines, by whole UTC days. The
 * range rules are here so the web app checks exactly what the API does.
 */

/** How long log lines are kept. */
export const logRetentionDays = 30;
/** The most days one request may cover, both ends counted. */
export const maxLogDays = 31;
/** The most lines one request returns, newest first. */
export const maxLogLines = 1000;

/** The logger's levels, lowest first. */
export const logLevels = [
  { value: 10, label: 'trace' },
  { value: 20, label: 'debug' },
  { value: 30, label: 'info' },
  { value: 40, label: 'warn' },
  { value: 50, label: 'error' },
  { value: 60, label: 'fatal' },
] as const;

export type LogLevelLabel = (typeof logLevels)[number]['label'];
export type LogLevelValue = (typeof logLevels)[number]['value'];

/** The level a request asks for when it names none: Info and above. */
export const defaultMinLogLevel: LogLevelValue = 30;

export function isLogLevelValue(value: unknown): value is LogLevelValue {
  return logLevels.some((level) => level.value === value);
}

/** The label of a level number: the highest level at or below it (trace below 20). */
export function logLevelLabel(level: number): LogLevelLabel {
  let label: LogLevelLabel = 'trace';
  for (const each of logLevels) if (level >= each.value) label = each.label;
  return label;
}

/** One log line. Its text is whatever the app logged: show it as text, never as markup. */
export interface LogLine {
  /** ISO 8601, UTC. */
  time: string;
  level: number;
  levelLabel: LogLevelLabel;
  /** The message, or null when the line has none. */
  msg: string | null;
  /** The line's other fields (request, user id, counts …), as logged. */
  fields: Record<string, unknown>;
}

/** Response body of `GET /api/admin/logs` (Admin only), and the get_logs tool's result. */
export interface LogsResponse {
  /** The first and last day, `YYYY-MM-DD`, UTC, both included. */
  from: string;
  to: string;
  minLevel: number;
  /** Newest first, at most maxLogLines. */
  lines: LogLine[];
  /** More lines match than were returned. */
  truncated: boolean;
}

export const logStartMissingMessage = 'Enter a start date.';
export const logEndMissingMessage = 'Enter an end date.';
export const logDateFormatMessage = 'Enter the date as YYYY-MM-DD.';
export const logRangeOrderMessage = 'The start date must be on or before the end date.';
export const logRangeTooLongMessage = `The range can be at most ${String(maxLogDays)} days.`;

const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayMs = 86_400_000;

/** Milliseconds at 00:00 UTC of a `YYYY-MM-DD` day, or undefined when it isn't a real date. */
export function utcDayStart(day: string): number | undefined {
  const match = dayPattern.exec(day);
  if (!match) return undefined;
  const [, year = '', month = '', date = ''] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(date));
  // Date.UTC rolls 2026-02-30 over to March: only a day that reads back the same is real.
  return new Date(time).toISOString().slice(0, 10) === day ? time : undefined;
}

/** Today, UTC, as `YYYY-MM-DD`. */
export function utcToday(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** How many days `from` to `to` covers, both counted. */
export function logRangeDays(from: string, to: string): number | undefined {
  const start = utcDayStart(from);
  const end = utcDayStart(to);
  if (start === undefined || end === undefined) return undefined;
  return Math.round((end - start) / dayMs) + 1;
}

export interface LogRangeProblem {
  field: 'from' | 'to';
  message: string;
}

/** What is wrong with a range, at most one problem per field, From first. Empty when it is fine. */
export function logRangeProblems(from: string, to: string): LogRangeProblem[] {
  const problems: LogRangeProblem[] = [];
  if (from === '') problems.push({ field: 'from', message: logStartMissingMessage });
  else if (utcDayStart(from) === undefined) {
    problems.push({ field: 'from', message: logDateFormatMessage });
  }
  if (to === '') problems.push({ field: 'to', message: logEndMissingMessage });
  else if (utcDayStart(to) === undefined) {
    problems.push({ field: 'to', message: logDateFormatMessage });
  }
  if (problems.length > 0) return problems;
  const days = logRangeDays(from, to) ?? 0;
  if (days < 1) return [{ field: 'from', message: logRangeOrderMessage }];
  if (days > maxLogDays) return [{ field: 'to', message: logRangeTooLongMessage }];
  return [];
}

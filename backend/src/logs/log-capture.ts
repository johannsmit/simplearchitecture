import { logRetentionDays } from '@simplearchitecture/shared';
import { classifyDatabaseError, type Queryable } from '../db/db.js';
import { LogStore, type StoredLogRow } from './log-store.js';

/**
 * Keeps a copy of every log line the API writes, for Admin → Logs and the get_logs MCP tool.
 *
 * It is pino's `streamWrite` hook: pino calls it with each line exactly as it goes to standard
 * output (after the logger's redaction), and writes whatever it returns. The hook returns the line
 * unchanged, so standard output stays exactly as it was; it only puts the line in a buffer. A timer
 * writes the buffer to the `app_logs` table in batches, off the request's path.
 *
 * - Never blocks or fails a request: the hook does no I/O and swallows its own errors.
 * - Bounded: at most `maxBufferedLines` lines wait; past it, new lines are dropped and counted.
 *   A line longer than `maxStoredLineChars` is cut, and kept with its level and time.
 * - No loops: what the capture logs about itself (a failed write) goes to standard output only.
 *   A write that fails drops its batch rather than retrying it.
 * - Lines older than `logRetentionDays` are removed when the store attaches, then every hour.
 */

export const maxBufferedLines = 2_000;
export const flushBatchLines = 250;
export const flushDelayMs = 1_000;
export const maxStoredLineChars = 16 * 1024;
/** What is kept of a line that is too long. */
export const cutLineChars = 2_000;
export const pruneIntervalMs = 3_600_000;
const dayMs = 86_400_000;

export interface CaptureLog {
  warn(details: object, message: string): void;
}

interface Buffered {
  text: string;
  /** The line's full length, when it was cut. */
  cutFrom?: number;
}

type Json = Record<string, unknown>;

function isJsonObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timeOf(value: unknown, fallback: number): string {
  const time = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  const date = new Date(time);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function levelOf(value: unknown): number {
  // smallint; pino's levels are 10 to 60.
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000
    ? value
    : 30;
}

/** The row for a buffered line, or undefined for one that isn't a JSON object. */
export function rowOf(entry: Buffered, now: number): StoredLogRow | undefined {
  if (entry.cutFrom !== undefined) {
    // pino writes level and time first, so the start of the line still has them.
    const level = /"level":(\d+)/.exec(entry.text)?.[1];
    const time = /"time":(\d+)/.exec(entry.text)?.[1];
    const line: Json = {
      level: levelOf(Number(level)),
      time: time === undefined ? now : Number(time),
      cut: true,
      length: entry.cutFrom,
      start: entry.text.slice(0, cutLineChars),
    };
    return { time: timeOf(line.time, now), level: levelOf(line.level), msg: null, line };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.text);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed)) return undefined;
  return {
    time: timeOf(parsed.time, now),
    level: levelOf(parsed.level),
    msg: typeof parsed.msg === 'string' ? parsed.msg : null,
    line: parsed,
  };
}

export class LogCapture {
  readonly #now: () => number;
  #buffer: Buffered[] = [];
  #store: LogStore | undefined;
  #log: CaptureLog | undefined;
  #timer: NodeJS.Timeout | undefined;
  #pruneTimer: NodeJS.Timeout | undefined;
  #draining: Promise<boolean> | undefined;
  #dropped = 0;
  #failing = false;
  /** True while the capture logs about itself: those lines aren't captured. */
  #own = false;
  #closed = false;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** pino's `hooks.streamWrite`: keeps a copy of the line and returns it unchanged. */
  readonly streamWrite = (line: string): string => {
    try {
      this.#capture(line);
    } catch {
      // Never let keeping a copy get in the way of the log line itself.
    }
    return line;
  };

  /** Lines dropped because the buffer was full or a write failed, since the last report. */
  get dropped(): number {
    return this.#dropped;
  }

  #capture(line: string): void {
    if (this.#own || this.#closed) return;
    if (this.#buffer.length >= maxBufferedLines) {
      this.#dropped += 1;
      return;
    }
    this.#buffer.push(
      line.length > maxStoredLineChars
        ? { text: line.slice(0, cutLineChars + 200), cutFrom: line.length }
        : { text: line },
    );
    this.#schedule();
  }

  /**
   * Starts writing to the database (lines logged before it waited in the buffer) and pruning.
   * `log` is the app's logger, for what goes wrong with the store.
   */
  attach(db: Queryable, log: CaptureLog): void {
    this.#store = new LogStore(db);
    this.#log = log;
    void this.prune();
    this.#pruneTimer = setInterval(() => void this.prune(), pruneIntervalMs);
    this.#pruneTimer.unref();
    this.#schedule();
  }

  #schedule(): void {
    if (this.#store === undefined || this.#closed || this.#timer !== undefined) return;
    const delay = this.#buffer.length >= flushBatchLines ? 0 : flushDelayMs;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.flush();
    }, delay);
    this.#timer.unref();
  }

  #ownWarn(details: object, message: string): void {
    this.#own = true;
    try {
      this.#log?.warn(details, message);
    } finally {
      this.#own = false;
    }
  }

  /** Writes what is buffered. Never throws. Tests and close wait for it. */
  async flush(): Promise<void> {
    while (this.#store !== undefined && this.#buffer.length > 0) {
      if (this.#draining) {
        await this.#draining;
        continue;
      }
      this.#draining = this.#writeBatch(this.#store).finally(() => {
        this.#draining = undefined;
      });
      // A failed write stops here; the timer tries again with newer lines.
      if (!(await this.#draining)) break;
    }
    this.#schedule();
  }

  async #writeBatch(store: LogStore): Promise<boolean> {
    const batch = this.#buffer.splice(0, flushBatchLines);
    const now = this.#now();
    const rows = batch.flatMap((entry) => rowOf(entry, now) ?? []);
    try {
      await insertEach(store, rows);
    } catch (error) {
      this.#dropped += batch.length;
      if (!this.#failing) {
        this.#failing = true;
        this.#ownWarn(
          { failure: classifyDatabaseError(error) },
          'log lines not stored: dropping them until the database answers',
        );
      }
      return false;
    }
    this.#failing = false;
    if (this.#dropped > 0) {
      const dropped = this.#dropped;
      this.#dropped = 0;
      // Captured on purpose: Admins should see that lines are missing.
      this.#log?.warn({ dropped }, 'log lines dropped before they were stored');
    }
    return true;
  }

  /** Removes the lines older than the retention. Never throws. */
  async prune(): Promise<void> {
    const store = this.#store;
    if (store === undefined) return;
    try {
      await store.prune(this.#now() - logRetentionDays * dayMs);
    } catch (error) {
      this.#ownWarn({ failure: classifyDatabaseError(error) }, 'old log lines not removed');
    }
  }

  /** Writes what is left and stops. Later lines go to standard output only. */
  async close(): Promise<void> {
    clearTimeout(this.#timer);
    clearInterval(this.#pruneTimer);
    this.#timer = undefined;
    this.#pruneTimer = undefined;
    await this.flush();
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#buffer = [];
  }
}

/**
 * Inserts the rows in one statement. Should a line still be refused (it would be a line no check
 * here foresaw), the others are inserted one by one so one line can't lose the batch.
 */
async function insertEach(store: LogStore, rows: StoredLogRow[]): Promise<void> {
  try {
    await store.insert(rows);
  } catch (error) {
    if (classifyDatabaseError(error) !== 'other' || rows.length === 1) throw error;
    for (const row of rows) {
      try {
        await store.insert([row]);
      } catch (each) {
        if (classifyDatabaseError(each) !== 'other') throw each;
      }
    }
  }
}

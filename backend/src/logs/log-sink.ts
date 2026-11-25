import { logRetentionDays } from '@simplearchitecture/shared';
import type { Queryable } from '../db/db.js';
import { redactSecrets } from './redact.js';

/**
 * Keeps the app's log lines in the database (table app_logs), for Admin → Logs and get_logs.
 *
 * The logger hands every line it writes to `write` (pino's streamWrite hook, after its redaction),
 * so only what LOG_LEVEL lets through is kept. `write` only queues the line: it never blocks or
 * throws. The queue is written in small batches, by a timer and when it fills; it is bounded, so
 * a slow or unreachable database drops lines rather than memory. A failure to store is told on
 * standard error, at most once a minute, never through the logger: that would log about itself.
 * Entries older than 30 days are removed, at most once an hour, as new ones are written.
 */

export interface AppLogSinkOptions {
  /** Clock for the retention (tests). The entries keep the logger's own time. */
  now?: () => number;
  /** How often the queue is written. */
  flushMs?: number;
  /** Lines per insert; the queue is written at once when it holds this many. */
  batchSize?: number;
  /** Lines held at most; more are dropped until the queue has room. */
  maxQueued?: number;
  /** Told when lines couldn't be stored (default: one JSON line on standard error). */
  onProblem?: (message: string) => void;
}

export const retentionMs = logRetentionDays * 86_400_000;
export const pruneEveryMs = 3_600_000;
export const maxMessageLength = 2000;
/** A larger entry keeps its message and level, and its details say they were left out. */
export const maxExtraBytes = 32 * 1024;
const problemEveryMs = 60_000;

/** The fields every pino line has that the table holds in columns, or that say nothing. */
const ownFields = new Set(['level', 'time', 'msg', 'pid', 'hostname']);

interface Row {
  time: string;
  level: number;
  msg: string;
  extra: Record<string, unknown>;
}

function cut(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** One logged JSON line as a row, or undefined when it isn't one (never throws). */
export function rowOf(line: string, fallbackTime: number): Row | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const entry = redactSecrets(parsed) as Record<string, unknown>;
  const level = entry.level;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 10 || level > 60) {
    return undefined;
  }
  const time =
    typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : fallbackTime;
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) if (!ownFields.has(key)) extra[key] = value;
  const msg = typeof entry.msg === 'string' ? cut(entry.msg, maxMessageLength) : '';
  const tooLarge = JSON.stringify(extra).length > maxExtraBytes;
  return {
    time: new Date(time).toISOString(),
    level,
    msg,
    extra: tooLarge ? { detailsLeftOut: 'The details were too large to keep.' } : extra,
  };
}

function standardError(message: string): void {
  process.stderr.write(`${JSON.stringify({ level: 40, time: Date.now(), msg: message })}\n`);
}

export class AppLogSink {
  private readonly now: () => number;
  private readonly flushMs: number;
  private readonly batchSize: number;
  private readonly maxQueued: number;
  private readonly onProblem: (message: string) => void;
  private queue: string[] = [];
  private db: Queryable | undefined;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> | undefined;
  private lastPrune = 0;
  private lastProblem = Number.NEGATIVE_INFINITY;
  private dropped = 0;
  private closed = false;

  constructor(options: AppLogSinkOptions = {}) {
    this.now = options.now ?? Date.now;
    this.flushMs = options.flushMs ?? 2_000;
    this.batchSize = options.batchSize ?? 100;
    this.maxQueued = options.maxQueued ?? 5_000;
    this.onProblem = options.onProblem ?? standardError;
  }

  /** For pino's streamWrite hook: queues the line and gives it back unchanged. */
  readonly hook = (line: string): string => {
    this.write(line);
    return line;
  };

  /** Queues one logged line. Cheap, synchronous and never throws. */
  write(line: string): void {
    if (this.closed) return;
    if (this.queue.length >= this.maxQueued) {
      this.dropped++;
      return;
    }
    this.queue.push(line);
    if (this.db !== undefined && this.queue.length >= this.batchSize) void this.flush();
  }

  /** Starts storing: lines queued before (startup, migrations) are written first. */
  attach(db: Queryable): void {
    this.db = db;
    this.timer = setInterval(() => void this.flush(), this.flushMs);
    // Never what keeps the process running.
    this.timer.unref();
    if (this.queue.length > 0) void this.flush();
  }

  /** Writes everything queued so far. Resolves when it is stored or given up; never rejects. */
  async flush(): Promise<void> {
    // One write at a time, in order: wait for the one running, then write what is left.
    while (this.writing !== undefined) await this.writing;
    if (this.db === undefined || this.queue.length === 0) return;
    this.writing = this.writeQueued(this.db).finally(() => {
      this.writing = undefined;
    });
    await this.writing;
  }

  /** Stops the timer and writes what is queued. Lines logged afterwards aren't kept. */
  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
    this.closed = true;
    this.queue = [];
  }

  private async writeQueued(db: Queryable): Promise<void> {
    while (this.queue.length > 0) {
      const lines = this.queue.splice(0, this.batchSize);
      const time = this.now();
      const rows = lines.map((line) => rowOf(line, time)).filter((row) => row !== undefined);
      try {
        if (rows.length > 0) {
          await db.query(
            `insert into app_logs (time, level, msg, extra)
             select time, level, msg, extra
             from jsonb_to_recordset($1::jsonb)
               as r(time timestamptz, level smallint, msg text, extra jsonb)`,
            [JSON.stringify(rows)],
          );
        }
        await this.prune(db, time);
      } catch (error) {
        this.problem(`log entries not stored (${lines.length} dropped): ${describe(error)}`);
        return;
      }
    }
    if (this.dropped > 0) {
      const dropped = this.dropped;
      this.dropped = 0;
      this.problem(`log entries not stored: ${dropped} dropped while the queue was full`);
    }
  }

  private async prune(db: Queryable, time: number): Promise<void> {
    if (time - this.lastPrune < pruneEveryMs) return;
    this.lastPrune = time;
    await db.query('delete from app_logs where time < $1', [
      new Date(time - retentionMs).toISOString(),
    ]);
  }

  private problem(message: string): void {
    const time = this.now();
    if (time - this.lastProblem < problemEveryMs) return;
    this.lastProblem = time;
    try {
      this.onProblem(message);
    } catch {
      // Nowhere left to tell.
    }
  }
}

/** The error's kind only: a DatabaseError says its failure and code, never driver text. */
function describe(error: unknown): string {
  return error instanceof Error && error.name === 'DatabaseError' ? error.message : 'unknown error';
}

import type { Queryable } from '../db/db.js';

/** One line as stored: the time, level and message pulled out, and the whole line. */
export interface StoredLogRow {
  /** ISO 8601. */
  time: string;
  level: number;
  msg: string | null;
  line: Record<string, unknown>;
}

export interface LogRange {
  /** Inclusive, milliseconds. */
  fromMs: number;
  /** Exclusive, milliseconds. */
  toMs: number;
  minLevel: number;
  limit: number;
}

interface Row {
  logged_at: Date | string;
  level: number;
  msg: string | null;
  line: Record<string, unknown>;
}

// Half a surrogate pair: one not followed, or not preceded, by its other half.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** PostgreSQL's jsonb and text take neither NUL nor half a surrogate pair: both become U+FFFD. */
function storable(_key: string, value: unknown): unknown {
  return typeof value === 'string'
    ? value.replace(loneSurrogate, '\uFFFD').replaceAll('\0', '\uFFFD')
    : value;
}

/** The `app_logs` table. Every query is parameterised. */
export class LogStore {
  constructor(private readonly db: Queryable) {}

  /** Adds the lines in one statement: the whole batch is one JSON parameter. */
  async insert(rows: readonly StoredLogRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.query(
      `insert into app_logs (logged_at, level, msg, line)
       select (r->>'time')::timestamptz, (r->>'level')::smallint, r->>'msg', r->'line'
       from jsonb_array_elements($1::jsonb) as r`,
      [JSON.stringify(rows, storable)],
    );
  }

  /** The lines in the range at or above the level, newest first, at most `limit`. */
  async query(range: LogRange): Promise<StoredLogRow[]> {
    const rows = await this.db.query<Row>(
      `select logged_at, level, msg, line from app_logs
       where logged_at >= $1 and logged_at < $2 and level >= $3
       order by logged_at desc, id desc
       limit $4`,
      [
        new Date(range.fromMs).toISOString(),
        new Date(range.toMs).toISOString(),
        range.minLevel,
        range.limit,
      ],
    );
    return rows.map((row) => ({
      time: new Date(row.logged_at).toISOString(),
      level: row.level,
      msg: row.msg,
      line: row.line,
    }));
  }

  /** Removes the lines logged before `beforeMs`. */
  async prune(beforeMs: number): Promise<void> {
    await this.db.query('delete from app_logs where logged_at < $1', [
      new Date(beforeMs).toISOString(),
    ]);
  }
}

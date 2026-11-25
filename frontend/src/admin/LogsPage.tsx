import {
  defaultMinLogLevel,
  logRangeProblems,
  utcToday,
  type LogLine,
  type LogsResponse,
} from '@simplearchitecture/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, getLogs } from '../api';
import { usePageTitle } from '../branding';
import { Icon } from '../icons';
import { counted, formatNumber } from '../words';
import { AdminNav } from './AdminNav';

/**
 * Admin → Logs: the application's log lines for whole UTC days, newest first. The API checks the
 * same range rules as this form, and every line's text is shown as text, never as markup.
 */

const levelChoices = [
  { value: 10, label: 'Trace and above' },
  { value: 20, label: 'Debug and above' },
  { value: 30, label: 'Info and above' },
  { value: 40, label: 'Warnings and errors' },
  { value: 50, label: 'Errors only' },
] as const;

function levelChoiceLabel(value: number): string {
  return levelChoices.find((choice) => choice.value === value)?.label ?? `Level ${String(value)}`;
}

interface Query {
  from: string;
  to: string;
  minLevel: number;
}

type Load =
  | { status: 'loading' }
  | { status: 'ready'; logs: LogsResponse }
  | { status: 'error'; message: string };

type Field = 'from' | 'to';

/** `YYYY-MM-DD HH:MM:SS.mmm`, UTC. */
function utcTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const text = date.toISOString();
  return `${text.slice(0, 10)} ${text.slice(11, 23)}`;
}

function levelWord(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function Message({ line }: { line: LogLine }) {
  const text = line.msg ?? <span className="muted">(no message)</span>;
  if (Object.keys(line.fields).length === 0) return <>{text}</>;
  return (
    <details className="log-details">
      <summary>{text}</summary>
      <pre>{JSON.stringify(line.fields, null, 2)}</pre>
    </details>
  );
}

function LogTable({ logs }: { logs: LogsResponse }) {
  return (
    <div className="table-card">
      <table className="models-table logs-table">
        <caption className="vh">
          Log lines from {logs.from} to {logs.to}, {levelChoiceLabel(logs.minLevel)}
        </caption>
        <thead>
          <tr>
            <th scope="col">Time (UTC)</th>
            <th scope="col">Level</th>
            <th scope="col">Message</th>
          </tr>
        </thead>
        <tbody>
          {logs.lines.map((line, index) => (
            // Lines have no id: their place in this answer is theirs.
            <tr key={index}>
              <td className="log-time">
                <time dateTime={line.time}>{utcTime(line.time)}</time>
              </td>
              <td className="log-level">
                <span className={`badge level-${line.levelLabel}`}>
                  {levelWord(line.levelLabel)}
                </span>
              </td>
              <td className="log-message">
                <Message line={line} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LogsPage() {
  usePageTitle('Logs – Admin');
  const [today] = useState(() => utcToday());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [level, setLevel] = useState(String(defaultMinLogLevel));
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [last, setLast] = useState<Query>({ from: today, to: today, minLevel: defaultMinLogLevel });
  const fromInput = useRef<HTMLInputElement>(null);
  const toInput = useRef<HTMLInputElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const refocus = useRef(false);

  /** Asks for the lines; the caller has set the state to loading. */
  const fetchLogs = useCallback((query: Query, keepFocus: boolean) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    refocus.current = keepFocus;
    getLogs(query, current.signal)
      .then((logs) => {
        setLoad({ status: 'ready', logs });
      })
      .catch((error: unknown) => {
        if (current.signal.aborted) return;
        setLoad({
          status: 'error',
          message: error instanceof ApiRequestError ? error.message : 'Something went wrong.',
        });
      })
      .finally(() => {
        // Done: nothing left to cancel.
        if (controller.current === current) controller.current = null;
      });
  }, []);

  // Show is disabled while loading, which can drop focus: once it is enabled again, give it back.
  useEffect(() => {
    if (load.status === 'loading' || !refocus.current) return;
    refocus.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body || active === showButton.current) {
      showButton.current?.focus();
    }
  }, [load]);

  // The first load: the state starts as loading today's lines.
  useEffect(() => {
    fetchLogs({ from: today, to: today, minLevel: defaultMinLogLevel }, false);
    return () => {
      controller.current?.abort();
    };
  }, [fetchLogs, today]);

  const run = (query: Query, keepFocus: boolean) => {
    setLast(query);
    setLoad({ status: 'loading' });
    fetchLogs(query, keepFocus);
  };

  const submit = () => {
    const problems = logRangeProblems(from, to);
    const next: Partial<Record<Field, string>> = {};
    for (const problem of problems) next[problem.field] ??= problem.message;
    setErrors(next);
    const [first] = problems;
    if (first) {
      (first.field === 'from' ? fromInput : toInput).current?.focus();
      return;
    }
    run({ from, to, minLevel: Number(level) }, true);
  };

  const loading = load.status === 'loading';
  const logs = load.status === 'ready' ? load.logs : undefined;
  const status = logs
    ? logs.truncated
      ? `${counted(logs.lines.length, 'line')}, newest first. More lines match.`
      : `${counted(logs.lines.length, 'line')}, newest first.`
    : '';

  return (
    <main id="content" tabIndex={-1} className="page-scroll">
      <div className="page logs-page">
        <AdminNav />
        <div className="page-head">
          <div>
            <h1>Logs</h1>
            <p>Application log lines, kept for 30 days. Dates and times are UTC.</p>
          </div>
        </div>

        <form
          className="d-form logs-filter"
          role="search"
          aria-label="Filter logs"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="field">
            <label htmlFor="logs-from">From (UTC)</label>
            <input
              ref={fromInput}
              id="logs-from"
              type="date"
              value={from}
              aria-invalid={errors.from === undefined ? undefined : true}
              aria-describedby={errors.from === undefined ? undefined : 'logs-from-error'}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
            />
            {errors.from !== undefined && (
              <p className="field-error" id="logs-from-error">
                {errors.from}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="logs-to">To (UTC)</label>
            <input
              ref={toInput}
              id="logs-to"
              type="date"
              value={to}
              aria-invalid={errors.to === undefined ? undefined : true}
              aria-describedby={errors.to === undefined ? undefined : 'logs-to-error'}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
            {errors.to !== undefined && (
              <p className="field-error" id="logs-to-error">
                {errors.to}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="logs-level">Minimum level</label>
            <select
              id="logs-level"
              value={level}
              onChange={(event) => {
                setLevel(event.target.value);
              }}
            >
              {levelChoices.map((choice) => (
                <option key={choice.value} value={String(choice.value)}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
          <button ref={showButton} className="btn primary" type="submit" disabled={loading}>
            <Icon name="refresh" size="sm" />
            {loading ? 'Showing…' : 'Show'}
          </button>
        </form>

        {/* One status region, always there, so a screen reader announces each change of text. */}
        <p className="vh" role="status">
          {loading ? 'Loading…' : status}
        </p>

        {/* Seen only: the status region above announces it. */}
        {loading && (
          <p className="app-message" aria-hidden="true">
            Loading…
          </p>
        )}

        {load.status === 'error' && (
          <div className="table-card load-error" role="alert">
            <Icon name="alert" />
            <div>
              <p>
                <b>Couldn&apos;t load the logs.</b>
              </p>
              <p className="muted">{load.message}</p>
            </div>
            <button
              className="btn"
              type="button"
              onClick={() => {
                run(last, true);
              }}
            >
              Try again
            </button>
          </div>
        )}

        {logs && logs.lines.length === 0 && (
          <div className="table-card empty">
            <Icon name="file" />
            <h2>No log lines match.</h2>
            <p>Try a wider date range or a lower level.</p>
          </div>
        )}

        {logs && logs.lines.length > 0 && (
          <>
            {logs.truncated && (
              <p className="alert warning logs-truncated">
                Showing the newest {formatNumber(logs.lines.length)} lines. More lines match:
                shorten the date range or raise the level.
              </p>
            )}
            <LogTable logs={logs} />
          </>
        )}
      </div>
    </main>
  );
}

import {
  logRangeProblems,
  maxLogEntries,
  type LogEntry,
  type LogLevelName,
  type LogsResponse,
} from '@simplearchitecture/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getLogs, type LogsQuery } from '../api';
import { usePageTitle } from '../branding';
import { Icon } from '../icons';
import { AdminNav } from './AdminNav';

/** The Level choices: all, or a lowest level. */
const levelChoices: { value: '' | LogLevelName; label: string }[] = [
  { value: '', label: 'All levels' },
  { value: 'info', label: 'Info and above' },
  { value: 'warn', label: 'Warnings and errors' },
  { value: 'error', label: 'Errors only' },
];

const pad = (value: number) => String(value).padStart(2, '0');

/** A date in the browser's time zone as `YYYY-MM-DD`. */
function localDay(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** An entry's time in the browser's time zone: `HH:mm:ss`, after its date when `withDate`. */
function shownTime(iso: string, withDate: boolean): string {
  const date = new Date(iso);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return withDate ? `${localDay(date)} ${time}` : time;
}

const levelClass: Record<LogLevelName, string> = {
  trace: 'muted',
  debug: 'muted',
  info: 'info',
  warn: 'warning',
  error: 'critical',
  fatal: 'critical',
};

function announcement(response: LogsResponse): string {
  const count = response.entries.length;
  if (count === 0) return 'No log entries for these dates.';
  if (response.truncated)
    return `Showing the newest ${maxLogEntries.toLocaleString('en')} entries.`;
  return count === 1 ? '1 log entry.' : `${count.toLocaleString('en')} log entries.`;
}

/** The whole message (the list cuts it to one line), then the entry's other fields. */
function Details({ entry }: { entry: LogEntry }) {
  const fields = Object.entries(entry.extra);
  return (
    <>
      <dl className="log-fields">
        <div className="log-message">
          <dt>Message</dt>
          <dd>{entry.msg === '' ? '—' : entry.msg}</dd>
        </div>
        {fields.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              {typeof value === 'object' && value !== null ? (
                <pre>{JSON.stringify(value, null, 2)}</pre>
              ) : (
                String(value)
              )}
            </dd>
          </div>
        ))}
      </dl>
      {fields.length === 0 && <p className="muted log-no-fields">No other fields.</p>}
    </>
  );
}

function EntryRows({ entry, withDate }: { entry: LogEntry; withDate: boolean }) {
  const [open, setOpen] = useState(false);
  const detailsId = `log-entry-${entry.id}`;
  const time = shownTime(entry.time, withDate);
  return (
    <>
      <tr>
        <td className="log-time">
          <time dateTime={entry.time}>{time}</time>
        </td>
        <td>
          <span className={`tag log-level level-${levelClass[entry.level]}`}>{entry.level}</span>
        </td>
        <td className="log-msg">
          <span className="cut" title={entry.msg}>
            {entry.msg}
          </span>
        </td>
        <td className="act">
          <button
            className="btn"
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => {
              setOpen((was) => !was);
            }}
          >
            Details <span className="vh">of the entry at {time}</span>
          </button>
        </td>
      </tr>
      <tr id={detailsId} className="log-details" hidden={!open}>
        <td colSpan={4}>
          <Details entry={entry} />
        </td>
      </tr>
    </>
  );
}

interface Loaded {
  response: LogsResponse;
  /** The range covered more than one day: times show their date. */
  withDate: boolean;
}

/**
 * Admin → Logs: what the server logged, newest first, for a range of days in the browser's time
 * zone (today by default). Loads on first render and on Show logs only.
 */
export function LogsPage() {
  usePageTitle('Logs – Admin');
  const [from, setFrom] = useState(() => localDay(new Date()));
  const [to, setTo] = useState(() => localDay(new Date()));
  const [level, setLevel] = useState<'' | LogLevelName>('');
  const [problems, setProblems] = useState<{ from?: string; to?: string }>({});
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [announced, setAnnounced] = useState('');
  const lastQuery = useRef<LogsQuery | undefined>(undefined);
  const running = useRef<AbortController | undefined>(undefined);

  /** Asks for the entries; the answer or the failure is shown when it comes. */
  const fetchLogs = useCallback((query: LogsQuery) => {
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    lastQuery.current = query;
    getLogs(query, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        running.current = undefined;
        setLoaded({ response, withDate: query.from !== query.to });
        setFailure(undefined);
        setLoading(false);
        setAnnounced(announcement(response));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        running.current = undefined;
        setFailure(error instanceof Error ? error.message : 'Something went wrong.');
        setLoading(false);
      });
    return controller;
  }, []);

  const load = (query: LogsQuery) => {
    setLoading(true);
    setAnnounced('');
    fetchLogs(query);
  };

  // The first load: today. The page starts as loading.
  useEffect(() => {
    const day = localDay(new Date());
    const controller = fetchLogs({ from: day, to: day, tzOffset: new Date().getTimezoneOffset() });
    return () => {
      controller.abort();
    };
  }, [fetchLogs]);

  const submit = () => {
    const found: { from?: string; to?: string } = {};
    for (const problem of logRangeProblems(from, to)) found[problem.field] ??= problem.message;
    setProblems(found);
    if (found.from !== undefined || found.to !== undefined) return;
    load({
      from,
      to,
      ...(level === '' ? {} : { level }),
      tzOffset: new Date().getTimezoneOffset(),
    });
  };

  const retry = () => {
    if (lastQuery.current) load(lastQuery.current);
  };

  const response = loaded?.response;

  return (
    <main id="content" tabIndex={-1} className="page-scroll">
      <div className="page">
        <AdminNav />
        <div className="page-head">
          <div>
            <h1>Logs</h1>
            <p>What the server recorded, newest first.</p>
          </div>
        </div>

        <form
          className="logs-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          aria-label="Log dates and level"
        >
          <div className="field">
            <label htmlFor="logs-from">From</label>
            <input
              id="logs-from"
              type="date"
              value={from}
              aria-invalid={problems.from !== undefined}
              aria-describedby={problems.from === undefined ? undefined : 'logs-from-error'}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
            />
            {problems.from !== undefined && (
              <p id="logs-from-error" className="field-error">
                {problems.from}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="logs-to">To</label>
            <input
              id="logs-to"
              type="date"
              value={to}
              aria-invalid={problems.to !== undefined}
              aria-describedby={problems.to === undefined ? undefined : 'logs-to-error'}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
            {problems.to !== undefined && (
              <p id="logs-to-error" className="field-error">
                {problems.to}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="logs-level">Level</label>
            <select
              id="logs-level"
              value={level}
              onChange={(event) => {
                setLevel(event.target.value as '' | LogLevelName);
              }}
            >
              {levelChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
          <button className="btn primary" type="submit">
            Show logs
          </button>
        </form>

        <p className="vh" role="status" aria-live="polite">
          {announced}
        </p>

        {loading && (
          <p className="app-message" role="status">
            Loading…
          </p>
        )}

        {!loading && failure !== undefined && (
          <div className="table-card load-error" role="alert">
            <Icon name="alert" />
            <div>
              <p>
                <b>The logs couldn&apos;t be loaded.</b>
              </p>
              <p className="muted">{failure}</p>
            </div>
            <button className="btn" type="button" onClick={retry}>
              Try again
            </button>
          </div>
        )}

        {failure === undefined && response !== undefined && response.entries.length === 0 && (
          <div className="table-card empty">
            <p>No log entries for these dates.</p>
          </div>
        )}

        {failure === undefined && response !== undefined && response.entries.length > 0 && (
          <>
            {response.truncated && (
              <p className="muted logs-capped">
                Showing the newest {maxLogEntries.toLocaleString('en')} entries. Narrow the dates or
                level to see the rest.
              </p>
            )}
            <div className="table-card">
              <table className="models-table logs-table" aria-busy={loading}>
                <caption className="vh">Log entries</caption>
                <thead>
                  <tr>
                    <th scope="col" className="log-time">
                      Time
                    </th>
                    <th scope="col">Level</th>
                    <th scope="col">Message</th>
                    <th scope="col">
                      <span className="vh">Details</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {response.entries.map((entry) => (
                    <EntryRows key={entry.id} entry={entry} withDate={loaded?.withDate ?? false} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

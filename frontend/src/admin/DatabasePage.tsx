import type { DatabaseStatus, DatabaseTestResult } from '@simplearchitecture/shared';
import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, getDatabaseStatus, testDatabaseConnection } from '../api';
import { Icon } from '../icons';
import { AdminNav } from './AdminNav';

type Load =
  | { status: 'loading' }
  | { status: 'ready'; database: DatabaseStatus }
  | { status: 'error'; message: string };

type Test =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'done'; result: DatabaseTestResult }
  | { kind: 'failed'; message: string };

const dash = '—';

function tlsText(database: DatabaseStatus): string {
  if (!database.tls) return 'Off';
  return database.tlsVerified ? 'On, certificate verified' : 'On, certificate not verified';
}

function Fields({ database }: { database: DatabaseStatus }) {
  const { applied, total } = database.migrations;
  const rows: [string, string][] = [
    ['Status', database.connected ? 'Connected' : 'Not connected'],
    ['Host', database.host ?? dash],
    ['Port', database.port === null ? dash : String(database.port)],
    ['Database', database.database ?? dash],
    ['User', database.user ?? dash],
    ['TLS', tlsText(database)],
    ['Server version', database.serverVersion ?? dash],
    ['Migrations', applied === null ? `${dash} of ${total}` : `${applied} of ${total} applied`],
  ];
  return (
    <dl className="db-fields">
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Admin → Database: read-only. The connection is set in DATABASE_URL, never in the app, and the
 * API never sends the password or the URL.
 */
export function DatabasePage() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [test, setTest] = useState<Test>({ kind: 'idle' });

  const reload = useCallback((signal?: AbortSignal) => {
    getDatabaseStatus(signal)
      .then((database) => {
        setLoad({ status: 'ready', database });
      })
      .catch((error: unknown) => {
        if (signal?.aborted) return;
        setLoad({
          status: 'error',
          message: error instanceof Error ? error.message : 'Something went wrong.',
        });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => {
      controller.abort();
    };
  }, [reload]);

  const runTest = () => {
    setTest({ kind: 'testing' });
    testDatabaseConnection()
      .then((result) => {
        setTest({ kind: 'done', result });
        reload();
      })
      .catch((error: unknown) => {
        setTest({
          kind: 'failed',
          message: error instanceof ApiRequestError ? error.message : "The test couldn't be run.",
        });
      });
  };

  const database = load.status === 'ready' ? load.database : undefined;

  return (
    <main id="content" tabIndex={-1} className="page-scroll">
      <div className="page">
        <AdminNav />
        <div className="page-head">
          <div>
            <h1>Database</h1>
            <p>Where SimpleArchitecture stores its models and sessions.</p>
          </div>
        </div>

        {load.status === 'loading' && (
          <p className="app-message" role="status">
            Loading…
          </p>
        )}

        {load.status === 'error' && (
          <div className="table-card load-error" role="alert">
            <Icon name="alert" />
            <div>
              <p>
                <b>The database status couldn&apos;t be loaded.</b>
              </p>
              <p className="muted">{load.message}</p>
            </div>
            <button
              className="btn"
              type="button"
              onClick={() => {
                reload();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {database && (
          <section className="table-card db-card" aria-labelledby="db-title">
            <h2 id="db-title">
              <Icon name="layers" />
              PostgreSQL
            </h2>
            {database.configured ? (
              <Fields database={database} />
            ) : (
              <p className="db-not-configured">
                <b>Not configured: using file storage.</b> Models are stored as files in DATA_DIR on
                the server, and sessions are kept in memory.
              </p>
            )}
            <div className="db-actions">
              <button
                className="btn"
                type="button"
                disabled={test.kind === 'testing'}
                onClick={runTest}
              >
                <Icon name="check" />
                Test connection
              </button>
              <p
                role="status"
                className={test.kind === 'done' && test.result.ok ? 'db-test ok' : 'db-test'}
              >
                {test.kind === 'testing' && 'Testing…'}
                {test.kind === 'done' && test.result.message}
                {test.kind === 'failed' && test.message}
              </p>
            </div>
            <p className="muted db-note">
              <Icon name="info" />
              <span>
                The connection is set in <code>DATABASE_URL</code>: in the <code>.env</code> file
                locally, or in the host&apos;s secret store. It can&apos;t be changed here, and the
                password is never shown.
              </span>
            </p>
          </section>
        )}
      </div>
    </main>
  );
}

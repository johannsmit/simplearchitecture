import type { AdminConnectedApp } from '@simplearchitecture/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  adminDisconnectAll,
  adminDisconnectApp,
  adminDisconnectUser,
  listAllConnectedApps,
} from '../api';
import { AppFacts, AppName } from '../agents/ConnectedAppsPage';
import { ConfirmDialog } from '../agents/ConfirmDialog';
import { Icon } from '../icons';
import { counted } from '../words';
import { AdminNav } from './AdminNav';

/**
 * Admin → Connected apps: every user's AI agent connections, grouped by user (by the display name
 * at sign-in, and the id). Disconnect one with no confirmation, as on the user's own page;
 * Disconnect all for a user, or all, after a confirmation that says how many end.
 */

type Load =
  { status: 'loading' } | { status: 'ready'; apps: AdminConnectedApp[] } | { status: 'error' };

type Bulk =
  | { kind: 'user'; userId: string; userName: string; count: number }
  | { kind: 'all'; count: number };

interface UserGroup {
  userId: string;
  userName: string;
  apps: AdminConnectedApp[];
}

/** One group per user, in the order of their newest connection. */
function byUser(apps: readonly AdminConnectedApp[]): UserGroup[] {
  const groups = new Map<string, UserGroup>();
  for (const app of apps) {
    const group = groups.get(app.userId);
    if (group) group.apps.push(app);
    else groups.set(app.userId, { userId: app.userId, userName: app.userName, apps: [app] });
  }
  return [...groups.values()];
}

export function ConnectedAppsAdminPage() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [bulk, setBulk] = useState<Bulk | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);

  const reload = useCallback((signal?: AbortSignal) => {
    listAllConnectedApps(signal)
      .then((apps) => {
        setLoad({ status: 'ready', apps });
      })
      .catch(() => {
        if (!signal?.aborted) setLoad({ status: 'error' });
      });
  }, []);

  useEffect(() => {
    document.title = 'Connected apps – Admin – SimpleArchitecture';
    const controller = new AbortController();
    reload(controller.signal);
    return () => {
      controller.abort();
    };
  }, [reload]);

  const apps = load.status === 'ready' ? load.apps : [];

  const disconnectOne = (app: AdminConnectedApp) => {
    setBusy(app.id);
    setRowError(null);
    adminDisconnectApp(app.id)
      .then(() => {
        setLoad({ status: 'ready', apps: apps.filter((other) => other.id !== app.id) });
        setStatus('The connection is ended.');
        heading.current?.focus();
      })
      .catch(() => {
        setRowError(app.id);
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const confirmBulk = () => {
    if (bulk === null) return;
    setBulkBusy(true);
    setBulkError(null);
    const call = bulk.kind === 'all' ? adminDisconnectAll() : adminDisconnectUser(bulk.userId);
    call
      .then((count) => {
        setLoad({
          status: 'ready',
          apps: bulk.kind === 'all' ? [] : apps.filter((app) => app.userId !== bulk.userId),
        });
        setStatus(`${counted(count, 'connection')} ended.`);
        setBulk(null);
        heading.current?.focus();
        // What others connected meanwhile shows too.
        reload();
      })
      .catch(() => {
        setBulkError("Couldn't disconnect. Try again.");
      })
      .finally(() => {
        setBulkBusy(false);
      });
  };

  return (
    <main id="content" tabIndex={-1} className="page-scroll">
      <div className="page apps-page">
        <AdminNav />
        <div className="page-head">
          <div>
            <h1 ref={heading} tabIndex={-1}>
              Connected apps
            </h1>
            <p>Every user&apos;s AI agents. Disconnecting one stops it at once.</p>
          </div>
          {apps.length > 0 && (
            <button
              className="btn"
              type="button"
              onClick={() => {
                setBulkError(null);
                setBulk({ kind: 'all', count: apps.length });
              }}
            >
              <Icon name="unlink" size="sm" />
              Disconnect all
            </button>
          )}
        </div>

        <p className="vh" role="status">
          {status}
        </p>

        {load.status === 'loading' && (
          <p className="app-message" role="status">
            Loading…
          </p>
        )}

        {load.status === 'error' && (
          <div className="table-card load-error" role="alert">
            <Icon name="alert" />
            <p>
              <b>Couldn&apos;t load the connected apps.</b>
            </p>
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

        {load.status === 'ready' && apps.length === 0 && (
          <div className="table-card empty">
            <Icon name="link" />
            <h2>No apps are connected.</h2>
            <p>When people connect an AI agent, it shows here.</p>
          </div>
        )}

        {/* Element ids by position: a user id may hold characters an id reference can't. */}
        {byUser(apps).map((group, index) => (
          <section
            key={group.userId}
            className="table-card apps-user"
            aria-labelledby={`user-${String(index)}`}
          >
            <div className="apps-user-head">
              <h2 id={`user-${String(index)}`}>
                <bdi>{group.userName}</bdi> <small className="muted">{group.userId}</small>
              </h2>
              <button
                className="btn"
                type="button"
                aria-describedby={`user-${String(index)}`}
                onClick={() => {
                  setBulkError(null);
                  setBulk({
                    kind: 'user',
                    userId: group.userId,
                    userName: group.userName,
                    count: group.apps.length,
                  });
                }}
              >
                Disconnect all for this user
              </button>
            </div>
            <ul className="apps-list">
              {group.apps.map((app) => (
                <li key={app.id} className="app-row">
                  <div className="app-text">
                    <AppName app={app} id={`app-${app.id}`} />
                    <AppFacts app={app} />
                    {rowError === app.id && (
                      <p className="alert" role="alert">
                        Couldn&apos;t disconnect. Try again.
                      </p>
                    )}
                  </div>
                  <button
                    className="btn"
                    type="button"
                    aria-describedby={`app-${app.id} user-${String(index)}`}
                    disabled={busy === app.id}
                    onClick={() => {
                      disconnectOne(app);
                    }}
                  >
                    <Icon name="unlink" size="sm" />
                    {busy === app.id ? 'Disconnecting…' : 'Disconnect'}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}

        {bulk !== null && (
          <ConfirmDialog
            title={
              bulk.kind === 'all'
                ? 'Disconnect every app?'
                : `Disconnect all apps of ${bulk.userName}?`
            }
            description={`This ends ${counted(bulk.count, 'connection')} at once. ${
              bulk.kind === 'all' ? 'Everyone' : 'They'
            } will need to connect again from the agent.`}
            confirmLabel={`Disconnect ${counted(bulk.count, 'connection')}`}
            busyLabel="Disconnecting…"
            busy={bulkBusy}
            error={bulkError}
            onCancel={() => {
              setBulk(null);
            }}
            onConfirm={confirmBulk}
          />
        )}
      </div>
    </main>
  );
}

import type { ConnectedApp } from '@simplearchitecture/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { disconnectApp, listConnectedApps } from '../api';
import { useMe } from '../auth';
import { Icon } from '../icons';

/**
 * Connected apps (/agents): the AI agents this user has allowed, each Allow its own row, with
 * Disconnect and no confirmation (the safe direction; undoing it costs a new sign-in). Shown to
 * everyone signed in, so someone who lost their role can still disconnect.
 */

export const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

type Load = { status: 'loading' } | { status: 'ready'; apps: ConnectedApp[] } | { status: 'error' };

/** The facts on a row: where it goes back to, and its dates. */
export function AppFacts({ app }: { app: ConnectedApp }) {
  return (
    <>
      <p>
        Sends you back to{' '}
        {app.loopback ? (
          'an app on this computer'
        ) : (
          <span className="host">{app.redirectHost}</span>
        )}
      </p>
      <p>
        <span>Connected {dateFormat.format(new Date(app.connectedAt))}</span>
        <span aria-hidden="true"> · </span>
        <span>
          {app.lastUsedAt === null
            ? 'Not used yet'
            : `Last used ${dateFormat.format(new Date(app.lastUsedAt))}`}
        </span>
      </p>
      <p>Ends {dateFormat.format(new Date(app.expiresAt))}</p>
    </>
  );
}

/** The app's name as it gave it, text only; none given when it gave none. */
export function AppName({ app, id }: { app: ConnectedApp; id: string }) {
  return (
    <h2 id={id} className="app-name">
      {app.clientName === null ? 'No name given' : <bdi>{app.clientName}</bdi>}
    </h2>
  );
}

/** The MCP address to give an AI agent, with Copy. */
export function AgentAddress() {
  const address = `${window.location.origin}/mcp`;
  const [status, setStatus] = useState('');
  return (
    <section className="agent-address" aria-labelledby="agent-address-title">
      <h2 id="agent-address-title">Address for your AI agent</h2>
      <div className="address-row">
        <input
          className="address-field"
          type="text"
          readOnly
          value={address}
          aria-labelledby="agent-address-title"
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <button
          className="btn"
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(address).then(
              () => {
                setStatus('Address copied');
              },
              () => {
                setStatus("Couldn't copy. Select the address and copy it.");
              },
            );
          }}
        >
          <Icon name="copy" size="sm" />
          Copy
        </button>
      </div>
      <p className="vh" role="status">
        {status}
      </p>
    </section>
  );
}

export function ConnectedAppsPage() {
  const me = useMe();
  const hasRole = me.spaces.includes('viewing');
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfter = useRef<string | null | undefined>(undefined);

  const reload = useCallback((signal?: AbortSignal) => {
    listConnectedApps(signal)
      .then((apps) => {
        setLoad({ status: 'ready', apps });
      })
      .catch(() => {
        if (!signal?.aborted) setLoad({ status: 'error' });
      });
  }, []);

  useEffect(() => {
    document.title = 'Connected apps – SimpleArchitecture';
    const controller = new AbortController();
    reload(controller.signal);
    return () => {
      controller.abort();
    };
  }, [reload]);

  // After a row goes: focus on the next row's Disconnect, or the previous, or the heading.
  useEffect(() => {
    const target = focusAfter.current;
    if (target === undefined) return;
    focusAfter.current = undefined;
    const button = target === null ? null : document.getElementById(`disconnect-${target}`);
    (button ?? heading.current)?.focus();
  });

  const disconnect = (app: ConnectedApp) => {
    if (load.status !== 'ready') return;
    setBusy(app.id);
    setRowError(null);
    disconnectApp(app.id)
      .then(() => {
        const index = load.apps.findIndex((other) => other.id === app.id);
        const rest = load.apps.filter((other) => other.id !== app.id);
        focusAfter.current = (rest[index] ?? rest[index - 1])?.id ?? null;
        setLoad({ status: 'ready', apps: rest });
        setStatus(
          app.clientName === null
            ? 'The app is disconnected.'
            : `${app.clientName} is disconnected.`,
        );
      })
      .catch(() => {
        setRowError(app.id);
      })
      .finally(() => {
        setBusy(null);
      });
  };

  return (
    <main id="content" tabIndex={-1} className="page-scroll">
      <div className="page apps-page">
        <div className="page-head">
          <div>
            <h1 ref={heading} tabIndex={-1}>
              Connected apps
            </h1>
            <p>
              These AI agents can read the models you can see in Viewing. Signing out of this
              browser doesn&apos;t disconnect them.
            </p>
          </div>
        </div>

        {hasRole && <AgentAddress />}

        <p className="vh" role="status">
          {status}
        </p>

        {load.status === 'loading' && (
          <div className="table-card apps-list" aria-busy="true">
            <p className="vh" role="status">
              Loading…
            </p>
            {[0, 1].map((row) => (
              <div key={row} className="app-row">
                <span className="skeleton" style={{ width: '40%' }} />
                <span className="skeleton" style={{ width: '70%' }} />
              </div>
            ))}
          </div>
        )}

        {load.status === 'error' && (
          <div className="table-card load-error" role="alert">
            <Icon name="alert" />
            <p>
              <b>Couldn&apos;t load your connected apps.</b>
            </p>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setLoad({ status: 'loading' });
                reload();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {load.status === 'ready' && load.apps.length === 0 && (
          <div className="table-card empty">
            <Icon name="link" />
            <h2>No apps are connected.</h2>
            <p>
              {hasRole
                ? 'To connect one, add the address above in your AI agent and sign in when it asks.'
                : 'To connect one, you need the Viewer role or higher. Ask an administrator.'}
            </p>
          </div>
        )}

        {load.status === 'ready' && load.apps.length > 0 && (
          <ul className="table-card apps-list" aria-label="Your connected apps">
            {load.apps.map((app) => (
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
                  id={`disconnect-${app.id}`}
                  className="btn"
                  type="button"
                  aria-describedby={`app-${app.id}`}
                  disabled={busy === app.id}
                  onClick={() => {
                    disconnect(app);
                  }}
                >
                  <Icon name="unlink" size="sm" />
                  {busy === app.id ? 'Disconnecting…' : 'Disconnect'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

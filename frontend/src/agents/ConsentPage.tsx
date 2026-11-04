import type { AgentRequest } from '@simplearchitecture/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiRequestError, decideAgentRequest, getAgentRequest } from '../api';
import { useMe } from '../auth';
import { Icon } from '../icons';
import { BrandLogo } from '../shell/BrandLogo';
import { browser } from './browser';

/**
 * The consent page an AI agent's sign-in goes through (/agents/connect?request=<id>): who asks,
 * where the browser goes back to, what the agent may do, then Allow or Deny. Outside the shell:
 * nothing here leads away while the agent waits. The agent's name is what it says about itself,
 * so it is shown as text only, under its own label, never in a heading, the title or a button.
 */

/** Allow ignores presses this long after the page shows or the tab becomes visible again. */
export const allowGuardMs = 1000;
/** After this long without leaving, the page says what to do. */
const stuckMs = 5000;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

type State =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'ready'; request: AgentRequest; working: 'allow' | 'deny' | null; error: boolean }
  | { kind: 'leaving'; allowed: boolean; request: AgentRequest };

function hostText(request: AgentRequest): string {
  return request.loopback
    ? `An app on this computer (${request.redirectHost})`
    : request.redirectHost;
}

const titles = {
  loading: 'Connect an AI agent',
  ready: 'Connect an AI agent',
  noRole: "Can't connect",
  invalid: 'Request not valid',
  allowed: 'Connected',
  denied: 'Not connected',
};

export function ConsentPage() {
  const me = useMe();
  const [params] = useSearchParams();
  const id = params.get('request');
  const invalidFromStart = id === null || params.get('error') !== null;
  const [state, setState] = useState<State>(
    invalidFromStart ? { kind: 'invalid' } : { kind: 'loading' },
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const status = useRef<HTMLDivElement>(null);
  const [guarded, setGuarded] = useState(true);
  const [stuck, setStuck] = useState(false);
  const canAllow = me.spaces.includes('viewing');

  useEffect(() => {
    if (id === null || invalidFromStart) return;
    const controller = new AbortController();
    getAgentRequest(id, controller.signal)
      .then((request) => {
        setState({ kind: 'ready', request, working: null, error: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: 'invalid' });
      });
    return () => {
      controller.abort();
    };
  }, [id, invalidFromStart]);

  // Against a click that wasn't meant: Allow waits a second after the page shows, and again each
  // time the tab becomes visible or the window gets focus (a popup window closing over it leaves
  // the tab visible the whole time).
  useEffect(() => {
    if (state.kind !== 'ready') return;
    let timer = setTimeout(() => {
      setGuarded(false);
    }, allowGuardMs);
    const restart = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      setGuarded(true);
      timer = setTimeout(() => {
        setGuarded(false);
      }, allowGuardMs);
    };
    document.addEventListener('visibilitychange', restart);
    window.addEventListener('focus', restart);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', restart);
      window.removeEventListener('focus', restart);
    };
  }, [state.kind]);

  const shown = state.kind === 'ready' || state.kind === 'invalid' ? state.kind : null;
  useEffect(() => {
    if (shown !== null) heading.current?.focus();
  }, [shown]);

  useEffect(() => {
    if (state.kind !== 'leaving') return;
    status.current?.focus();
    const timer = setTimeout(() => {
      setStuck(true);
    }, stuckMs);
    return () => {
      clearTimeout(timer);
    };
  }, [state.kind]);

  const title =
    state.kind === 'invalid'
      ? titles.invalid
      : state.kind === 'leaving'
        ? state.allowed
          ? titles.allowed
          : titles.denied
        : state.kind === 'ready' && !canAllow
          ? titles.noRole
          : titles.ready;
  useEffect(() => {
    document.title = `${title} – SimpleArchitecture`;
  }, [title]);

  const decide = useCallback(
    (allow: boolean) => {
      if (state.kind !== 'ready' || state.working !== null || id === null) return;
      const { request } = state;
      setState({ ...state, working: allow ? 'allow' : 'deny', error: false });
      decideAgentRequest(id, allow)
        .then((location) => {
          setState({ kind: 'leaving', allowed: allow, request });
          browser.leave(location);
        })
        .catch((error: unknown) => {
          if (error instanceof ApiRequestError && error.status === 404) {
            setState({ kind: 'invalid' });
            return;
          }
          setState({ kind: 'ready', request, working: null, error: true });
        });
    },
    [id, state],
  );

  if (state.kind === 'loading') {
    return (
      <p className="app-message" role="status">
        Loading…
      </p>
    );
  }

  return (
    <main id="content" className="app-message consent-page" aria-labelledby="consent-title">
      <section className="message-card consent">
        <BrandLogo className="brand-logo signed-out-logo" />
        {state.kind === 'invalid' && (
          <>
            <h1 id="consent-title" ref={heading} tabIndex={-1}>
              This request isn&apos;t valid
            </h1>
            <p>
              It may have expired or already been used. Go back to your AI agent and connect again.
            </p>
            <Link className="btn" to="/">
              Go to SimpleArchitecture
            </Link>
          </>
        )}

        {state.kind === 'leaving' && (
          <>
            <h1 id="consent-title">{state.allowed ? 'Connected' : 'Not connected'}</h1>
            <div className="consent-status" role="status" ref={status} tabIndex={-1}>
              <span className="spinner" aria-hidden="true" />
              <p>Returning you to {hostText(state.request)}…</p>
              {stuck && <p>If nothing happens, close this tab and go back to your AI agent.</p>}
            </div>
          </>
        )}

        {state.kind === 'ready' && !canAllow && (
          <>
            <h1 id="consent-title" ref={heading} tabIndex={-1}>
              You can&apos;t connect an AI agent yet
            </h1>
            <p>
              You&apos;re signed in as {me.name}, but you don&apos;t have a role in
              SimpleArchitecture yet. An agent can only read what you can see.
            </p>
            <p>Ask an administrator for the Viewer role or higher.</p>
            {state.error && (
              <p className="alert" role="alert">
                Something went wrong. Try again.
              </p>
            )}
            <div className="consent-actions">
              <button
                className="btn lg"
                type="button"
                disabled={state.working !== null}
                onClick={() => {
                  decide(false);
                }}
              >
                {state.request.loopback
                  ? 'Go back to the app'
                  : `Go back to ${state.request.redirectHost}`}
              </button>
            </div>
          </>
        )}

        {state.kind === 'ready' && canAllow && (
          <>
            <h1 id="consent-title" ref={heading} tabIndex={-1}>
              Connect an AI agent?
            </h1>
            <dl className="consent-facts">
              <div>
                <dt>Name it gives</dt>
                <dd>
                  {state.request.clientName === null ? (
                    <span className="muted">None given</span>
                  ) : (
                    <bdi className="agent-name">{state.request.clientName}</bdi>
                  )}
                </dd>
              </div>
              <div>
                <dt>Sends you back</dt>
                <dd>{hostText(state.request)}</dd>
              </div>
            </dl>
            <p className="consent-lead">If you allow it, it can:</p>
            <ul className="consent-can">
              <li>
                <Icon name="check" size="sm" />
                Read the models you can see in Viewing
              </li>
              <li>
                <Icon name="x" size="sm" />
                It can&apos;t change, add or delete anything
              </li>
            </ul>
            <p>
              It stays connected for 7 days, until{' '}
              {dateFormat.format(new Date(state.request.connectionEndsAt))}. You can disconnect it
              sooner in Connected apps, in your account menu.
            </p>
            <p>
              You&apos;re signed in as {me.name}
              {me.email === null ? '' : ` (${me.email})`}.
            </p>
            <p className="info-notice">
              <Icon name="info" />
              <span>Only allow this if you started connecting this agent yourself, just now.</span>
            </p>
            {state.error && (
              <p className="alert" role="alert">
                Something went wrong. Try again.
              </p>
            )}
            <div className="consent-actions">
              <button
                className="btn lg"
                type="button"
                disabled={state.working !== null}
                onClick={() => {
                  decide(false);
                }}
              >
                Deny
              </button>
              <button
                className="btn primary lg"
                type="button"
                disabled={state.working !== null}
                aria-disabled={guarded ? 'true' : undefined}
                data-guarded={guarded ? '' : undefined}
                onClick={() => {
                  if (!guarded) decide(true);
                }}
              >
                {state.working === 'allow' ? 'Connecting…' : 'Allow'}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

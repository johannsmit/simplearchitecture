import { knownRoles, spaces, type AboutResponse, type Space } from '@simplearchitecture/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { getAbout } from '../api';
import { roleLabel, spaceLabels, useMe } from '../auth';
import { Icon } from '../icons';
import { Popover } from './Popover';
import { spaceIcons } from './spaceIcons';

const accessWords: Record<Space, string> = {
  viewing: 'Read',
  modelling: 'Edit elements',
  admin: 'Manage models',
};

/** Up to two initials from the display name. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}

/**
 * The code version the server runs, e.g. "Version 0.10.0", asked for each time the menu opens (so
 * it shows a new deployment). Plain text only, so a copy of it reads as it shows. The commit stays in
 * GET /api/about and the server's log. Nothing while loading, without a role or on an error: it's a
 * detail, never a message.
 */
function AboutLine() {
  const [about, setAbout] = useState<AboutResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getAbout(controller.signal).then(setAbout, () => undefined);
    return () => {
      controller.abort();
    };
  }, []);

  if (about === null) return null;
  return <p className="about-line">Version {about.version}</p>;
}

/** The user button (name and all roles) and its menu: who, roles, access per space, sign out. */
export function UserMenu() {
  const me = useMe();
  const roles = knownRoles(me.roles);
  const short = initials(me.name);

  return (
    <Popover
      id="user"
      buttonClassName="user-btn"
      // Named by its visible text (WCAG 2.5.3): name, roles, then what it opens. Below 1280px the
      // name and roles are only visually hidden, so the name stays the same.
      buttonContent={
        <>
          <span className="avatar" aria-hidden="true">
            {short}
          </span>
          <span className="who">
            <b>{me.name}</b> <small className="roles-line">{roleLabel(me)}</small>
            <span className="vh">, account menu</span>
          </span>
          <Icon name="chev-down" size="sm" />
        </>
      }
      popoverClassName="user-pop"
    >
      {(close) => (
        <>
          <div className="menu-head">
            <span className="avatar" aria-hidden="true">
              {short}
            </span>
            <div>
              <p>
                <b>{me.name}</b>
              </p>
              {me.email !== null && <p className="muted">{me.email}</p>}
              <p className="sso">Signed in</p>
            </div>
          </div>
          <h3>Roles</h3>
          <ul className="role-chips" aria-label="Roles">
            {roles.length > 0 ? (
              roles.map((role) => (
                <li key={role} className="role-chip">
                  {role}
                </li>
              ))
            ) : (
              <li className="role-chip">No role</li>
            )}
          </ul>
          <h3>Your access</h3>
          <ul className="access">
            {spaces.map((space) => {
              const allowed = me.spaces.includes(space);
              return (
                <li key={space}>
                  <Icon name={spaceIcons[space]} size="sm" />
                  {spaceLabels[space]}
                  {allowed ? (
                    <span className="state">
                      <Icon name="check" size="sm" />
                      {accessWords[space]}
                    </span>
                  ) : (
                    <span className="state no">
                      <Icon name="lock" size="sm" />
                      No access
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="pop-sep" />
          <Link className="menu-item" to="/agents" onClick={close}>
            <Icon name="link" />
            Connected apps
          </Link>
          <a
            className="menu-item"
            href="/third-party-licenses.txt"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="file" />
            Third-party licences
          </a>
          {/* A real form POST: the API ends the session and sends the browser on to the provider. */}
          <form method="post" action="/auth/logout">
            <button className="menu-item" type="submit">
              <Icon name="logout" />
              Sign out
            </button>
          </form>
          <AboutLine />
        </>
      )}
    </Popover>
  );
}

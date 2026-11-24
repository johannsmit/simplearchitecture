import { requiredRoleForSpace, type Space } from '@simplearchitecture/shared';
import { useEffect, type MouseEvent, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { spaceLabels, useMe } from '../auth';
import { usePageTitle } from '../branding';
import { Icon } from '../icons';
import { Inline } from './Keys';
import { keyTables } from './keyTables';

/** The help pages, above each one. */
export function HelpNav() {
  return (
    <nav className="help-nav" aria-label="Help pages">
      <ul>
        <li>
          <NavLink to="/help" end>
            Overview
          </NavLink>
        </li>
        <li>
          <NavLink to="/help/viewing">Viewing</NavLink>
        </li>
        <li>
          <NavLink to="/help/modelling">Modelling</NavLink>
        </li>
        <li>
          <NavLink to="/help/admin">Admin</NavLink>
        </li>
      </ul>
    </nav>
  );
}

/** Moves focus to a heading on the page (focus scrolls it into view), as the skip link does. */
function focusById(id: string): boolean {
  const target = document.getElementById(id);
  if (!target) return false;
  target.focus();
  return true;
}

function onAnchorClick(event: MouseEvent<HTMLAnchorElement>) {
  const id = event.currentTarget.hash.slice(1);
  if (focusById(id)) event.preventDefault();
}

/** A heading that an "On this page" link, or a link from another help page, moves focus to. */
export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 id={id} tabIndex={-1}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A two-column table: a pointer action or a key, and what it does. */
function HelpTable({
  caption,
  first,
  rows,
}: {
  caption: string;
  first: string;
  rows: { what: string; does: string }[];
}) {
  return (
    <div className="table-card help-table-wrap">
      <table className="help-table">
        <caption className="vh">
          <Inline text={caption} />
        </caption>
        <thead>
          <tr>
            <th scope="col">{first}</th>
            <th scope="col">What it does</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.what}>
              <td className={first === 'Key' ? 'help-key' : 'help-action'}>
                <Inline text={row.what} />
              </td>
              <td>
                <Inline text={row.does} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What each mouse action does, with keys written as `Shift`. */
export function PointerTable({ caption, rows }: { caption: string; rows: [string, string][] }) {
  return (
    <HelpTable
      caption={caption}
      first="Action"
      rows={rows.map(([what, does]) => ({ what, does }))}
    />
  );
}

/** The space's keyboard tables (frontend/src/help/keyTables.ts), each under its own heading. */
function KeyTables({ space }: { space: Space }) {
  return (
    <>
      {keyTables[space].map((table) => (
        <div key={table.id} className="help-keys" data-guide={table.guide}>
          <h3 id={table.id} tabIndex={-1}>
            <Inline text={table.title} />
          </h3>
          {table.before !== undefined && (
            <p>
              <Inline text={table.before} />
            </p>
          )}
          <HelpTable
            caption={table.title}
            first="Key"
            rows={table.rows.map((row) => ({ what: row.keys, does: row.does }))}
          />
          {table.after !== undefined && (
            <p>
              <Inline text={table.after} />
            </p>
          )}
        </div>
      ))}
    </>
  );
}

/** Says that the user can't use this space, and who can. Static text: the page loads with it. */
function NoAccessNotice({ space }: { space: Space }) {
  const label = spaceLabels[space];
  return (
    <p className="help-notice">
      <Icon name="lock" />
      <span>
        You don&apos;t have access to {label}. It is for people with the{' '}
        {requiredRoleForSpace[space]} role{space === 'admin' ? '' : ' or higher'}. Ask an
        administrator if you need it.
      </span>
    </p>
  );
}

/** The frame of every help page: the help pages' links, the heading and the lead. */
export function HelpFrame({
  title,
  lead,
  children,
}: {
  title: string;
  lead: ReactNode;
  children: ReactNode;
}) {
  const { hash } = useLocation();
  // A link from another help page to a heading (e.g. /help/viewing#keys-menus-and-dialogs).
  useEffect(() => {
    if (hash.length > 1) focusById(decodeURIComponent(hash.slice(1)));
  }, [hash]);

  return (
    <main id="content" tabIndex={-1} className="page-scroll">
      <div className="page help-page">
        <HelpNav />
        <div className="page-head">
          <div>
            <h1>{title}</h1>
            <p className="lead">{lead}</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}

/** A space's help page: what you can do, pointer actions, keyboard shortcuts, and a way in. */
export function SpaceHelpPage({
  space,
  lead,
  doing,
  pointer,
  keysIntro,
}: {
  space: Space;
  lead: ReactNode;
  doing: ReactNode;
  pointer: [string, string][];
  keysIntro?: ReactNode;
}) {
  const me = useMe();
  const label = spaceLabels[space];
  const allowed = me.spaces.includes(space);
  usePageTitle(`${label} help`);

  return (
    <HelpFrame title={`${label} help`} lead={lead}>
      {!allowed && <NoAccessNotice space={space} />}
      <nav className="help-toc" aria-label="On this page">
        <ul>
          <li>
            <a href="#what-you-can-do" onClick={onAnchorClick}>
              What you can do
            </a>
          </li>
          <li>
            <a href="#pointer-actions" onClick={onAnchorClick}>
              Pointer actions
            </a>
          </li>
          <li>
            <a href="#keyboard-shortcuts" onClick={onAnchorClick}>
              Keyboard shortcuts
            </a>
          </li>
        </ul>
      </nav>
      <Section id="what-you-can-do" title="What you can do">
        {doing}
      </Section>
      <Section id="pointer-actions" title="Pointer actions">
        <PointerTable caption={`Pointer actions in ${label}`} rows={pointer} />
      </Section>
      <Section id="keyboard-shortcuts" title="Keyboard shortcuts">
        <p>
          <Inline text="On a Mac, use `⌘` where a key says `Ctrl`." />
        </p>
        {keysIntro}
        <KeyTables space={space} />
      </Section>
      {allowed && (
        <p className="help-open">
          <Link className="btn primary" to={`/${space}`}>
            Open {label}
          </Link>
        </p>
      )}
    </HelpFrame>
  );
}

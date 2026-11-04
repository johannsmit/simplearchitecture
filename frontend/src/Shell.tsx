import type { MouseEvent } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { spaceLabels, useMe } from './auth';
import { ErrorBoundary } from './ErrorBoundary';
import { Icon } from './icons';
import { ModelsProvider } from './models';
import { ModelPicker } from './shell/ModelPicker';
import { BrandLogo } from './shell/BrandLogo';
import { PopoverGroup } from './shell/Popover';
import { spaceIcons } from './shell/spaceIcons';
import { ThemeMenu } from './shell/ThemeMenu';
import { UserMenu } from './shell/UserMenu';

/** Where the skip link goes on each screen (the first focusable element on the page). */
function skipTarget(pathname: string): { id: string; label: string } {
  if (pathname.startsWith('/viewing/models/') || pathname.startsWith('/modelling/models/')) {
    return { id: 'canvas', label: 'Skip to canvas' };
  }
  if (['/viewing', '/viewing/', '/modelling', '/modelling/'].includes(pathname)) {
    return { id: 'models', label: 'Skip to models' };
  }
  return { id: 'content', label: 'Skip to content' };
}

/** App shell: header (brand, spaces, model picker, theme, user) and the current page. */
export function Shell() {
  const me = useMe();
  const { pathname } = useLocation();
  const inViewing = pathname === '/viewing' || pathname.startsWith('/viewing/');
  const inModelling = pathname === '/modelling' || pathname.startsWith('/modelling/');
  const skip = skipTarget(pathname);

  const onSkip = (event: MouseEvent<HTMLAnchorElement>) => {
    const target = document.getElementById(skip.id);
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <ModelsProvider>
      <div className="shell">
        <a className="skip" href={`#${skip.id}`} onClick={onSkip}>
          {skip.label}
        </a>
        <PopoverGroup>
          <header className="app-header">
            <Link className="brand" to="/" aria-label="SimpleArchitecture home">
              <BrandLogo className="brand-logo" />
              <span className="brand-title">SimpleArchitecture</span>
            </Link>
            <span className="divider" aria-hidden="true" />
            {/* Only the spaces the user may use (deny by default: the rest are hidden). */}
            <nav aria-label="Spaces">
              <ul className="spaces">
                {me.spaces.map((space) => (
                  <li key={space}>
                    <NavLink to={`/${space}`}>
                      <Icon name={spaceIcons[space]} />
                      <span className="space-label">{spaceLabels[space]}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
            {inViewing && me.spaces.includes('viewing') && <ModelPicker space="viewing" />}
            {inModelling && me.spaces.includes('modelling') && <ModelPicker space="modelling" />}
            <div className="header-end">
              <ThemeMenu />
              <UserMenu />
            </div>
          </header>
        </PopoverGroup>
        <div className="shell-main">
          <ErrorBoundary
            resetKey={pathname}
            title="This page couldn't be shown."
            backTo="/"
            backLabel="Go to the start page"
          >
            <Outlet />
          </ErrorBoundary>
        </div>
      </div>
    </ModelsProvider>
  );
}

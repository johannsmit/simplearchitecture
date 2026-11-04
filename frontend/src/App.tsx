import type { Space } from '@simplearchitecture/shared';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router';
import { onSessionEnded } from './api';
import { BrandingPage } from './admin/BrandingPage';
import { ConnectedAppsAdminPage } from './admin/ConnectedAppsAdminPage';
import { DatabasePage } from './admin/DatabasePage';
import { ConnectedAppsPage } from './agents/ConnectedAppsPage';
import { ConsentPage } from './agents/ConsentPage';
import { MeContext, useAuth, useMe } from './auth';
import { Shell } from './Shell';
import { NoAccessPage } from './routes/NoAccessPage';
import { NotFoundPage } from './routes/NotFoundPage';
import { SignedOutPage } from './routes/SignedOutPage';
import { UnavailablePage } from './routes/UnavailablePage';
import { ModelsPage } from './viewing/ModelsPage';

// The explorer (React Flow, the layout) loads only when a model is opened.
const ExplorerPage = lazy(async () => ({
  default: (await import('./viewing/ExplorerPage')).ExplorerPage,
}));

/**
 * Renders a space only for users whose roles open it. Otherwise the No access page is shown
 * and the space's component (and so its data requests) never mounts. The API enforces the
 * same rule on its own.
 */
function SpaceGate({ space, children }: { space: Space; children: ReactNode }) {
  const me = useMe();
  return me.spaces.includes(space) ? children : <NoAccessPage space={space} />;
}

/** Lands on the first space the user can use, or explains that they have none. */
function Home() {
  const me = useMe();
  const first = me.spaces[0];
  return first ? <Navigate to={`/${first}`} replace /> : <NoAccessPage />;
}

/** The app's pages. */
function SignedInRoutes() {
  return (
    <Routes>
      {/* Outside the shell: one step in a flow that started in an AI agent. */}
      <Route path="agents/connect" element={<ConsentPage />} />
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        {/* For everyone signed in, with or without a role: they can always disconnect. */}
        <Route path="agents" element={<ConnectedAppsPage />} />
        <Route
          path="admin"
          element={
            <SpaceGate space="admin">
              <Outlet />
            </SpaceGate>
          }
        >
          {/* Users, roles and the metamodel follow. */}
          <Route index element={<Navigate to="models" replace />} />
          <Route path="models" element={<ModelsPage mode="manage" />} />
          <Route path="database" element={<DatabasePage />} />
          <Route path="branding" element={<BrandingPage />} />
          <Route path="apps" element={<ConnectedAppsAdminPage />} />
        </Route>
        <Route
          path="modelling"
          element={
            <SpaceGate space="modelling">
              <Outlet />
            </SpaceGate>
          }
        >
          <Route index element={<ModelsPage mode="model" />} />
          {/* The same explorer as Viewing, with editing on. */}
          <Route
            path="models/:modelId/*"
            element={
              <Suspense
                fallback={
                  <p className="app-message" role="status">
                    Loading…
                  </p>
                }
              >
                <ExplorerPage />
              </Suspense>
            }
          />
        </Route>
        <Route
          path="viewing"
          element={
            <SpaceGate space="viewing">
              <Outlet />
            </SpaceGate>
          }
        >
          <Route index element={<ModelsPage mode="view" />} />
          {/* One route for the explorer, so focusing elements never reloads the model. */}
          <Route
            path="models/:modelId/*"
            element={
              <Suspense
                fallback={
                  <p className="app-message" role="status">
                    Loading…
                  </p>
                }
              >
                <ExplorerPage />
              </Suspense>
            }
          />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export function App() {
  const auth = useAuth();
  // Any API call that answers 401 means the session ended (timed out or signed out elsewhere).
  const [sessionEnded, setSessionEnded] = useState(false);
  useEffect(
    () =>
      onSessionEnded(() => {
        setSessionEnded(true);
      }),
    [],
  );

  if (sessionEnded) return <SignedOutPage ended />;

  switch (auth.state) {
    case 'loading':
      return (
        <p className="app-message" role="status">
          Loading…
        </p>
      );
    case 'signed-out':
      return <SignedOutPage />;
    case 'error':
      return <UnavailablePage />;
    case 'signed-in':
      return (
        <MeContext value={auth.me}>
          <SignedInRoutes />
        </MeContext>
      );
  }
}

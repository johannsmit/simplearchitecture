import { useLocation, useSearchParams } from 'react-router';
import { BrandLogo } from '../shell/BrandLogo';

/** Shown when nobody is signed in. Sign-in runs through the API (/auth/login), not in the browser. */
export function SignedOutPage({ ended = false }: { ended?: boolean }) {
  const [params] = useSearchParams();
  const { pathname, search } = useLocation();
  const failed = params.get('signin') === 'failed';
  // The API's sign-in rate limit (per network address) sends the browser here.
  const busy = params.get('signin') === 'busy';
  // Come back to this page after signing in. The API accepts only paths inside the app's spaces.
  const here = `${pathname}${search}`;
  const signInUrl =
    pathname === '/' ? '/auth/login' : `/auth/login?returnTo=${encodeURIComponent(here)}`;

  return (
    <main className="app-message signed-out">
      <section className="message-card">
        <BrandLogo className="brand-logo signed-out-logo" />
        <h1>SimpleArchitecture</h1>
        {failed && (
          <p className="alert" role="alert">
            Sign-in didn&apos;t complete. Please try again.
          </p>
        )}
        {busy && (
          <p className="alert" role="alert">
            Too many sign-in attempts from your network. Wait a minute and try again.
          </p>
        )}
        {ended && (
          <p className="alert" role="alert">
            Your session ended. Sign in again to continue.
          </p>
        )}
        <p>Sign in with your work account to continue.</p>
        {/* A full-page navigation (not a router link): the API redirects on to the provider. */}
        <a className="btn primary lg" href={signInUrl}>
          Sign in
        </a>
      </section>
    </main>
  );
}

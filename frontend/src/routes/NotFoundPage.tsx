import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main id="content" tabIndex={-1} className="app-message">
      <section className="message-card">
        <h1>Page not found</h1>
        <p>There&apos;s nothing at this address.</p>
        <Link className="btn" to="/">
          Go to the start page
        </Link>
      </section>
    </main>
  );
}

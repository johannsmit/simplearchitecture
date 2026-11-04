import { BrandMark } from '../icons';

/** The API can't be reached (or answered something unexpected) when the app starts. */
export function UnavailablePage() {
  return (
    <main className="app-message">
      <section className="message-card">
        <BrandMark />
        <h1>SimpleArchitecture is unavailable</h1>
        <p>The server can&apos;t be reached right now. Try again in a moment.</p>
        <button
          className="btn"
          type="button"
          onClick={() => {
            window.location.reload();
          }}
        >
          Try again
        </button>
      </section>
    </main>
  );
}

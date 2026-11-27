import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Icon } from './icons';

interface ErrorBoundaryProps {
  /** A change (e.g. the URL) clears the error and tries again. */
  resetKey: string;
  /** What went wrong, in words: "This model couldn't be shown." */
  title: string;
  /** Where the way out goes, and what it says. */
  backTo: string;
  backLabel: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  failedFor: string | null;
  /** A page's code failed to load: Try again reloads the app. */
  reload: boolean;
}

/**
 * A page's code (a chunk loaded on first use) couldn't be fetched, e.g. offline, or in a tab left
 * open across an update that replaced it. React keeps the failure, so only a reload tries again.
 */
export class PageLoadError extends Error {
  constructor(cause: unknown) {
    super("A page's code couldn't be loaded.", { cause });
    this.name = 'PageLoadError';
  }
}

/**
 * Catches a rendering error below it (e.g. a model the canvas can't draw) and shows a message
 * with a way out and Try again, instead of an empty page. The header stays usable.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failedFor: null, reload: false };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { failedFor: '', reload: error instanceof PageLoadError };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ failedFor: this.props.resetKey });
    // The details go to the console for developers; the page shows no internals.
    console.error('Rendering failed', error, info.componentStack);
  }

  override render(): ReactNode {
    const { failedFor } = this.state;
    const failed = failedFor !== null && (failedFor === '' || failedFor === this.props.resetKey);
    if (!failed) return this.props.children;
    return (
      <div className="error-boundary" role="alert">
        <div className="empty">
          <Icon name="alert" />
          <h2>{this.props.title}</h2>
          <p>Something in it couldn&apos;t be displayed. Try again, or go back.</p>
          <div className="error-actions">
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                if (this.state.reload) window.location.reload();
                else this.setState({ failedFor: null });
              }}
            >
              Try again
            </button>
            <Link className="btn" to={this.props.backTo}>
              {this.props.backLabel}
            </Link>
          </div>
        </div>
      </div>
    );
  }
}

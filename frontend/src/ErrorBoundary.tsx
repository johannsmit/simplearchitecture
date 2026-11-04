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
}

/**
 * Catches a rendering error below it (e.g. a model the canvas can't draw) and shows a message
 * with a way out and Try again, instead of an empty page. The header stays usable.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { failedFor: null };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failedFor: '' };
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
                this.setState({ failedFor: null });
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

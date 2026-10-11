import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A render error on one screen used to blank the whole application, because
 * there were no boundaries at all (phase-4 audit 4.1). Two levels now:
 *
 *  - `app` wraps the whole tree, for what the shell itself throws. Its fallback
 *    cannot assume any layout, so it is plain and offers a reload.
 *  - `route` sits inside the shell's <Outlet>, so the navigation stays usable
 *    and one screen's failure does not take the others with it. The shells key
 *    it by pathname, so moving to another screen clears the error.
 *
 * The error id is the thing a user reads out to support. There is no client
 * error endpoint to send it to yet, so it goes to the console with the
 * component stack. The API's x-request-id (lib/http.ts:46) is not used here
 * because a render error has no request attached to it.
 *
 * Message and stack are shown only in development: a production stack leaks
 * internal file layout to whoever is looking at the screen.
 */

type Scope = 'app' | 'route';

type Props = { scope: Scope; children: ReactNode };

type State = { error: Error | null; errorId: string | null };

function newErrorId(): string {
  const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return raw
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
    .toUpperCase();
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorId: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, errorId: newErrorId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.state.errorId ?? 'unknown'}] ${this.props.scope} render error`, error, info.componentStack);
  }

  private retry = () => this.setState({ error: null, errorId: null });

  render() {
    const { error, errorId } = this.state;
    if (!error) return this.props.children;

    const isApp = this.props.scope === 'app';
    const frame = isApp
      ? 'flex min-h-screen items-center justify-center bg-ink-950 p-6 text-center'
      : 'mx-auto max-w-xl py-10';

    return (
      <div className={frame}>
        <div className="max-w-md rounded-lg border border-band-critical/40 bg-band-critical/5 p-6 text-left">
          <p className="text-lg font-semibold text-band-critical">
            {isApp ? 'Something went wrong.' : 'This screen could not be shown.'}
          </p>
          <p className="mt-2 text-sm text-ink-400">Try again. If it happens again, send support the reference below.</p>
          <p className="mt-3 font-mono text-xs text-ink-300">Reference: {errorId}</p>
          <div className="mt-4 flex gap-2">
            {isApp ? (
              <button className="btn-primary" onClick={() => window.location.reload()}>
                Reload
              </button>
            ) : (
              <button className="btn-primary" onClick={this.retry}>
                Try again
              </button>
            )}
          </div>
          {import.meta.env.DEV && (
            <pre className="mt-4 max-h-60 overflow-auto whitespace-pre-wrap text-2xs text-ink-500">
              {error.message}
              {'\n'}
              {error.stack}
            </pre>
          )}
        </div>
      </div>
    );
  }
}

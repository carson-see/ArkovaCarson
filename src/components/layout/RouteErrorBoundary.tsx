/**
 * Route-level Error Boundary (AUDIT-07)
 *
 * Catches render errors within a single route/page without crashing the entire app.
 * Users see a recovery UI specific to the failed section and can navigate away.
 * The top-level ErrorBoundary in App.tsx remains as a last-resort catch-all.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ERROR_BOUNDARY_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';

/** Maximum characters to display from error messages (prevents leaking internal details). */
const MAX_ERROR_MESSAGE_LENGTH = 200;

interface Props {
  children: ReactNode;
  /** Optional label for Sentry context (e.g., "DashboardPage") */
  section?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Sanitize an error message for display to end users.
 * Truncates long messages and strips potential secrets/paths.
 */
function sanitizeErrorMessage(message: string): string {
  // Strip filesystem paths (e.g., /Users/foo/bar/baz.ts)
  let sanitized = message.replace(/\/[^\s:]+\.[jt]sx?/g, '[internal]');
  // Strip anything that looks like a secret or token
  sanitized = sanitized.replace(/(sk_|ak_|Bearer\s+)[^\s"')]+/gi, '[redacted]');
  // Truncate
  if (sanitized.length > MAX_ERROR_MESSAGE_LENGTH) {
    sanitized = sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH) + '…';
  }
  return sanitized;
}

export class RouteErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Lazy-load Sentry to keep it out of the initial bundle (456KB saved)
    import('@/lib/sentry').then(({ Sentry: S }) => {
      S.captureException(error, {
        extra: {
          componentStack: errorInfo.componentStack,
          section: this.props.section ?? 'unknown-route',
        },
      });
    }).catch(() => { /* Sentry unavailable */ });
    console.error('[RouteErrorBoundary]', error, errorInfo);
  }

  private readonly handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  private readonly handleGoHome = (): void => {
    globalThis.location.href = ROUTES.DASHBOARD;
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[50vh] flex-col items-center justify-center p-8">
          <div className="glass-card max-w-md rounded-xl p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
              <AlertTriangle className="h-6 w-6 text-amber-500" />
            </div>
            <h2 className="mb-2 text-lg font-semibold">{ERROR_BOUNDARY_LABELS.TITLE}</h2>
            <p className="mb-6 text-sm text-muted-foreground">
              {ERROR_BOUNDARY_LABELS.DESCRIPTION}
            </p>
            {this.state.error && (
              <p className="mb-4 rounded bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                {sanitizeErrorMessage(this.state.error.message)}
              </p>
            )}
            <div className="flex justify-center gap-3">
              <Button variant="outline" size="sm" onClick={this.handleRetry}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {ERROR_BOUNDARY_LABELS.RETRY}
              </Button>
              <Button size="sm" onClick={this.handleGoHome}>
                <Home className="mr-2 h-4 w-4" />
                {ERROR_BOUNDARY_LABELS.GO_HOME}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

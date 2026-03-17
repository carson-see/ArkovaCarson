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
import { Sentry } from '@/lib/sentry';

interface Props {
  children: ReactNode;
  /** Optional label for Sentry context (e.g., "DashboardPage") */
  section?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
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
    // Report to Sentry with route context
    try {
      Sentry?.captureException(error, {
        extra: {
          componentStack: errorInfo.componentStack,
          section: this.props.section ?? 'unknown-route',
        },
      });
    } catch {
      // Sentry may not be initialized
    }
    console.error('[RouteErrorBoundary]', error, errorInfo);
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  private handleGoHome = (): void => {
    window.location.href = '/dashboard';
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[50vh] flex-col items-center justify-center p-8">
          <div className="glass-card max-w-md rounded-xl p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-500/10">
              <AlertTriangle className="h-6 w-6 text-amber-500" />
            </div>
            <h2 className="mb-2 text-lg font-semibold">Something went wrong</h2>
            <p className="mb-6 text-sm text-muted-foreground">
              This section encountered an error. You can try again or navigate to another page.
            </p>
            {this.state.error && (
              <p className="mb-4 rounded bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                {this.state.error.message}
              </p>
            )}
            <div className="flex justify-center gap-3">
              <Button variant="outline" size="sm" onClick={this.handleRetry}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Try Again
              </Button>
              <Button size="sm" onClick={this.handleGoHome}>
                <Home className="mr-2 h-4 w-4" />
                Dashboard
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

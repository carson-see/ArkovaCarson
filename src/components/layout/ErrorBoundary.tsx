/**
 * React Error Boundary
 *
 * Catches render errors in the component tree and displays a recovery UI.
 * Prevents the entire app from crashing on unhandled errors.
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Shield, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Lazy-load Sentry to keep it out of the initial bundle (456KB saved)
    import('@/lib/sentry').then(({ Sentry: S }) => {
      S.captureException(error, { extra: { componentStack: errorInfo.componentStack } });
    }).catch(() => { /* Sentry unavailable — error already logged below */ });
    console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleGoHome = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/dashboard';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
          <div className="flex max-w-md flex-col items-center space-y-6 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10">
              <Shield className="h-8 w-8 text-destructive" />
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                Something went wrong
              </h1>
              <p className="text-sm text-muted-foreground">
                An unexpected error occurred. Your data is safe — try refreshing
                the page or returning to the dashboard.
              </p>
            </div>
            {import.meta.env.DEV && this.state.error && (
              <pre className="w-full overflow-auto rounded-lg bg-muted p-4 text-left text-xs text-muted-foreground">
                {this.state.error.message}
              </pre>
            )}
            <div className="flex gap-3">
              <Button variant="outline" onClick={this.handleReset}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Try Again
              </Button>
              <Button onClick={this.handleGoHome}>Go to Dashboard</Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

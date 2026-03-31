/**
 * 404 Not Found Page
 *
 * Displayed for unknown routes instead of silently redirecting to dashboard.
 */

import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Shield, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/routes';

export function NotFoundPage() {
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'prerender-status-code';
    meta.content = '404';
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="flex max-w-md flex-col items-center space-y-6 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
          <Shield className="h-8 w-8 text-primary" />
        </div>
        <div className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">404</h1>
          <p className="text-lg text-muted-foreground">Page not found</p>
          <p className="text-sm text-muted-foreground">
            The page you are looking for does not exist or has been moved.
          </p>
        </div>
        <Button asChild>
          <Link to={ROUTES.DASHBOARD}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Go to Dashboard
          </Link>
        </Button>
      </div>
    </div>
  );
}

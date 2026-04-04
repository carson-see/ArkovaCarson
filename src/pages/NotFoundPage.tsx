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
import { usePageMeta } from '@/hooks/usePageMeta';

export function NotFoundPage() {
  usePageMeta({
    title: 'Page Not Found — Arkova',
    description: 'The page you are looking for does not exist or has been moved.',
  });

  useEffect(() => {
    // Signal 404 status to prerender/SSR crawlers
    const statusMeta = document.createElement('meta');
    statusMeta.name = 'prerender-status-code';
    statusMeta.content = '404';
    document.head.appendChild(statusMeta);

    // Prevent search engines from indexing 404 pages (GEO-14: soft 404 fix)
    const robotsMeta = document.createElement('meta');
    robotsMeta.name = 'robots';
    robotsMeta.content = 'noindex';
    document.head.appendChild(robotsMeta);

    return () => {
      statusMeta.parentNode?.removeChild(statusMeta);
      robotsMeta.parentNode?.removeChild(robotsMeta);
    };
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
        <nav className="flex flex-wrap justify-center gap-4 pt-4 text-sm text-muted-foreground" aria-label="Helpful links">
          <Link to={ROUTES.SEARCH} className="hover:text-primary transition-colors">Search Credentials</Link>
          <Link to={ROUTES.VERIFY_FORM} className="hover:text-primary transition-colors">Verify a Document</Link>
          <Link to={ROUTES.DEVELOPERS} className="hover:text-primary transition-colors">Developer API</Link>
          <Link to={ROUTES.ABOUT} className="hover:text-primary transition-colors">About Arkova</Link>
        </nav>
      </div>
    </div>
  );
}

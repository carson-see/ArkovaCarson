/**
 * Auth Guard Component
 *
 * Protects routes that require authentication.
 * Redirects to login if user is not authenticated.
 */

import { ReactNode, useEffect, useRef } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../hooks/useAuth';
import { ROUTES } from '../../lib/routes';
import { NAV_POLISH_LABELS } from '../../lib/copy';

interface AuthGuardProps {
  children: ReactNode;
  fallback?: ReactNode;
}

export function AuthGuard({ children, fallback }: Readonly<AuthGuardProps>) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const toastShown = useRef(false);
  const hadUser = useRef(false);

  // Track whether the user was previously authenticated
  useEffect(() => {
    if (user) {
      hadUser.current = true;
    }
  }, [user]);

  // Show toast when redirecting unauthenticated user (UF-09)
  // Skip toast if user just signed out (had a session, now doesn't)
  useEffect(() => {
    if (!loading && !user && !fallback && !toastShown.current && !hadUser.current) {
      toastShown.current = true;
      toast.info(NAV_POLISH_LABELS.AUTH_REDIRECT_TOAST);
    }
  }, [loading, user, fallback]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!user) {
    if (fallback) {
      return <>{fallback}</>;
    }

    // Redirect to login, preserving the intended destination
    return <Navigate to={ROUTES.LOGIN} state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

/**
 * Platform Admin Route Guard (SCRUM-2939)
 *
 * Gates platform-only admin surfaces (treasury, pipeline, platform controls,
 * payment analytics, ops-SLO, system health, platform overview) to platform
 * admins ONLY. A legitimate ORG_ADMIN or INDIVIDUAL is redirected to their own
 * dashboard rather than shown platform-wide data.
 *
 * Authority: the `profiles.is_platform_admin` DB flag (via `useProfile`), the
 * SAME source the worker and RLS enforce — NOT the removed email whitelist.
 *
 * This is a CLIENT guard for UX + defence-in-depth. It is NOT the security
 * boundary: every platform endpoint/RPC re-verifies `is_platform_admin`
 * server-side, so hiding a route here never stands alone. Must be used inside
 * <AuthGuard> (assumes the user is already authenticated).
 */

import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useProfile } from '@/hooks/useProfile';
import { ROUTES } from '@/lib/routes';
import { isPlatformAdmin } from '@/lib/platform';

interface PlatformAdminRouteProps {
  children: ReactNode;
}

export function PlatformAdminRoute({ children }: Readonly<PlatformAdminRouteProps>) {
  const { loading, profile } = useProfile();

  // Wait for the profile fetch before deciding — redirecting on a not-yet-loaded
  // profile would bounce a real admin on hard refresh.
  if (loading || !profile) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isPlatformAdmin(profile)) {
    return <Navigate to={ROUTES.DASHBOARD} replace />;
  }

  return <>{children}</>;
}

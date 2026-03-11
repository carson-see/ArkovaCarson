/**
 * Route Guard Component
 *
 * Enforces routing based on profile state (role, org, review status).
 * Must be used inside AuthGuard (assumes user is authenticated).
 *
 * Redirects users to the correct destination when they try to access
 * a route that doesn't match their profile state:
 * - role NULL        → /onboarding/role
 * - ORG_ADMIN no org → /onboarding/org
 * - requires_manual_review → /review-pending
 * - INDIVIDUAL ready → main app
 * - ORG_ADMIN ready  → main app
 */

import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useProfile, type RouteDestination } from '@/hooks/useProfile';
import { destinationToRoute } from '@/lib/routes';

interface RouteGuardProps {
  children: ReactNode;
  /** Which profile destinations are allowed to view this route */
  allow: RouteDestination[];
}

/**
 * RouteGuard checks the user's profile-computed destination against
 * a list of allowed destinations. If the user's destination is not
 * in the allow list, they are redirected to their correct destination.
 *
 * Usage:
 *   <AuthGuard>
 *     <RouteGuard allow={['/vault', '/dashboard']}>
 *       <DashboardPage />
 *     </RouteGuard>
 *   </AuthGuard>
 */
export function RouteGuard({ children, allow }: Readonly<RouteGuardProps>) {
  const { loading, destination } = useProfile();

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!allow.includes(destination)) {
    return <Navigate to={destinationToRoute(destination)} replace />;
  }

  return <>{children}</>;
}

/**
 * Hook to get the current destination for navigation
 */
export function useRouteDestination(): {
  destination: RouteDestination;
  loading: boolean;
} {
  const { destination, loading } = useProfile();
  return { destination, loading };
}

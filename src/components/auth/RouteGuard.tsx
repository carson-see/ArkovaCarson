/**
 * Route Guard Component
 *
 * Enforces routing based on authentication and profile state:
 * - unauth -> /auth
 * - role NULL -> /onboarding/role
 * - INDIVIDUAL -> /vault
 * - ORG_ADMIN incomplete -> /onboarding/org
 * - ORG_ADMIN complete -> /dashboard
 * - requires_manual_review -> /review-pending
 */

import { ReactNode } from 'react';
import { useProfile, RouteDestination } from '@/hooks/useProfile';
import { Loader2 } from 'lucide-react';

interface RouteGuardProps {
  children: ReactNode;
  /** The route this guard is protecting */
  route: RouteDestination;
  /** Fallback component when user should not access this route */
  fallback?: ReactNode;
}

/**
 * RouteGuard ensures users can only access routes appropriate for their state.
 *
 * Usage:
 * <RouteGuard route="/vault">
 *   <VaultPage />
 * </RouteGuard>
 */
export function RouteGuard({ children, route, fallback }: RouteGuardProps) {
  const { loading, destination } = useProfile();

  // Show loading state
  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // Check if user should be on this route
  if (destination !== route) {
    // If a fallback is provided, show it
    if (fallback) {
      return <>{fallback}</>;
    }

    // Otherwise show redirect message
    return (
      <div className="flex flex-col items-center justify-center min-h-screen gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">Redirecting...</p>
      </div>
    );
  }

  // User is authorized for this route
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

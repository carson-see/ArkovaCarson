/**
 * Onboarding Role Selection Page
 *
 * Uses useOnboarding hook for atomic role setting via RPC.
 * After role is set, refreshProfile recomputes destination and RouteGuard redirects.
 *
 * @see CRIT-4 — replaces DashboardPage placeholder
 * @see MVP-08 — progress stepper
 */

import { AuthLayout } from '@/components/layout/AuthLayout';
import { RoleSelector } from '@/components/onboarding/RoleSelector';
import { OnboardingStepper } from '@/components/onboarding/OnboardingStepper';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { useProfile } from '@/hooks/useProfile';
import { useOnboarding } from '@/hooks/useOnboarding';
import { ONBOARDING_STEPS } from '@/lib/copy';

export function OnboardingRolePage() {
  const { refreshProfile } = useProfile();
  const { loading, error, setRole } = useOnboarding();

  // Log raw error for debugging, show sanitized message to user
  if (error) console.error('[OnboardingRolePage] Onboarding error:', error);

  const handleRoleSelect = async (role: 'INDIVIDUAL' | 'ORG_ADMIN') => {
    const result = await setRole(role);
    if (result) {
      await refreshProfile();
      // RouteGuard will redirect based on new destination
    }
  };

  return (
    <AuthLayout title="Welcome to Arkova" description="Choose how you'll use the platform">
      <div className="mb-8">
        <OnboardingStepper steps={ONBOARDING_STEPS} currentStep={0} />
      </div>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>Something went wrong during onboarding. Please try again.</AlertDescription>
        </Alert>
      )}
      <RoleSelector onSelect={handleRoleSelect} loading={loading} />
    </AuthLayout>
  );
}

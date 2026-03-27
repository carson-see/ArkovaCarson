/**
 * Organization Onboarding Page
 *
 * Uses useOnboarding hook for atomic org creation via RPC.
 * OrgOnboardingForm has its own Card layout — no AuthLayout wrapper
 * to avoid double-Card nesting.
 *
 * @see CRIT-4 — replaces DashboardPage placeholder
 * @see MVP-08 — progress stepper
 */

import { Shield } from 'lucide-react';
import { OrgOnboardingForm } from '@/components/onboarding/OrgOnboardingForm';
import { OnboardingStepper } from '@/components/onboarding/OnboardingStepper';
import { useProfile } from '@/hooks/useProfile';
import { useOnboarding } from '@/hooks/useOnboarding';
import { ONBOARDING_STEPS } from '@/lib/copy';

export function OnboardingOrgPage() {
  const { refreshProfile } = useProfile();
  const { loading, error, createOrg } = useOnboarding();

  const handleSubmit = async (data: {
    legalName: string;
    displayName: string;
    domain: string | null;
    einTaxId: string | null;
  }) => {
    const result = await createOrg(data);
    if (result) {
      await refreshProfile();
      // RouteGuard will redirect to dashboard
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg space-y-8">
        {/* Branding */}
        <div className="flex flex-col items-center text-center">
          <div className="flex items-center justify-center h-14 w-14 rounded-xl bg-primary/10 mb-4">
            <Shield className="h-8 w-8 text-primary" />
          </div>
        </div>

        {/* Progress stepper — step 2 (org setup) */}
        <OnboardingStepper steps={ONBOARDING_STEPS} currentStep={1} />

        <OrgOnboardingForm
          onSubmit={handleSubmit}
          loading={loading}
          error={error}
        />
      </div>
    </div>
  );
}

/**
 * Onboarding Role Selection Page
 *
 * Uses useOnboarding hook for atomic role setting via RPC.
 * After role is set, refreshProfile recomputes destination and RouteGuard redirects.
 *
 * Flow:
 *   0. Platform disclaimer acceptance (SCRUM-362)
 *   1. Role selection (Individual vs Organization)
 *   2. Org match prompt (if email domain matches an existing org)
 *   3. Org membership question (for Individual — BUG-11)
 *   4. Plan selection (for Individual — BUG-1 fix)
 *
 * Domain auto-association: If the user's email domain matches an existing org,
 * we show a prompt to join that org instead of creating a new one.
 *
 * @see CRIT-4 — replaces DashboardPage placeholder
 * @see MVP-08 — progress stepper
 */

import { useState, useEffect } from 'react';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { RoleSelector } from '@/components/onboarding/RoleSelector';
import { PlanSelector } from '@/components/onboarding/PlanSelector';
import { OrgMembershipQuestion } from '@/components/onboarding/OrgMembershipQuestion';
import { OnboardingStepper } from '@/components/onboarding/OnboardingStepper';
import { DisclaimerStep } from '@/components/onboarding/DisclaimerStep';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, Building2, Loader2, ArrowRight } from 'lucide-react';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useAuth';
import { useOnboarding } from '@/hooks/useOnboarding';
import { supabase } from '@/lib/supabase';
import { ONBOARDING_STEPS, ONBOARDING_LABELS, DISCLAIMER_LABELS } from '@/lib/copy';
import { getIndividualPlan, type IndividualOnboardingPlanId } from '@/lib/onboardingPlans';
import { workerPostForUrl } from '@/lib/workerClient';

export function OnboardingRolePage() {
  const { user } = useAuth();
  const { profile, refreshProfile, updateProfile, updating } = useProfile();
  const { loading, error, setRole, lookupOrgByEmail, joinOrgByDomain, clearError } = useOnboarding();

  // SCRUM-362: Disclaimer acceptance as first onboarding step
  // Derived from profile + local override (user can accept during this session)
  const [localDisclaimerAccepted, setLocalDisclaimerAccepted] = useState(false);
  const disclaimerAccepted = !!profile?.disclaimer_accepted_at || localDisclaimerAccepted;
  const setDisclaimerAccepted = setLocalDisclaimerAccepted;

  const [orgMatch, setOrgMatch] = useState<{
    found: boolean;
    org_id?: string;
    org_name?: string;
    domain?: string;
  } | null>(null);
  const [showOrgMatch, setShowOrgMatch] = useState(false);
  const [pendingRole, setPendingRole] = useState<'INDIVIDUAL' | 'ORG_ADMIN' | null>(null);
  // BUG-1: Plan selection step for Individual users
  const [showPlanSelector, setShowPlanSelector] = useState(false);
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  // BUG-11: Org membership question for Individual users
  const [showOrgMembership, setShowOrgMembership] = useState(false);

  // Check for domain-matched org on mount
  useEffect(() => {
    if (user?.email) {
      lookupOrgByEmail(user.email).then(match => {
        if (match?.found) {
          setOrgMatch(match);
        }
      });
    }
  }, [user?.email, lookupOrgByEmail]);

  // Log raw error for debugging, show sanitized message to user
  useEffect(() => {
    if (error) console.error('[OnboardingRolePage] Onboarding error:', error);
  }, [error]);

  const handleRoleSelect = async (role: 'INDIVIDUAL' | 'ORG_ADMIN') => {
    clearError();

    // If org match exists and user hasn't declined yet, show the prompt
    if (orgMatch?.found && orgMatch.org_id) {
      setPendingRole(role);
      setShowOrgMatch(true);
      return;
    }

    // BUG-11: For INDIVIDUAL users, ask about org membership first
    if (role === 'INDIVIDUAL') {
      setPendingRole(role);
      setShowOrgMembership(true);
      return;
    }

    const result = await setRole(role);
    if (result) {
      await refreshProfile();
    }
  };

  // BUG-1 + SCRUM-527: Handle individual plan selection. Free tier persists
  // immediately; paid verified tiers are activated by Stripe after checkout.
  const handlePlanSelect = async (planId: IndividualOnboardingPlanId) => {
    if (!pendingRole) return;
    setPlanLoading(true);
    setPlanError(null);

    try {
      const selectedPlan = getIndividualPlan(planId);

      if (!selectedPlan.checkoutPlanId) {
        // Free plan can be persisted immediately. Paid tiers are activated by
        // the Stripe webhook after checkout succeeds.
        const { error: planError } = await (supabase.rpc as CallableFunction)(
          'set_onboarding_plan', { p_tier: selectedPlan.profileTier },
        );

        if (planError) throw planError;
      }

      const roleResult = await setRole(pendingRole);
      if (!roleResult) throw new Error('Failed to set role');

      if (selectedPlan.checkoutPlanId) {
        const checkoutUrl = await workerPostForUrl('/api/checkout/session', {
          planId: selectedPlan.checkoutPlanId,
        });
        window.location.assign(checkoutUrl);
        return;
      }

      await refreshProfile();
    } catch (err) {
      console.error('[OnboardingRolePage] Plan selection failed:', err);
      setPlanError(
        err instanceof Error
          ? err.message
          : 'We could not finish plan setup. Please try again.',
      );
    } finally {
      setPlanLoading(false);
    }
  };

  const handleJoinOrg = async () => {
    if (!orgMatch?.org_id) return;
    const result = await joinOrgByDomain(orgMatch.org_id);
    if (result) {
      await refreshProfile();
    }
  };

  const handleDeclineOrg = async () => {
    // Clear the match so user won't be prompted again
    setOrgMatch(null);
    setShowOrgMatch(false);

    // Proceed with the role they originally selected
    if (pendingRole) {
      // BUG-11: If declining org and role is INDIVIDUAL, show org membership question
      if (pendingRole === 'INDIVIDUAL') {
        setShowOrgMembership(true);
        return;
      }

      const result = await setRole(pendingRole);
      if (result) {
        await refreshProfile();
      }
    }
  };

  const handleOrgMembershipSkip = () => {
    setShowOrgMembership(false);
    setShowPlanSelector(true);
  };

  const handleOrgMembershipJoin = async (orgId: string) => {
    const result = await joinOrgByDomain(orgId);
    if (result) {
      await refreshProfile();
    }
  };

  // SCRUM-362: Accept platform disclaimer during onboarding
  const handleAcceptDisclaimer = async () => {
    const success = await updateProfile({ disclaimer_accepted_at: new Date().toISOString() });
    if (success) {
      setDisclaimerAccepted(true);
    }
  };

  // SCRUM-362: Show disclaimer as first onboarding step
  if (!disclaimerAccepted) {
    return (
      <AuthLayout title={ONBOARDING_LABELS.WELCOME_TITLE} description={DISCLAIMER_LABELS.description}>
        <div className="mb-8">
          <OnboardingStepper steps={ONBOARDING_STEPS} currentStep={0} />
        </div>
        <DisclaimerStep onAccept={handleAcceptDisclaimer} loading={updating} />
      </AuthLayout>
    );
  }

  // BUG-11: Show org membership question for Individual users
  if (showOrgMembership && !showPlanSelector) {
    return (
      <AuthLayout title={ONBOARDING_LABELS.WELCOME_TITLE} description={ONBOARDING_LABELS.ORG_MEMBERSHIP_DESC}>
        <div className="mb-8">
          <OnboardingStepper steps={ONBOARDING_STEPS} currentStep={1} />
        </div>
        {(error || planError) && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{planError ?? ONBOARDING_LABELS.ERROR_GENERIC}</AlertDescription>
          </Alert>
        )}
        <OrgMembershipQuestion
          onSkip={handleOrgMembershipSkip}
          onJoinOrg={handleOrgMembershipJoin}
          loading={loading}
        />
      </AuthLayout>
    );
  }

  // BUG-1: Show plan selector for Individual users
  if (showPlanSelector) {
    return (
      <AuthLayout title={ONBOARDING_LABELS.WELCOME_TITLE} description={ONBOARDING_LABELS.CHOOSE_PLAN_DESC} wide>
        <div className="mb-8">
          <OnboardingStepper steps={ONBOARDING_STEPS} currentStep={2} />
        </div>
        {(error || planError) && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{planError ?? ONBOARDING_LABELS.ERROR_GENERIC}</AlertDescription>
          </Alert>
        )}
        <PlanSelector onSelect={handlePlanSelect} loading={loading || planLoading} />
      </AuthLayout>
    );
  }

  // Show org match prompt
  if (showOrgMatch && orgMatch?.found) {
    return (
      <AuthLayout title={ONBOARDING_LABELS.WELCOME_TITLE} description={ONBOARDING_LABELS.FOUND_ORG_DESC}>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{ONBOARDING_LABELS.ERROR_GENERIC}</AlertDescription>
          </Alert>
        )}
        <Card className="max-w-lg mx-auto">
          <CardHeader>
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 mb-4">
              <Building2 className="h-6 w-6 text-primary" />
            </div>
            <CardTitle>Join {orgMatch.org_name}?</CardTitle>
            <CardDescription>
              Your email address matches the domain <strong>{orgMatch.domain}</strong>,
              which is registered to <strong>{orgMatch.org_name}</strong>.
              Would you like to join this organization?
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              className="w-full"
              size="lg"
              onClick={handleJoinOrg}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Joining...
                </>
              ) : (
                <>
                  Join {orgMatch.org_name}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
            <Button
              variant="outline"
              className="w-full"
              size="lg"
              onClick={handleDeclineOrg}
              disabled={loading}
            >
              No, continue independently
            </Button>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={ONBOARDING_LABELS.WELCOME_TITLE} description={ONBOARDING_LABELS.CHOOSE_ROLE_DESC}>
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{ONBOARDING_LABELS.ERROR_ONBOARDING}</AlertDescription>
        </Alert>
      )}
      <RoleSelector onSelect={handleRoleSelect} loading={loading} />
    </AuthLayout>
  );
}

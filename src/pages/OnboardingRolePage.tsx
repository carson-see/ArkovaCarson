/**
 * Onboarding Role Selection Page
 *
 * Uses useOnboarding hook for atomic role setting via RPC.
 * After role is set, refreshProfile recomputes destination and RouteGuard redirects.
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
import { OnboardingStepper } from '@/components/onboarding/OnboardingStepper';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertCircle, Building2, Loader2, ArrowRight } from 'lucide-react';
import { useProfile } from '@/hooks/useProfile';
import { useAuth } from '@/hooks/useAuth';
import { useOnboarding } from '@/hooks/useOnboarding';
import { ONBOARDING_STEPS } from '@/lib/copy';

export function OnboardingRolePage() {
  const { user } = useAuth();
  const { refreshProfile } = useProfile();
  const { loading, error, setRole, lookupOrgByEmail, joinOrgByDomain } = useOnboarding();

  const [orgMatch, setOrgMatch] = useState<{
    found: boolean;
    org_id?: string;
    org_name?: string;
    domain?: string;
  } | null>(null);
  const [showOrgMatch, setShowOrgMatch] = useState(false);
  const [pendingRole, setPendingRole] = useState<'INDIVIDUAL' | 'ORG_ADMIN' | null>(null);

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
  if (error) console.error('[OnboardingRolePage] Onboarding error:', error);

  const handleRoleSelect = async (role: 'INDIVIDUAL' | 'ORG_ADMIN') => {
    // If org match exists and user hasn't declined yet, show the prompt
    if (orgMatch?.found && orgMatch.org_id) {
      setPendingRole(role);
      setShowOrgMatch(true);
      return;
    }

    const result = await setRole(role);
    if (result) {
      await refreshProfile();
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
      const result = await setRole(pendingRole);
      if (result) {
        await refreshProfile();
      }
    }
  };

  // Show org match prompt
  if (showOrgMatch && orgMatch?.found) {
    return (
      <AuthLayout title="Welcome to Arkova" description="We found your organization">
        <div className="mb-8">
          <OnboardingStepper steps={ONBOARDING_STEPS} currentStep={0} />
        </div>
        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>Something went wrong. Please try again.</AlertDescription>
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

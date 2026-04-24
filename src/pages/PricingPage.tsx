/**
 * Pricing Page
 *
 * Displays available plans and allows users to subscribe via Stripe Checkout.
 * Uses useBilling hook to call the worker's POST /api/checkout/session endpoint.
 *
 * @see P7-TS-02
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
// useNavigate still needed for settings back button
import { CreditCard, Loader2, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useBilling } from '@/hooks/useBilling';
import { AppShell } from '@/components/layout';
import { PricingCard } from '@/components/billing/PricingCard';
import { BillingOverview } from '@/components/billing/BillingOverview';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ROUTES } from '@/lib/routes';
import { BILLING_LABELS } from '@/lib/copy';
import { UsageWidget } from '@/components/billing/UsageWidget';
import type { BillingInfo } from '@/components/billing/BillingOverview';

const BILLING_PLAN_ORDER = [
  'free',
  'individual_verified_monthly',
  'individual_verified_annual',
  'small_business',
  'medium_business',
  'enterprise',
];

export function PricingPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const {
    subscription,
    plan: currentPlan,
    plans,
    loading: billingLoading,
    error: billingError,
    startCheckout,
    openBillingPortal,
  } = useBilling();

  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  const hasActiveSubscription = subscription &&
    (subscription.status === 'active' || subscription.status === 'trialing');

  // Any non-canceled subscription should go through billing portal, not create a new checkout
  const hasExistingSubscription = subscription &&
    subscription.status !== 'canceled';

  const handleSelectPlan = async (planId: string) => {
    const selectedPlan = plans.find((plan) => plan.id === planId);
    if (selectedPlan?.billing_period === 'custom') return;

    setCheckoutLoading(planId);
    try {
      if (hasExistingSubscription) {
        // Existing subscriber — open Stripe billing portal for plan change/downgrade/cancel.
        // Stripe handles proration, confirmation, and effective dates.
        const url = await openBillingPortal();
        if (url) {
          window.location.href = url;
        }
      } else {
        // New subscriber — create checkout session
        const url = await startCheckout(planId);
        if (url) {
          window.location.href = url;
        }
      }
    } finally {
      setCheckoutLoading(null);
    }
  };

  const handleManageBilling = async () => {
    const url = await openBillingPortal();
    if (url) {
      window.location.href = url;
    }
  };

  const handleSignOut = async () => {
    await signOut();
  };

  // Build BillingInfo for BillingOverview when user has a subscription
  const billingInfo: BillingInfo | null = hasActiveSubscription && currentPlan ? {
    plan: {
      name: currentPlan.name,
      recordsIncluded: currentPlan.records_per_month ?? 0,
    },
    usage: {
      recordsUsed: 0, // Would come from profile.anchor_count_this_month
      recordsLimit: currentPlan.records_per_month ?? 0,
    },
    billing: {
      status: subscription.status as 'active' | 'trialing' | 'past_due' | 'canceled',
      currentPeriodEnd: subscription.current_period_end ?? undefined,
    },
    status: subscription.status as 'active' | 'trialing' | 'past_due' | 'canceled',
  } : null;

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Button variant="ghost" size="sm" onClick={() => navigate(ROUTES.SETTINGS)}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Settings
          </Button>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <CreditCard className="h-6 w-6 text-primary" />
          {BILLING_LABELS.PAGE_TITLE}
        </h1>
        <p className="text-muted-foreground mt-1">
          {BILLING_LABELS.PAGE_DESCRIPTION}
        </p>
      </div>

      {billingError && (
        <Alert variant="destructive" className="mb-6">
          <AlertDescription>{billingError}</AlertDescription>
        </Alert>
      )}

      {/* Usage tracking (UF-06) */}
      {hasActiveSubscription && (
        <div className="mb-6">
          <UsageWidget compact />
        </div>
      )}

      {/* Show current subscription overview if active */}
      {hasActiveSubscription && billingInfo && (
        <div className="mb-8">
          <BillingOverview
            billingInfo={billingInfo}
            loading={billingLoading}
            onManageBilling={handleManageBilling}
            onUpgrade={() => {/* Already on pricing page */}}
          />
        </div>
      )}

      {/* Plan selection grid */}
      <div className="mb-4">
        <h2 className="text-lg font-medium">
          {hasActiveSubscription ? BILLING_LABELS.CHANGE_PLAN : BILLING_LABELS.CHOOSE_PLAN}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {BILLING_LABELS.PLAN_DESCRIPTION}
        </p>
      </div>

      {billingLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 max-w-5xl">
          {plans
            .filter(p => BILLING_PLAN_ORDER.includes(p.id))
            .sort((a, b) => BILLING_PLAN_ORDER.indexOf(a.id) - BILLING_PLAN_ORDER.indexOf(b.id))
            .map(dbPlan => (
              <PricingCard
                key={dbPlan.id}
                plan={{
                  id: dbPlan.id,
                  name: dbPlan.name,
                  description: getPlanDescription(dbPlan.id),
                  price: dbPlan.billing_period === 'custom' ? null : dbPlan.price_cents / 100,
                  priceLabel: dbPlan.billing_period === 'custom'
                    ? 'Custom'
                    : dbPlan.price_cents !== null
                    ? `$${(dbPlan.price_cents / 100).toFixed(0)}`
                    : 'Custom',
                  period: dbPlan.billing_period as 'month' | 'year' | 'custom',
                  features: getPlanFeatures(dbPlan.id),
                  recordsIncluded: dbPlan.billing_period === 'custom'
                    ? 'unlimited' as const
                    : dbPlan.records_per_month ?? 0,
                  recommended: dbPlan.id === 'individual_verified_monthly',
                  current: currentPlan?.id === dbPlan.id,
                }}
                onSelect={handleSelectPlan}
                loading={checkoutLoading === dbPlan.id}
              />
            ))}
        </div>
      )}
    </AppShell>
  );
}

/** Plan descriptions mapped from plan id */
function getPlanDescription(planId: string): string {
  const descriptions: Record<string, string> = {
    free: 'For occasional personal anchoring',
    individual_verified_monthly: 'For a trusted personal profile',
    individual_verified_annual: 'Same verified tier, paid yearly',
    small_business: 'For verified teams up to 25 self-serve seats',
    medium_business: 'For 25-250 seats and multiple departments',
    enterprise: 'For larger organizations and custom structures',
  };
  return descriptions[planId] ?? 'Secure your records';
}

/** Plan features mapped from plan id */
function getPlanFeatures(planId: string): string[] {
  const features: Record<string, string[]> = {
    free: ['3 document anchors per month', 'Public verification links', 'No verified checkmark'],
    individual_verified_monthly: [
      '10 document anchors per month',
      'Stripe Identity verification',
      'Verified checkmark next to your name',
    ],
    individual_verified_annual: [
      '10 document anchors per month',
      '$10 per month when paid annually',
      'Verified checkmark next to your name',
    ],
    small_business: [
      '1 admin and 5 included seats',
      '250 anchors per month',
      '$100 per additional seat',
      'Compliance intelligence access',
    ],
    medium_business: [
      '25-250 seats',
      '3 included sub-organizations',
      'Sub-organization admins and allocation rules',
      'Compliance intelligence recommendations',
    ],
    enterprise: [
      'Custom seat and anchor allocation',
      'Expanded sub-organization limits',
      'Compliance suite access',
      'Dedicated onboarding and support',
    ],
  };
  return features[planId] ?? ['Secure anchoring'];
}

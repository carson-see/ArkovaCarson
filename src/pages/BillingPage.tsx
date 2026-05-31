/**
 * Billing Page (Design Audit #3)
 *
 * Dedicated billing page mounting BillingOverview with plan comparison.
 * Resolves UX-3: BillingOverview exists but had no dedicated page.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { BillingOverview, type BillingInfo } from '@/components/billing/BillingOverview';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BILLING_PAGE_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';
import { WORKER_URL } from '@/lib/workerClient';
import { supabase } from '@/lib/supabase';
import { resolveSafeWorkerEndpoint } from '@/lib/workerUrlSafety';

/**
 * Shape contract for the worker `/api/billing/status` response.
 *
 * SCRUM-2008: billing data is shown as real ONLY when it comes from a confirmed
 * source. A 200 response with a malformed/empty/error-envelope body is NOT a
 * confirmed billing payload — validating it here forces such responses into the
 * explicit "Data unavailable" state instead of silently rendering a placeholder
 * (the old "Beta"/empty fallback that misled users into trusting fabricated data).
 *
 * Mirrors the `BillingInfo` interface in BillingOverview. Unknown extra keys are
 * tolerated (additive worker fields) so this stays compatible with §1.8.
 */
const billingStatusSchema = z.object({
  plan: z.object({
    name: z.string().min(1),
    price: z.number().optional(),
    period: z.enum(['month', 'year']).optional(),
    recordsIncluded: z.union([z.number(), z.literal('unlimited')]),
  }),
  usage: z.object({
    recordsUsed: z.number(),
    recordsLimit: z.number().nullable(),
    percentUsed: z.number().optional(),
  }),
  billing: z.object({
    nextBillingDate: z.string().optional(),
    paymentMethod: z.string().optional(),
    lastFourDigits: z.string().optional(),
    status: z.enum(['active', 'trialing', 'past_due', 'canceled']).optional(),
    currentPeriodEnd: z.string().optional(),
  }),
  status: z.enum(['active', 'trialing', 'past_due', 'canceled']),
});

export function BillingPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const latestRequestIdRef = useRef(0);

  const fetchBillingInfo = useCallback(async () => {
    const requestId = latestRequestIdRef.current + 1;
    latestRequestIdRef.current = requestId;
    const isLatestRequest = () => latestRequestIdRef.current === requestId;

    setLoading(true);
    setLoadError(null);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const billingStatusEndpoint = resolveSafeWorkerEndpoint(WORKER_URL, '/api/billing/status');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        throw new Error('missing_session');
      }

      const controller = new AbortController();
      timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(billingStatusEndpoint.toString(), {
        headers: { Authorization: `Bearer ${session.access_token}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`billing_status_${response.status}`);
      }

      // Only treat the payload as real billing data when it parses against the
      // confirmed-source contract. A malformed/empty/error-envelope 200 body
      // falls through to the explicit unavailable state (SCRUM-2008) — never a
      // silent placeholder plan display.
      const parsed = billingStatusSchema.parse(await response.json());
      const data: BillingInfo = parsed;
      if (isLatestRequest()) {
        setBillingInfo(data);
      }
    } catch {
      if (isLatestRequest()) {
        setBillingInfo(null);
        setLoadError(BILLING_PAGE_LABELS.DATA_UNAVAILABLE_TITLE);
      }
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (isLatestRequest()) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch; setState is post-await
    fetchBillingInfo();
  }, [fetchBillingInfo]);

  const handleSignOut = async () => {
    await signOut();
    navigate(ROUTES.LOGIN);
  };

  const handleManageBilling = () => {
    // Opens Stripe customer portal when available
    navigate(ROUTES.BILLING);
  };

  const handleUpgrade = () => {
    navigate(ROUTES.BILLING);
  };

  return (
    <AppShell user={user} profile={profile} profileLoading={profileLoading} onSignOut={handleSignOut}>
      <div className="mb-8">
        <h1 className="text-[24px] font-bold tracking-tight">
          {BILLING_PAGE_LABELS.PAGE_TITLE}
        </h1>
        <p className="text-[13px] text-muted-foreground mt-1">
          {BILLING_PAGE_LABELS.PAGE_SUBTITLE}
        </p>
      </div>

      {loadError && !loading ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm font-medium">{loadError}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {BILLING_PAGE_LABELS.DATA_UNAVAILABLE_DESC}
            </p>
            <Button type="button" variant="outline" size="sm" className="mt-4" onClick={fetchBillingInfo}>
              {BILLING_PAGE_LABELS.RETRY}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <BillingOverview
          billingInfo={billingInfo}
          loading={loading}
          onManageBilling={handleManageBilling}
          onUpgrade={handleUpgrade}
        />
      )}
    </AppShell>
  );
}

/**
 * Billing Page (Design Audit #3)
 *
 * Dedicated billing page mounting BillingOverview with plan comparison.
 * Resolves UX-3: BillingOverview exists but had no dedicated page.
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { BillingOverview, type BillingInfo } from '@/components/billing/BillingOverview';
import { BILLING_PAGE_LABELS } from '@/lib/copy';
import { ROUTES } from '@/lib/routes';
import { WORKER_URL } from '@/lib/workerClient';
import { supabase } from '@/lib/supabase';

export function BillingPage() {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const [billingInfo, setBillingInfo] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchBillingInfo = useCallback(async () => {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) return;

      const workerUrl = import.meta.env.VITE_WORKER_URL ?? WORKER_URL;
      const response = await fetch(`${workerUrl}/api/billing/status`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });

      if (response.ok) {
        const data = await response.json();
        setBillingInfo(data);
      } else {
        // Fallback: show beta plan info
        setBillingInfo({
          plan: { name: 'Beta', recordsIncluded: 'unlimited' },
          usage: { recordsUsed: 0, recordsLimit: null },
          billing: { status: 'active' },
          status: 'active',
        });
      }
    } catch {
      // Fallback for beta
      setBillingInfo({
        plan: { name: 'Beta', recordsIncluded: 'unlimited' },
        usage: { recordsUsed: 0, recordsLimit: null },
        billing: { status: 'active' },
        status: 'active',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
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
        <h1 className="text-2xl font-semibold tracking-tight">
          {BILLING_PAGE_LABELS.PAGE_TITLE}
        </h1>
        <p className="text-muted-foreground mt-1">
          {BILLING_PAGE_LABELS.PAGE_SUBTITLE}
        </p>
      </div>

      <BillingOverview
        billingInfo={billingInfo}
        loading={loading}
        onManageBilling={handleManageBilling}
        onUpgrade={handleUpgrade}
      />
    </AppShell>
  );
}

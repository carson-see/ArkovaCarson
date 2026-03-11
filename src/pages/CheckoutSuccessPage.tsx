/**
 * Checkout Success Page
 *
 * Landing page after successful Stripe Checkout.
 * Shows confirmation and links to the dashboard.
 *
 * @see P7-TS-02
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { CheckCircle2, ArrowRight, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useBilling } from '@/hooks/useBilling';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ROUTES } from '@/lib/routes';
import { BILLING_LABELS } from '@/lib/copy';

export function CheckoutSuccessPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { profile, loading: profileLoading } = useProfile();
  const { plan, loading: billingLoading, refresh } = useBilling();

  const sessionId = searchParams.get('session_id');
  const [refreshed, setRefreshed] = useState(false);

  // Refresh billing data to pick up the new subscription from webhook
  useEffect(() => {
    if (!refreshed && sessionId) {
      // Small delay to let the webhook process
      const timer = setTimeout(async () => {
        await refresh();
        setRefreshed(true);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [sessionId, refreshed, refresh]);

  const handleSignOut = async () => {
    navigate(ROUTES.LOGIN);
  };

  return (
    <AppShell
      user={user}
      profile={profile}
      profileLoading={profileLoading}
      onSignOut={handleSignOut}
    >
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <div className="flex justify-center mb-4">
              <CheckCircle2 className="h-16 w-16 text-green-500" />
            </div>
            <CardTitle className="text-2xl">
              {BILLING_LABELS.CHECKOUT_SUCCESS_TITLE}
            </CardTitle>
            <CardDescription className="text-base">
              {BILLING_LABELS.CHECKOUT_SUCCESS_DESC}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {billingLoading ? (
              <div className="flex items-center justify-center gap-2 text-muted-foreground py-4">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>{BILLING_LABELS.LOADING_SUBSCRIPTION}</span>
              </div>
            ) : plan ? (
              <div className="rounded-lg border bg-muted/50 p-4 text-center">
                <p className="text-sm text-muted-foreground">{BILLING_LABELS.YOUR_PLAN}</p>
                <p className="text-lg font-semibold mt-1">{plan.name}</p>
                {plan.records_per_month > 0 && (
                  <p className="text-sm text-muted-foreground mt-1">
                    {plan.records_per_month} records per month
                  </p>
                )}
              </div>
            ) : null}

            <div className="flex flex-col gap-2 pt-2">
              <Button asChild>
                <Link to={ROUTES.DASHBOARD}>
                  {BILLING_LABELS.GO_TO_DASHBOARD}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to={ROUTES.BILLING}>
                  {BILLING_LABELS.VIEW_BILLING}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

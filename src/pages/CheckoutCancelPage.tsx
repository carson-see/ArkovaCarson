/**
 * Checkout Cancel Page
 *
 * Landing page when user cancels Stripe Checkout.
 * Shows a message and links back to pricing.
 *
 * @see P7-TS-02
 */

import { useNavigate, Link } from 'react-router-dom';
import { XCircle, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AppShell } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ROUTES } from '@/lib/routes';
import { BILLING_LABELS } from '@/lib/copy';

export function CheckoutCancelPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { profile, loading: profileLoading } = useProfile();

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
              <XCircle className="h-16 w-16 text-muted-foreground" />
            </div>
            <CardTitle className="text-2xl">
              {BILLING_LABELS.CHECKOUT_CANCEL_TITLE}
            </CardTitle>
            <CardDescription className="text-base">
              {BILLING_LABELS.CHECKOUT_CANCEL_DESC}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-2 pt-2">
              <Button asChild>
                <Link to={ROUTES.BILLING}>
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {BILLING_LABELS.BACK_TO_PRICING}
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to={ROUTES.DASHBOARD}>
                  {BILLING_LABELS.GO_TO_DASHBOARD}
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

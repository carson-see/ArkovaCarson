/**
 * Identity Verification Card (IDT WS1)
 *
 * Allows users to verify their identity via Stripe Identity.
 * In development, the "Get Verified" button auto-verifies via dev bypass.
 * Shows a checkmark when verified (like X/Twitter).
 *
 * @see IDT-03
 */

import { useState, useCallback } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Loader2, CheckCircle, AlertCircle, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { WORKER_URL } from '@/lib/workerClient';
import { supabase } from '@/lib/supabase';

const isDev = import.meta.env.DEV;

interface IdentityVerificationProps {
  /** Current verification status from profile */
  status: 'unstarted' | 'pending' | 'verified' | 'requires_input' | 'canceled';
  /** When the identity was verified */
  verifiedAt: string | null;
  /** Callback after verification status changes */
  onVerified?: () => void;
}

const STATUS_CONFIG = {
  unstarted: {
    icon: ArkovaIcon,
    label: 'Not Verified',
    variant: 'secondary' as const,
    description: 'Verify your identity to build trust with your credentials and attestations.',
    className: 'text-muted-foreground',
  },
  pending: {
    icon: Loader2,
    label: 'Verification Pending',
    variant: 'outline' as const,
    description: 'Your identity verification is being processed. This usually takes a few minutes.',
    className: 'text-amber-500 animate-spin',
  },
  verified: {
    icon: CheckCircle,
    label: 'Verified',
    variant: 'default' as const,
    description: 'Your identity has been verified. This is shown alongside your credentials.',
    className: 'text-emerald-500',
  },
  requires_input: {
    icon: AlertCircle,
    label: 'Action Required',
    variant: 'destructive' as const,
    description: 'Additional information is needed to complete your verification. Please try again.',
    className: 'text-amber-500',
  },
  canceled: {
    icon: XCircle,
    label: 'Canceled',
    variant: 'secondary' as const,
    description: 'Your verification was canceled. You can start a new verification at any time.',
    className: 'text-muted-foreground',
  },
} as const;

export function IdentityVerification({ status, verifiedAt, onVerified }: IdentityVerificationProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.unstarted;
  const StatusIcon = config.icon;

  const canStartVerification = status === 'unstarted' || status === 'requires_input' || status === 'canceled';

  const handleVerify = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Please sign in to verify your identity');
        return;
      }

      // In dev mode, use the dev-verify bypass (no Stripe needed)
      if (isDev) {
        const response = await fetch(`${WORKER_URL}/api/v1/identity/dev-verify`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
        });

        if (!response.ok) {
          const data = await response.json() as { error?: string };
          setError(data.error ?? 'Verification failed');
          return;
        }

        onVerified?.();
        return;
      }

      // Production: use Stripe Identity
      const response = await fetch(`${WORKER_URL}/api/v1/identity/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (!response.ok) {
        const data = await response.json() as { error?: string };
        setError(data.error ?? 'Failed to start verification');
        return;
      }

      const data = await response.json() as { clientSecret: string };

      // Load Stripe Identity modal
      const stripeJs = await import('@stripe/stripe-js');
      const stripe = await stripeJs.loadStripe(
        import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? '',
      );

      if (!stripe) {
        setError('Failed to load payment provider');
        return;
      }

      const result = await stripe.verifyIdentity(data.clientSecret);
      if (result.error) {
        setError(result.error.message ?? 'Verification failed');
      } else {
        onVerified?.();
      }
    } catch {
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  }, [onVerified]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArkovaIcon className="h-5 w-5" />
          Identity Verification
          {status === 'verified' && (
            <CheckCircle className="h-5 w-5 text-emerald-500" />
          )}
        </CardTitle>
        <CardDescription>
          Verify your identity to increase trust in your credentials
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <StatusIcon className={`h-5 w-5 ${config.className}`} />
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium">Status</p>
                <Badge variant={config.variant}>{config.label}</Badge>
              </div>
              <p className="text-xs text-muted-foreground max-w-md mt-1">
                {config.description}
              </p>
              {status === 'verified' && verifiedAt && (
                <p className="text-xs text-muted-foreground mt-1">
                  Verified on {new Date(verifiedAt).toLocaleDateString('en-US', { dateStyle: 'medium' })}
                </p>
              )}
            </div>
          </div>

          {canStartVerification && (
            <Button
              onClick={handleVerify}
              disabled={loading}
              size="sm"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {status === 'unstarted' ? 'Get Verified' : 'Retry Verification'}
            </Button>
          )}
        </div>

        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Activate Account Page
 *
 * Route: /activate?token=xxx
 * SCRUM-IDT-TASK4
 *
 * Wires RecoveryPhraseModal to the activate_user RPC.
 * Flow:
 *  1. User arrives via invite email link.
 *  2. Modal prompts them to reveal + save their 12-word recovery phrase.
 *  3. SHA-256 claim key is derived and sent to activate_user RPC.
 *  4. On success, user is redirected to login.
 */

import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Shield, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RecoveryPhraseModal } from '@/components/auth/RecoveryPhraseModal';
import { deriveClaimKeyHash } from '@/lib/recoveryPhrase';
import { supabase } from '@/lib/supabase';

type ActivationState = 'idle' | 'activating' | 'success' | 'error';

export function ActivateAccountPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';

  const [modalOpen, setModalOpen] = useState(false);
  const [activationState, setActivationState] = useState<ActivationState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handlePhraseConfirmed = async (phrase: string[]) => {
    setActivationState('activating');
    setErrorMessage(null);

    try {
      const claimKey = await deriveClaimKeyHash(phrase);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('activate_user', {
        p_token: token,
        p_claim_key: claimKey,
      });

      if (error) {
        throw new Error(error.message ?? 'Activation failed');
      }

      if (!data?.success) {
        throw new Error('Activation did not complete. Please try again.');
      }

      setActivationState('success');
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setActivationState('error');
    }
  };

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center py-10 text-center">
            <XCircle className="h-12 w-12 text-destructive mb-4" />
            <h2 className="text-lg font-semibold mb-2">Invalid Activation Link</h2>
            <p className="text-sm text-muted-foreground">
              This activation link is missing or malformed. Please check your email for the
              correct link.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-br from-slate-50 via-white to-blue-50 p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-8">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
          <Shield className="h-5 w-5 text-primary-foreground" />
        </div>
        <span className="text-xl font-semibold">Arkova</span>
      </div>

      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Activate Your Account</CardTitle>
          <CardDescription>
            Set up your recovery phrase to secure your account before you begin.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {activationState === 'idle' && (
            <>
              <div className="rounded-lg border bg-muted/50 p-4 text-sm text-muted-foreground space-y-2">
                <p>Before activating, you will be shown a <strong>12-word recovery phrase</strong>.</p>
                <p>
                  This phrase is your backup access key. Write it down and keep it safe —
                  it will not be shown again.
                </p>
              </div>
              <Button className="w-full" onClick={() => setModalOpen(true)}>
                Set Up Recovery Phrase
              </Button>
            </>
          )}

          {activationState === 'activating' && (
            <div className="flex flex-col items-center py-6 gap-3">
              <Loader2 className="h-10 w-10 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">Activating your account…</p>
            </div>
          )}

          {activationState === 'success' && (
            <div className="flex flex-col items-center py-6 gap-3 text-center">
              <CheckCircle className="h-10 w-10 text-success" />
              <h3 className="font-semibold text-success">Account Activated!</h3>
              <p className="text-sm text-muted-foreground">
                Your account is ready. Redirecting to sign in…
              </p>
            </div>
          )}

          {activationState === 'error' && (
            <div className="flex flex-col items-center py-4 gap-4 text-center">
              <XCircle className="h-10 w-10 text-destructive" />
              <div>
                <h3 className="font-semibold text-destructive mb-1">Activation Failed</h3>
                <p className="text-sm text-muted-foreground">{errorMessage}</p>
              </div>
              <Button
                variant="outline"
                onClick={() => {
                  setActivationState('idle');
                  setErrorMessage(null);
                }}
              >
                Try Again
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <RecoveryPhraseModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onConfirm={handlePhraseConfirmed}
      />
    </div>
  );
}

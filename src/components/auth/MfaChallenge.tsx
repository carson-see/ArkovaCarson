/**
 * MFA Login Challenge — pre-pentest hardening.
 *
 * Rendered by AuthGuard, in place of protected children, when the current
 * session is aal1 but the user has a verified TOTP factor (see
 * `useMfaAssurance`). Mirrors TwoFactorSetup's enrollment
 * challenge()+verify() sequence, applied here to an EXISTING factor instead
 * of a freshly-enrolled one.
 *
 * LOCKOUT SAFETY: always renders a working "Sign out" affordance. A user who
 * has lost their authenticator device cannot complete this screen — without
 * an escape hatch they would be fully trapped (authenticated enough to not
 * see the login page, not verified enough to reach the app). Signing out at
 * least returns them to a known, working state (the login page) where they
 * can seek account recovery, instead of a dead end.
 */

import { useState, useEffect, useCallback, FormEvent } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Loader2, AlertCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/hooks/useAuth';
import { MFA_CHALLENGE_LABELS } from '@/lib/copy';

interface MfaChallengeProps {
  /** Called once challenge()+verify() succeeds against the loaded factor. */
  onVerified: () => void;
}

export function MfaChallenge({ onVerified }: Readonly<MfaChallengeProps>) {
  const { signOut } = useAuth();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [loadingFactor, setLoadingFactor] = useState(true);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadFactor() {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;

      if (listError || !data) {
        setError(MFA_CHALLENGE_LABELS.LOADING_FACTOR_ERROR);
        setLoadingFactor(false);
        return;
      }

      const verified = data.totp.find((f: { status: string }) => f.status === 'verified');
      if (!verified) {
        // Defensive only: AuthGuard should never render this component
        // unless useMfaAssurance already confirmed a verified factor
        // exists. If the factor was unenrolled in the split second between
        // that check and this one, there is nothing to challenge against —
        // fail OPEN rather than trap the user behind an impossible screen.
        onVerified();
        return;
      }

      setFactorId(verified.id);
      setLoadingFactor(false);
    }

    void loadFactor();
    return () => {
      cancelled = true;
    };
  }, [onVerified]);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!factorId || code.length !== 6) return;

      setBusy(true);
      setError(null);

      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      });

      if (challengeError || !challengeData) {
        setError(challengeError?.message ?? MFA_CHALLENGE_LABELS.GENERIC_ERROR);
        setBusy(false);
        return;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challengeData.id,
        code,
      });

      setBusy(false);

      if (verifyError) {
        setError(verifyError.message || MFA_CHALLENGE_LABELS.GENERIC_ERROR);
        return;
      }

      onVerified();
    },
    [factorId, code, onVerified]
  );

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArkovaIcon className="h-5 w-5" />
            {MFA_CHALLENGE_LABELS.TITLE}
          </CardTitle>
          <CardDescription>{MFA_CHALLENGE_LABELS.DESCRIPTION}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {loadingFactor ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="mfa-challenge-code">{MFA_CHALLENGE_LABELS.CODE_LABEL}</Label>
                <div className="relative">
                  <ShieldCheck className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="mfa-challenge-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    maxLength={6}
                    autoFocus
                    disabled={busy || !factorId}
                    className="pl-10 font-mono text-center text-lg tracking-widest"
                  />
                </div>
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={busy || !factorId || code.length !== 6}
              >
                {busy ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {MFA_CHALLENGE_LABELS.VERIFYING}
                  </>
                ) : (
                  MFA_CHALLENGE_LABELS.SUBMIT
                )}
              </Button>
            </form>
          )}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={() => void signOut()}
          >
            {MFA_CHALLENGE_LABELS.SIGN_OUT}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

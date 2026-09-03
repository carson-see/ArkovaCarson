/**
 * MFA Login Challenge — pre-pentest hardening (SCRUM-3167).
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
 *
 * FAIL-OPEN CONTRACT (CTO ruling A4, restored-and-hardened from PR #1973):
 * this screen distinguishes "the user typed the wrong code" (their fault,
 * stay here and let them retry) from "the platform itself cannot verify
 * codes right now" (not their fault, and trapping them here would be an
 * availability incident, not a security control):
 *
 *   - `listFactors()` erroring, or unexpectedly finding no verified factor
 *     (defensive only — AuthGuard should never render this component
 *     without one), calls `onVerified()` directly. There is nothing to
 *     challenge against, so failing open is strictly safer than showing an
 *     error screen with no way forward.
 *   - `challenge()`/`verify()` returning one of the four WRONG_CODE error
 *     codes (an actual bad/expired code) shows a retryable inline error —
 *     the user's own mistake, and they can just try again.
 *   - Any OTHER `challenge()`/`verify()` error (an unrecognized code, or no
 *     code at all), or a thrown exception / network failure, calls
 *     `onCapabilityUnavailable(code)` instead. AuthGuard treats this as a
 *     platform-availability failure: it renders `children`, emits a Sentry
 *     breadcrumb, and shows a one-shot toast — a broken MFA backend can
 *     never wall out an otherwise-authenticated user (accepted phase-1
 *     trade-off, tracked by SCRUM-3593's future aal2 RLS).
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
  /** Called once challenge()+verify() succeeds against the loaded factor, or when there is nothing to challenge (fail-open). */
  onVerified: () => void;
  /** Called when the MFA platform itself (not the user's code) is the reason verification cannot complete. */
  onCapabilityUnavailable: (code: string) => void;
}

/** Error codes that mean "the user's code was wrong/expired" — every other error is a platform failure. */
const WRONG_CODE_ERROR_CODES = new Set([
  'mfa_verification_failed',
  'mfa_verification_rejected',
  'mfa_challenge_expired',
  'validation_failed',
]);

function isWrongCodeError(error: { code?: string } | null | undefined): boolean {
  return Boolean(error?.code && WRONG_CODE_ERROR_CODES.has(error.code));
}

export function MfaChallenge({ onVerified, onCapabilityUnavailable }: Readonly<MfaChallengeProps>) {
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
        // FAIL OPEN (A4): a platform read failure is not the user's fault,
        // and an error screen with no verified factor to retry against
        // would be an unrecoverable dead end.
        onVerified();
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

      try {
        const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
          factorId,
        });

        if (challengeError || !challengeData) {
          setBusy(false);
          if (isWrongCodeError(challengeError)) {
            setError(challengeError?.message ?? MFA_CHALLENGE_LABELS.GENERIC_ERROR);
            return;
          }
          onCapabilityUnavailable(challengeError?.code ?? 'unknown');
          return;
        }

        const { error: verifyError } = await supabase.auth.mfa.verify({
          factorId,
          challengeId: challengeData.id,
          code,
        });

        setBusy(false);

        if (verifyError) {
          if (isWrongCodeError(verifyError)) {
            setError(verifyError.message || MFA_CHALLENGE_LABELS.GENERIC_ERROR);
            return;
          }
          onCapabilityUnavailable(verifyError.code ?? 'unknown');
          return;
        }

        onVerified();
      } catch {
        // A thrown exception (network failure, timeout) is a platform
        // failure by definition — there is no error CODE to inspect, so it
        // can never be mistaken for a wrong-code retry case.
        setBusy(false);
        onCapabilityUnavailable('unknown');
      }
    },
    [factorId, code, onVerified, onCapabilityUnavailable]
  );

  return (
    <div className="flex min-h-screen items-center justify-center p-4" data-testid="mfa-challenge">
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
            <Alert variant="destructive" data-testid="mfa-challenge-error">
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
                    data-testid="mfa-challenge-code"
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
                data-testid="mfa-challenge-submit"
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
            data-testid="mfa-challenge-signout"
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

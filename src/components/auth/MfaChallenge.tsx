/**
 * MFA Login Challenge — pre-pentest hardening (SCRUM-3167).
 *
 * Rendered by AuthGuard, in place of protected children, when the current
 * session is aal1 but the user has a verified TOTP factor (see
 * `useMfaAssurance`). Mirrors TwoFactorSetup's enrollment
 * challenge()+verify() sequence, applied here to an EXISTING factor instead
 * of a freshly-enrolled one.
 *
 * LOCKOUT SAFETY: always renders a working "Sign out" affordance (disabled
 * only while a request is genuinely in flight — item 6/D8). A user who has
 * lost their authenticator device cannot complete this screen — without an
 * escape hatch they would be fully trapped (authenticated enough to not see
 * the login page, not verified enough to reach the app). Signing out at
 * least returns them to a known, working state (the login page) where they
 * can seek account recovery, instead of a dead end.
 *
 * FAIL-OPEN CONTRACT (CTO ruling A4, PR #2637 review items 2/E2, 4/EA6, 30,
 * 32): this screen distinguishes "the user typed the wrong code" (their
 * fault, stay here and let them retry) from "the platform itself cannot
 * verify codes right now" (not their fault, and trapping them here would
 * be an availability incident, not a security control):
 *
 *   - `listFactors()` erroring, timing out, or throwing, OR unexpectedly
 *     finding no verified factor (defensive only — AuthGuard should never
 *     render this component without one), calls `onBypassed()`. This is
 *     NOT the same as a real verify — see `onBypassed` below.
 *   - `challenge()`/`verify()` returning a wrong-code error (via the shared
 *     `classifyMfaError`, `@/lib/mfaErrors` — `validation_failed` is
 *     deliberately NOT wrong-code, item 30: it's GoTrue's generic
 *     malformed-request code, not evidence of a bad TOTP code) shows a
 *     retryable inline error — the user's own mistake, and they can just
 *     try again.
 *   - Any OTHER `challenge()`/`verify()` error, a thrown exception, or a
 *     timeout (both calls are raced against an 8s budget — item 4/EA6:
 *     previously only `listFactors()` had one, so a hung `challenge()`/
 *     `verify()` spun the busy spinner forever) calls
 *     `onCapabilityUnavailable(code)` instead. AuthGuard treats this as a
 *     platform-availability failure: it renders `children`, emits a Sentry
 *     breadcrumb, and shows a one-shot toast — a broken MFA backend can
 *     never wall out an otherwise-authenticated user (accepted phase-1
 *     trade-off, tracked by SCRUM-3593's future aal2 RLS).
 *
 * `onVerified` vs `onBypassed` (item 32): `onVerified` fires ONLY after a
 * real, successful `challenge()`+`verify()` round trip — the one place this
 * screen has genuine evidence a factor was proven. Every fail-open branch
 * above calls `onBypassed` instead, which clears the challenge without
 * telling `useMfaAssurance` a verify happened (see that hook's module doc
 * comment). Conflating the two would let a platform read failure alone
 * mark `hasVerifiedFactor=true` for up to 60s.
 *
 * A `mounted` guard (item 6/D2) ensures a result that arrives after this
 * component has unmounted (navigation away mid-request) is ignored —
 * neither state nor a callback fires for a stale in-flight request.
 */

import { useState, useEffect, useCallback, useRef, FormEvent } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Loader2, AlertCircle, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/async';
import { classifyMfaError } from '@/lib/mfaErrors';
import { useAuth } from '@/hooks/useAuth';
import { MFA_CHALLENGE_LABELS } from '@/lib/copy';

interface MfaChallengeProps {
  /** Called ONLY after a real, successful challenge()+verify() round trip. */
  onVerified: () => void;
  /** Called on a fail-open path (listFactors() failure, or defensively finding no verified factor) — clears the challenge WITHOUT asserting a real verify happened. */
  onBypassed: () => void;
  /** Called when the MFA platform itself (not the user's code) is the reason verification cannot complete. */
  onCapabilityUnavailable: (code: string) => void;
}

const MFA_CHALLENGE_TIMEOUT_MS = 8_000;

export function MfaChallenge({ onVerified, onBypassed, onCapabilityUnavailable }: Readonly<MfaChallengeProps>) {
  const { signOut } = useAuth();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [loadingFactor, setLoadingFactor] = useState(true);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // item 6/D2: a result arriving after unmount is ignored — no setState,
  // no callback. Used by both the mount-time factor load and handleSubmit.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    async function loadFactor() {
      try {
        const { data, error: listError } = await withTimeout(
          supabase.auth.mfa.listFactors(),
          MFA_CHALLENGE_TIMEOUT_MS,
          'mfa-challenge-list-factors',
        );
        if (unmountedRef.current) return;

        if (listError || !data) {
          // FAIL OPEN (A4, item 32): a platform read failure is not the
          // user's fault, and this is not a real verify — onBypassed, not
          // onVerified.
          onBypassed();
          return;
        }

        const verified = data.totp.find((f: { status: string }) => f.status === 'verified');
        if (!verified) {
          // Defensive only: AuthGuard should never render this component
          // unless useMfaAssurance already confirmed a verified factor
          // exists. If the factor was unenrolled in the split second between
          // that check and this one, there is nothing to challenge against —
          // fail OPEN rather than trap the user behind an impossible screen.
          onBypassed();
          return;
        }

        setFactorId(verified.id);
        setLoadingFactor(false);
      } catch {
        // A thrown rejection or the timeout race above (item 2/E2) — a
        // platform read failure by definition, same fail-open target.
        if (unmountedRef.current) return;
        onBypassed();
      }
    }

    void loadFactor();
    // Intentionally mount-once: onBypassed/onVerified end this screen's
    // life one way or another; re-running on a prop-identity change would
    // just re-issue the same read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!factorId || code.length !== 6) return;

      setBusy(true);
      setError(null);

      try {
        const { data: challengeData, error: challengeError } = await withTimeout(
          supabase.auth.mfa.challenge({ factorId }),
          MFA_CHALLENGE_TIMEOUT_MS,
          'mfa-challenge-challenge',
        );
        if (unmountedRef.current) return;

        if (challengeError || !challengeData) {
          setBusy(false);
          const classified = classifyMfaError(challengeError, MFA_CHALLENGE_LABELS.GENERIC_ERROR);
          if (classified.kind === 'wrong_code') {
            setError(classified.message);
            return;
          }
          onCapabilityUnavailable(classified.code);
          return;
        }

        const { error: verifyError } = await withTimeout(
          supabase.auth.mfa.verify({ factorId, challengeId: challengeData.id, code }),
          MFA_CHALLENGE_TIMEOUT_MS,
          'mfa-challenge-verify',
        );
        if (unmountedRef.current) return;

        setBusy(false);

        if (verifyError) {
          const classified = classifyMfaError(verifyError, MFA_CHALLENGE_LABELS.GENERIC_ERROR);
          if (classified.kind === 'wrong_code') {
            setError(classified.message);
            return;
          }
          onCapabilityUnavailable(classified.code);
          return;
        }

        onVerified();
      } catch {
        // A thrown exception (network failure) or either timeout race
        // above (item 4/EA6) — no error CODE exists to inspect, so this can
        // never be mistaken for a wrong-code retry case.
        if (unmountedRef.current) return;
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
                    placeholder={MFA_CHALLENGE_LABELS.CODE_PLACEHOLDER}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
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
            disabled={busy || loadingFactor}
            onClick={() => void signOut()}
          >
            {MFA_CHALLENGE_LABELS.SIGN_OUT}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

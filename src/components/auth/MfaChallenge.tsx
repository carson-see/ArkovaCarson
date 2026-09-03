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
 * only while a request is genuinely in flight). A user who has lost their
 * authenticator device cannot complete this screen — without an escape
 * hatch they would be fully trapped (authenticated enough to not see the
 * login page, not verified enough to reach the app). Signing out at least
 * returns them to a known, working state (the login page) where they can
 * seek account recovery, instead of a dead end.
 *
 * FAIL-CLOSED CONTRACT (CTO ruling, PR #2637 review round 2, R17-R21 —
 * SUPERSEDES the earlier "fail open on any platform error" design):
 *
 *   Fail-open is allowed ONLY on the ENROLLMENT path (`MfaEnrollmentRequired`
 *   — a user with NO verified factor who cannot enrol because the platform
 *   cannot issue one). THIS component is the CHALLENGE path: a session at
 *   aal1 whose user HAS a verified factor. It fails CLOSED. Reason: a
 *   client-detected "platform error" is trivially attacker-triggerable
 *   (block one request in DevTools), so fail-open here made MFA optional
 *   for anyone holding a password.
 *
 *   `onVerified` is the ONLY prop — it fires ONLY after a real, successful
 *   `challenge()`+`verify()` round trip. There is no `onBypassed` /
 *   `onCapabilityUnavailable` escape hatch from this component: AuthGuard
 *   cannot be told to render children from here, structurally, not just by
 *   convention.
 *
 *   Three-way outcome per `classifyMfaError` (`@/lib/mfaErrors`):
 *     - `wrong_code` (the user mistyped their TOTP code) and `rejected`
 *       (an explicit backend rejection reached GoTrue and came back — rate
 *       limit, IP mismatch, a malformed request) BOTH show an inline,
 *       retryable error (`mfa-challenge-error`) and leave the code form
 *       usable. Neither ever calls `onVerified`.
 *     - `platform` (the explicit MFA-disabled capability codes, an
 *       unrecognized/absent error code, a thrown exception, or either
 *       `withTimeout` race firing) enters the `'retry'` state: a full
 *       screen with "Try again" (re-runs `loadFactor()`) and "Sign out" —
 *       it NEVER renders the code form and NEVER grants access. The same
 *       `'retry'` state is entered if `listFactors()` itself fails,
 *       errors, throws, times out, or (defensively) finds no verified
 *       factor.
 *   The `'retry'` state also re-checks automatically on the same
 *   visibility/foreground cadence as the rest of the MFA gate
 *   (`useVisibilityPolling`), so a transient platform outage clears itself
 *   without the user having to act.
 *
 * A `mounted` guard ensures a result that arrives after this component has
 * unmounted (navigation away mid-request) is ignored — neither state nor a
 * callback fires for a stale in-flight request.
 */

import { useState, useEffect, useCallback, useRef, FormEvent } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Loader2, AlertCircle, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/async';
import { classifyMfaError } from '@/lib/mfaErrors';
import { useAuth } from '@/hooks/useAuth';
import { useVisibilityPolling } from '@/hooks/useVisibilityPolling';
import { MFA_CHALLENGE_LABELS } from '@/lib/copy';

interface MfaChallengeProps {
  /** Called ONLY after a real, successful challenge()+verify() round trip. There is no other way out of this component that grants access. */
  onVerified: () => void;
}

const MFA_CHALLENGE_TIMEOUT_MS = 8_000;
const MFA_CHALLENGE_RETRY_INTERVAL_MS = 60_000;

type ChallengeStatus = 'loading' | 'ready' | 'retry';

export function MfaChallenge({ onVerified }: Readonly<MfaChallengeProps>) {
  const { signOut } = useAuth();
  const [status, setStatus] = useState<ChallengeStatus>('loading');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A result arriving after unmount is ignored — no setState, no callback.
  // Used by both the factor load and handleSubmit.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  const loadFactor = useCallback(async () => {
    // Deliberately does NOT set a 'loading' status before the request: the
    // initial mount already starts at 'loading' (useState default), and a
    // background/manual retry from the 'retry' screen should re-check
    // silently — flashing back to the full-screen spinner on every retry
    // attempt would be visual noise, and calling setState synchronously
    // inside the mount effect below is exactly the cascading-render pattern
    // react-hooks/set-state-in-effect flags. The screen simply stays on
    // 'retry' until this resolves one way or the other.
    try {
      const { data, error: listError } = await withTimeout(
        supabase.auth.mfa.listFactors(),
        MFA_CHALLENGE_TIMEOUT_MS,
        'mfa-challenge-list-factors',
      );
      if (unmountedRef.current) return;

      if (listError || !data) {
        // FAIL CLOSED: a platform read failure never grants access from
        // this component — it shows the retry screen instead.
        setStatus('retry');
        return;
      }

      const verified = data.totp.find((f) => f.status === 'verified');
      if (!verified) {
        // Defensive only: AuthGuard should never render this component
        // unless useMfaAssurance already confirmed a verified factor
        // exists. If the factor was unenrolled in the split second between
        // that check and this one, fail CLOSED — there is no verified
        // factor to challenge against, and this is not this user's signal
        // to bypass MFA.
        setStatus('retry');
        return;
      }

      setFactorId(verified.id);
      setError(null);
      setStatus('ready');
    } catch {
      // A thrown rejection or the timeout race above — a platform failure
      // by definition, same fail-closed target.
      if (unmountedRef.current) return;
      setStatus('retry');
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: the standard, React-docs-endorsed pattern for
    // "synchronize with an external system" (https://react.dev/learn/
    // you-might-not-need-an-effect#fetching-data) — `loadFactor` only
    // updates state after its own internal `await`, never synchronously
    // within this effect body, so there is no cascading-render risk; the
    // heuristic below cannot see across that async boundary. `loadFactor`
    // is stable (useCallback, empty deps) so listing it as a dependency
    // does not cause a re-run on every render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFactor();
  }, [loadFactor]);

  // Auto-retry on the same foreground/visibility cadence as the rest of the
  // MFA gate: a transient platform outage clears itself without the user
  // needing to click anything, but this NEVER runs while status is
  // 'ready'/'loading' — only the fail-closed retry screen re-checks itself.
  useVisibilityPolling(loadFactor, MFA_CHALLENGE_RETRY_INTERVAL_MS, {
    immediate: false,
    enabled: status === 'retry',
  });

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
          if (classified.kind === 'platform') {
            // FAIL CLOSED (changed from fail-open): a platform failure on
            // the challenge path never grants access.
            setStatus('retry');
            return;
          }
          // wrong_code or rejected: a real, retryable outcome — the form
          // stays usable.
          setError(classified.message);
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
          if (classified.kind === 'platform') {
            setStatus('retry');
            return;
          }
          setError(classified.message);
          return;
        }

        onVerified();
      } catch {
        // A thrown exception (network failure) or either timeout race
        // above — no error CODE exists to inspect, so this can never be
        // mistaken for a wrong-code/rejected retry case. FAIL CLOSED.
        if (unmountedRef.current) return;
        setBusy(false);
        setStatus('retry');
      }
    },
    [factorId, code, onVerified]
  );

  const loadingFactor = status === 'loading';
  const showRetry = status === 'retry';

  return (
    <div className="flex min-h-screen items-center justify-center p-4" data-testid="mfa-challenge">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArkovaIcon className="h-5 w-5" />
            {showRetry ? MFA_CHALLENGE_LABELS.RETRY_TITLE : MFA_CHALLENGE_LABELS.TITLE}
          </CardTitle>
          <CardDescription>
            {showRetry ? MFA_CHALLENGE_LABELS.RETRY_EXPLANATION : MFA_CHALLENGE_LABELS.DESCRIPTION}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && !showRetry && (
            <Alert variant="destructive" data-testid="mfa-challenge-error">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {showRetry && (
            <div className="space-y-4" data-testid="mfa-challenge-retry">
              <Alert variant="destructive">
                <ShieldAlert className="h-4 w-4" />
                <AlertDescription>{MFA_CHALLENGE_LABELS.RETRY_EXPLANATION}</AlertDescription>
              </Alert>
              <Button
                type="button"
                data-testid="mfa-challenge-retry-button"
                className="w-full"
                onClick={() => void loadFactor()}
              >
                {MFA_CHALLENGE_LABELS.RETRY_BUTTON}
              </Button>
            </div>
          )}

          {loadingFactor && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {status === 'ready' && (
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

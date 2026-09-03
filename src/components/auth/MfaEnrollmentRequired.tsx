/**
 * Mandatory MFA Enrollment — founder directive (2026-08-03: "yes it needs
 * to be mandatory"), phase-1 role-based enforcement (SCRUM-3167).
 *
 * Rendered by AuthGuard, in place of protected children, when the user's
 * role requires MFA (see `useMfaEnrollmentRequirement`) and they have no
 * verified factor yet. Starts TOTP enrollment automatically on mount —
 * this screen has exactly one job, so there is no separate "Enable 2FA"
 * button to click through first, and no "skip"/"later" affordance.
 *
 * FORCED ENROLLMENT, NOT A HARD LOCKOUT: this is deliberately a
 * COMPLETABLE flow, not a dead end. Every existing ORG_ADMIN / platform
 * admin has zero VERIFIED factors enrolled today (see Amendment A2 — the
 * one stale unverified row on prod never counts), so a design that blocked
 * access with no way to enroll would permanently lock out every admin,
 * including platform admins — an unrecoverable outage the moment this
 * deploys. This component IS the enrollment path: it is reachable the
 * instant AuthGuard decides enrollment is required, requires no prior aal2
 * state, and ends with the user at aal2 in THIS SAME session once they
 * verify (Supabase's verify() elevates the session, exactly like the
 * login-challenge path in MfaChallenge.tsx).
 *
 * UNIQUE FRIENDLY NAME (Amendment A2, hardened per PR #2637 review item
 * 25): enrolling always sends a fresh, timestamp+random-suffixed
 * `friendlyName` (the suffix is `randomSuffixHex()`, `@/lib/random` —
 * crypto.getRandomValues-backed, not `Math.random()`, per SonarCloud
 * typescript:S2245) so a stale/unverified factor left over from an earlier
 * attempt (prod has exactly one such row, dated 2026-03-23, on a platform
 * admin — see mfa-dossier.md) can never collide via
 * `mfa_factor_name_conflict`.
 *
 * FAIL-OPEN ON ANY ENROLL FAILURE (CTO ruling A4-2): `enroll()` returning
 * ANY error (known code, unknown code, or missing data), a thrown
 * exception, or a hung request that never resolves within the timeout all
 * call `onCapabilityUnavailable(code)` instead of showing an error the
 * user cannot act on. There is deliberately NO allowlist of "acceptable"
 * failure codes — a platform-side MFA outage must never permanently wall
 * out an otherwise-authenticated admin. AuthGuard renders `children` on
 * this signal (accepted phase-1 trade-off, tracked toward SCRUM-3593's
 * future aal2 RLS — see AuthGuard.tsx and this folder's agents.md).
 *
 * ENROLL TIMEOUT + ORPHAN CLEANUP (PR #2637 review item 31): the enroll()
 * budget is 15s (raised from 8s — enrollment is a heavier call than a
 * login challenge, and this screen has no busy competing UI to unblock).
 * If the request loses that race but the ORIGINAL call later resolves
 * successfully anyway (the network was just slow, not actually down), the
 * resulting factor is a real, unverified row on the server that this
 * screen never showed to the user — a best-effort `unenroll()` fires so it
 * never becomes an invisible orphan (unenrolling an unverified factor
 * needs no aal2, Amendment A3).
 *
 * PLATFORM FAILURES DURING VERIFY, NOT JUST ENROLL (items 4/E4/EA1):
 * `challenge()`/`verify()` in `handleVerify` are now ALSO wrapped in
 * try/catch and raced against a timeout, with the same shared
 * `classifyMfaError` (`@/lib/mfaErrors`) MfaChallenge uses — a platform
 * blip during the POST-enrollment verify step used to strand a
 * mandatorily-enrolling admin on a generic inline error with no escape
 * route (EA1); it now routes to `onCapabilityUnavailable` exactly like the
 * enroll step already did. A wrong CODE still shows the retryable inline
 * error — that is the user's own mistake.
 *
 * A `mounted` guard (item 6/D2) ensures a result arriving after this
 * component has unmounted is ignored. "Sign out" is disabled while
 * `starting` or `busy` (item 6/D8) — same lockout-safety rationale as
 * MfaChallenge, but a click mid-request would otherwise abandon an
 * in-flight enrollment on the server without a way to know its outcome.
 */

import { useState, useEffect, useCallback, useRef, FormEvent } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Loader2, AlertCircle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
import { withTimeout, TimeoutError } from '@/lib/async';
import { classifyMfaError } from '@/lib/mfaErrors';
import { randomSuffixHex } from '@/lib/random';
import { useAuth } from '@/hooks/useAuth';
import { MFA_ENROLLMENT_REQUIRED_LABELS } from '@/lib/copy';

interface EnrollmentData {
  factorId: string;
  qrCode: string;
  secret: string;
}

interface MfaEnrollmentRequiredProps {
  /** Called once enroll()+challenge()+verify() succeeds. */
  onEnrolled: () => void;
  /** Called when enroll() (or the post-enrollment verify) itself fails or hangs — a platform capability failure, not a user-fixable code. */
  onCapabilityUnavailable: (code: string) => void;
}

// Item 31: raised from 8s. Enrollment has no competing busy UI to unblock,
// and is a heavier call than a login challenge — a longer budget avoids
// mistaking ordinary latency for a platform outage while still bounding
// the worst case.
const ENROLL_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 8_000;

export function MfaEnrollmentRequired({
  onEnrolled,
  onCapabilityUnavailable,
}: Readonly<MfaEnrollmentRequiredProps>) {
  const { signOut } = useAuth();
  const [starting, setStarting] = useState(true);
  const [enrollmentData, setEnrollmentData] = useState<EnrollmentData | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // item 6/D2: a result arriving after unmount is ignored — no setState,
  // no callback. Shared by the mount-time enroll() and handleVerify.
  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    let timedOut = false;

    async function startEnrollment() {
      const friendlyName = `Authenticator ${new Date().toISOString().slice(0, 10)}-${randomSuffixHex()}`;
      const enrollPromise = supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });

      // Item 31 orphan cleanup: if THIS original call later resolves with
      // a real factor id after we've already reported unavailable (i.e.
      // it lost the race below), best-effort unenroll it — fire-and-forget,
      // errors ignored, since there is no UI left to report them to.
      enrollPromise
        .then((result) => {
          if (timedOut && result?.data?.id) {
            void supabase.auth.mfa.unenroll({ factorId: result.data.id }).catch(() => {
              /* best-effort only */
            });
          }
        })
        .catch(() => {
          /* the main try/catch below already handles this outcome */
        });

      try {
        const { data, error: enrollError } = await withTimeout(enrollPromise, ENROLL_TIMEOUT_MS, 'mfa-enroll');
        if (unmountedRef.current) return;

        if (enrollError || !data) {
          // FAIL OPEN (A4-2): no allowlist — every enroll error routes here.
          setStarting(false);
          onCapabilityUnavailable(enrollError?.code ?? 'unknown');
          return;
        }

        setEnrollmentData({
          factorId: data.id,
          qrCode: data.totp.qr_code,
          secret: data.totp.secret,
        });
        setStarting(false);
      } catch (err) {
        if (err instanceof TimeoutError) {
          timedOut = true;
        }
        if (unmountedRef.current) return;
        // Thrown exception or the timeout race above — no error CODE
        // exists to inspect, so this can never be mistaken for a
        // known/unknown-but-real error code.
        setStarting(false);
        onCapabilityUnavailable('unknown');
      }
    }

    void startEnrollment();
    // Intentionally mount-once: re-enrolling on every re-render would spam
    // Supabase and burn the MaxEnrolledFactors cap (Amendment A3).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleVerify = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!enrollmentData || code.length !== 6) return;

      setBusy(true);
      setError(null);

      try {
        const { data: challengeData, error: challengeError } = await withTimeout(
          supabase.auth.mfa.challenge({ factorId: enrollmentData.factorId }),
          VERIFY_TIMEOUT_MS,
          'mfa-enrollment-challenge',
        );
        if (unmountedRef.current) return;

        if (challengeError || !challengeData) {
          setBusy(false);
          const classified = classifyMfaError(challengeError, MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR);
          if (classified.kind === 'wrong_code') {
            setError(classified.message);
            return;
          }
          // EA1: a platform failure during the post-enrollment verify step
          // must fail open exactly like the enroll step already does — not
          // strand a mandatorily-enrolling admin on a generic inline error.
          onCapabilityUnavailable(classified.code);
          return;
        }

        const { error: verifyError } = await withTimeout(
          supabase.auth.mfa.verify({
            factorId: enrollmentData.factorId,
            challengeId: challengeData.id,
            code,
          }),
          VERIFY_TIMEOUT_MS,
          'mfa-enrollment-verify',
        );
        if (unmountedRef.current) return;

        setBusy(false);

        if (verifyError) {
          const classified = classifyMfaError(verifyError, MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR);
          if (classified.kind === 'wrong_code') {
            setError(classified.message);
            return;
          }
          onCapabilityUnavailable(classified.code);
          return;
        }

        onEnrolled();
      } catch {
        if (unmountedRef.current) return;
        setBusy(false);
        onCapabilityUnavailable('unknown');
      }
    },
    [enrollmentData, code, onEnrolled, onCapabilityUnavailable]
  );

  return (
    <div className="flex min-h-screen items-center justify-center p-4" data-testid="mfa-enrollment-required">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ArkovaIcon className="h-5 w-5" />
            {MFA_ENROLLMENT_REQUIRED_LABELS.TITLE}
          </CardTitle>
          <CardDescription>{MFA_ENROLLMENT_REQUIRED_LABELS.DESCRIPTION}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <Alert variant="destructive" data-testid="mfa-enrollment-error">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {starting ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            enrollmentData && (
              <form onSubmit={handleVerify} className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {MFA_ENROLLMENT_REQUIRED_LABELS.SCAN_INSTRUCTION}
                </p>
                <div className="flex justify-center rounded-lg border bg-white p-4" data-testid="mfa-enrollment-qr">
                  <img
                    src={enrollmentData.qrCode}
                    alt={MFA_ENROLLMENT_REQUIRED_LABELS.QR_ALT}
                    className="h-48 w-48"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">
                    {MFA_ENROLLMENT_REQUIRED_LABELS.MANUAL_ENTRY_LABEL}
                  </Label>
                  <code
                    className="block rounded bg-muted px-3 py-2 font-mono text-xs break-all select-all"
                    data-testid="mfa-enrollment-secret"
                  >
                    {enrollmentData.secret}
                  </code>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mfa-enroll-code">{MFA_ENROLLMENT_REQUIRED_LABELS.CODE_LABEL}</Label>
                  <div className="relative">
                    <ShieldAlert className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="mfa-enroll-code"
                      data-testid="mfa-enrollment-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder={MFA_ENROLLMENT_REQUIRED_LABELS.CODE_PLACEHOLDER}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]*"
                      maxLength={6}
                      disabled={busy}
                      className="pl-10 font-mono text-center text-lg tracking-widest"
                    />
                  </div>
                </div>
                <Button
                  type="submit"
                  data-testid="mfa-enrollment-submit"
                  className="w-full"
                  disabled={busy || code.length !== 6}
                >
                  {busy ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {MFA_ENROLLMENT_REQUIRED_LABELS.VERIFYING}
                    </>
                  ) : (
                    MFA_ENROLLMENT_REQUIRED_LABELS.SUBMIT
                  )}
                </Button>
              </form>
            )
          )}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="mfa-enrollment-signout"
            className="w-full text-muted-foreground"
            disabled={starting || busy}
            onClick={() => void signOut()}
          >
            {MFA_ENROLLMENT_REQUIRED_LABELS.SIGN_OUT}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

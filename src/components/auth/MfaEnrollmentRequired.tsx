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
 * `friendlyName` (the suffix is `crypto.randomUUID().slice(0, 8)` — R9, PR
 * #2637 review round 2: replaces the bespoke `randomSuffixHex()` helper,
 * now deleted, since the Web Crypto `randomUUID()` this repo already
 * requires is an equally CSPRNG-backed 8-hex-char source with no extra
 * module to maintain) so a stale/unverified factor left over from an earlier
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
 * ENROLL TIMEOUT + ORPHAN CLEANUP (PR #2637 review item 31, extended R3/R20
 * in round 2): the enroll() budget is 15s (raised from 8s — enrollment is a
 * heavier call than a login challenge, and this screen has no busy
 * competing UI to unblock). If the request loses that race but the
 * ORIGINAL call later resolves successfully anyway (the network was just
 * slow, not actually down), the resulting factor is a real, unverified row
 * on the server that this screen never showed to the user — a best-effort
 * `unenroll()` fires so it never becomes an invisible orphan (unenrolling
 * an unverified factor needs no aal2, Amendment A3). R20 extends this to
 * ANY unmount, not just the timeout race: a user who simply navigates away
 * before `enroll()` resolves leaves the exact same kind of orphan if that
 * original call later succeeds server-side. R3: the cleanup `unenroll()`
 * call itself is now raced against `ORPHAN_CLEANUP_TIMEOUT_MS`, like every
 * other supabase.auth.mfa.* call in this file — previously it was
 * fire-and-forget with no bound at all.
 *
 * PLATFORM FAILURES DURING VERIFY, NOT JUST ENROLL (items 4/E4/EA1, three-way
 * split corrected R24 — PR #2637 review round 2, real bug): `challenge()`/
 * `verify()` in `handleVerify` are wrapped in try/catch and raced against a
 * timeout, with the same shared `classifyMfaError` (`@/lib/mfaErrors`)
 * `MfaChallenge` uses. Only a `'platform'` classification (the explicit
 * MFA-disabled capability codes, or an unrecognized/absent code — i.e. a
 * genuine platform blip) routes to `onCapabilityUnavailable`, exactly like
 * the enroll step already does (EA1's original rationale: this must fail
 * open here too, or a mandatorily-enrolling admin gets stranded on a
 * generic inline error with no escape route). A `'wrong_code'` OR a
 * `'rejected'` classification (an explicit backend rejection — rate limit,
 * IP mismatch, a malformed request) both show a retryable inline error
 * instead — R24 fixed a real bug where `'rejected'` was being treated the
 * same as `'platform'` here, contradicting `mfaErrors.ts`'s own contract
 * that `'rejected'` is never a fail-open signal on either path.
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
// R3 (PR #2637 review round 2): the orphan-cleanup unenroll() call gets the
// same timeout discipline as every other supabase.auth.mfa.* call in this
// file — it was previously fire-and-forget with no bound at all, so a hung
// unenroll() request could linger indefinitely instead of settling.
const ORPHAN_CLEANUP_TIMEOUT_MS = 8_000;

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
      // R9: computed on its own line, not inlined into the template
      // literal below — see TwoFactorSetup.tsx's defaultFriendlyName for
      // why (npm run lint:copy's scanner treats a whole backtick template
      // as user-facing copy).
      const suffix = crypto.randomUUID().slice(0, 8);
      const friendlyName = `Authenticator ${new Date().toISOString().slice(0, 10)}-${suffix}`;
      const enrollPromise = supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });

      // Item 31 orphan cleanup: if THIS original call later resolves with
      // a real factor id after we've already reported unavailable (i.e.
      // it lost the race below), best-effort unenroll it — fire-and-forget,
      // errors ignored, since there is no UI left to report them to. R3:
      // the unenroll() call itself is now raced against a timeout too, like
      // every other supabase.auth.mfa.* call in this file.
      enrollPromise
        .then((result) => {
          if (timedOut && result?.data?.id) {
            void withTimeout(
              supabase.auth.mfa.unenroll({ factorId: result.data.id }),
              ORPHAN_CLEANUP_TIMEOUT_MS,
              'mfa-enroll-orphan-cleanup-timeout',
            ).catch(() => {
              /* best-effort only */
            });
          }
        })
        .catch(() => {
          /* the main try/catch below already handles this outcome */
        });

      try {
        const { data, error: enrollError } = await withTimeout(enrollPromise, ENROLL_TIMEOUT_MS, 'mfa-enroll');
        if (unmountedRef.current) {
          // R20 (PR #2637 review round 2): a late-resolving enroll() after
          // ANY unmount — not just the timeout race above (e.g. the user
          // simply navigated away before this screen finished loading) —
          // still leaves a real, unverified factor row on the server if it
          // succeeded. Clean it up best-effort instead of silently
          // returning and leaving an invisible orphan; there is no UI left
          // to show, so errors here are swallowed same as the timeout-race
          // cleanup above.
          if (data?.id) {
            void withTimeout(
              supabase.auth.mfa.unenroll({ factorId: data.id }),
              ORPHAN_CLEANUP_TIMEOUT_MS,
              'mfa-enroll-orphan-cleanup-unmount',
            ).catch(() => {
              /* best-effort only */
            });
          }
          return;
        }

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
          // R24 (PR #2637 review round 2, real bug): mirrors MfaChallenge's
          // three-way branch — ONLY 'platform' fails open. The prior
          // two-way `wrong_code` vs "everything else" split treated
          // 'rejected' codes (over_request_rate_limit, mfa_ip_address_mismatch,
          // validation_failed) as fail-open too, contradicting mfaErrors.ts's
          // own contract that 'rejected' is NEVER a fail-open signal on
          // either path. EA1's rationale (a platform failure during the
          // post-enrollment verify step must fail open, same as the enroll
          // step) still holds — it just means 'platform' specifically, not
          // every non-wrong-code outcome.
          if (classified.kind === 'platform') {
            onCapabilityUnavailable(classified.code);
            return;
          }
          setError(classified.message);
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
          // R24: same three-way split as the challenge() branch above.
          if (classified.kind === 'platform') {
            onCapabilityUnavailable(classified.code);
            return;
          }
          setError(classified.message);
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

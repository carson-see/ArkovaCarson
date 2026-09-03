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
 * UNIQUE FRIENDLY NAME (Amendment A2): enrolling always sends a fresh,
 * timestamp+random-suffixed `friendlyName` so a stale/unverified factor
 * left over from an earlier attempt (prod has exactly one such row, dated
 * 2026-03-23, on a platform admin — see mfa-dossier.md) can never collide
 * via `mfa_factor_name_conflict`.
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
 * LOCKOUT SAFETY: always renders a working "Sign out" affordance, for the
 * same reason as MfaChallenge — a user who cannot complete setup right
 * now (no phone handy) must be able to back out to a known-working state
 * (the login page) rather than being trapped mid-session with no exit.
 */

import { useState, useEffect, useCallback, FormEvent } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Loader2, AlertCircle, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
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
  /** Called when enroll() itself fails or hangs — a platform capability failure, not a user-fixable code. */
  onCapabilityUnavailable: (code: string) => void;
}

// Same circuit-breaker rationale as useMfaAssurance's assurance check: a
// last-resort bound so a stalled enroll() call surfaces the fail-open
// capability screen instead of an infinite spinner.
const ENROLL_TIMEOUT_MS = 8_000;

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('mfa-enroll-timeout')), ms);
  });
}

/** Short, non-cryptographic uniqueness suffix — this only needs to avoid a friendly-name collision, not to be unguessable. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

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

  useEffect(() => {
    let cancelled = false;

    async function startEnrollment() {
      const friendlyName = `Authenticator ${new Date().toISOString().slice(0, 10)}-${randomSuffix()}`;

      try {
        const { data, error: enrollError } = await Promise.race([
          supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName }),
          timeout(ENROLL_TIMEOUT_MS),
        ]);
        if (cancelled) return;

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
      } catch {
        if (cancelled) return;
        // Thrown exception or the timeout race above — no error CODE
        // exists to inspect, so this can never be mistaken for a
        // known/unknown-but-real error code.
        setStarting(false);
        onCapabilityUnavailable('unknown');
      }
    }

    void startEnrollment();
    return () => {
      cancelled = true;
    };
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

      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: enrollmentData.factorId,
      });

      if (challengeError || !challengeData) {
        setError(challengeError?.message ?? MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR);
        setBusy(false);
        return;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: enrollmentData.factorId,
        challengeId: challengeData.id,
        code,
      });

      setBusy(false);

      if (verifyError) {
        setError(verifyError.message || MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR);
        return;
      }

      onEnrolled();
    },
    [enrollmentData, code, onEnrolled]
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
                    alt="QR code for authenticator app"
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
                      placeholder="000000"
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
            onClick={() => void signOut()}
          >
            {MFA_ENROLLMENT_REQUIRED_LABELS.SIGN_OUT}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

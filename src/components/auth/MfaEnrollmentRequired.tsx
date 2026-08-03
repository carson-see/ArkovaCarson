/**
 * Mandatory MFA Enrollment — founder directive (2026-08-03: "yes it needs
 * to be mandatory").
 *
 * Rendered by AuthGuard, in place of protected children, when the user's
 * role requires MFA (see `useMfaEnrollmentRequirement`) and they have no
 * verified factor yet. Starts TOTP enrollment automatically on mount —
 * this screen has exactly one job, so there is no separate "Enable 2FA"
 * button to click through first, and no "skip"/"later" affordance.
 *
 * FORCED ENROLLMENT, NOT A HARD LOCKOUT: this is deliberately a
 * COMPLETABLE flow, not a dead end. Every existing ORG_ADMIN / platform
 * admin has zero factors enrolled today (MFA was never enforced before
 * this change), so a design that blocked access with no way to enroll
 * would permanently lock out every admin, including platform admins —
 * an unrecoverable outage the moment this deploys. This component IS the
 * enrollment path: it is reachable the instant AuthGuard decides
 * enrollment is required, requires no prior aal2 state, and ends with the
 * user at aal2 in THIS SAME session once they verify (Supabase's verify()
 * elevates the session, exactly like the login-challenge path in
 * MfaChallenge.tsx).
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
}

export function MfaEnrollmentRequired({ onEnrolled }: Readonly<MfaEnrollmentRequiredProps>) {
  const { signOut } = useAuth();
  const [starting, setStarting] = useState(true);
  const [enrollmentData, setEnrollmentData] = useState<EnrollmentData | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function startEnrollment() {
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
      if (cancelled) return;

      if (enrollError || !data) {
        setError(enrollError?.message ?? MFA_ENROLLMENT_REQUIRED_LABELS.START_ERROR);
        setStarting(false);
        return;
      }

      setEnrollmentData({
        factorId: data.id,
        qrCode: data.totp.qr_code,
        secret: data.totp.secret,
      });
      setStarting(false);
    }

    void startEnrollment();
    return () => {
      cancelled = true;
    };
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
    <div className="flex min-h-screen items-center justify-center p-4">
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
            <Alert variant="destructive">
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
                <div className="flex justify-center rounded-lg border bg-white p-4">
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
                  <code className="block rounded bg-muted px-3 py-2 font-mono text-xs break-all select-all">
                    {enrollmentData.secret}
                  </code>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mfa-enroll-code">{MFA_ENROLLMENT_REQUIRED_LABELS.CODE_LABEL}</Label>
                  <div className="relative">
                    <ShieldAlert className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="mfa-enroll-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      maxLength={6}
                      disabled={busy}
                      className="pl-10 font-mono text-center text-lg tracking-widest"
                    />
                  </div>
                </div>
                <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
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

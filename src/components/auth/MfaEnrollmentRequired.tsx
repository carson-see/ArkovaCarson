/**
 * Completes mandatory TOTP enrollment inside the protected-route gate.
 * Errors keep the gate closed and offer retry or sign-out. Late enrollment
 * responses are cleaned up so retries do not leave hidden factors behind.
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
}

const ENROLL_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 8_000;
const ORPHAN_CLEANUP_TIMEOUT_MS = 8_000;

export function MfaEnrollmentRequired({ onEnrolled }: Readonly<MfaEnrollmentRequiredProps>) {
  const { signOut } = useAuth();
  const [starting, setStarting] = useState(true);
  const [enrollmentData, setEnrollmentData] = useState<EnrollmentData | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enrollmentAttempt, setEnrollmentAttempt] = useState(0);

  const unmountedRef = useRef(false);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
    };
  }, []);

  // Prevent StrictMode's development remount from creating a second factor.
  const enrollmentStartedRef = useRef<number | null>(null);

  useEffect(() => {
    if (enrollmentStartedRef.current === enrollmentAttempt) return;
    enrollmentStartedRef.current = enrollmentAttempt;

    let timedOut = false;

    async function startEnrollment() {
      const suffix = crypto.randomUUID().slice(0, 8);
      const friendlyName = `Authenticator ${new Date().toISOString().slice(0, 10)}-${suffix}`;
      const enrollPromise = supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName });

      // A timed-out call may still create a factor after retry becomes available.
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
          // Navigation can also leave a late, invisible factor behind.
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
          setStarting(false);
          setError(MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR);
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
        setStarting(false);
        setError(MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR);
      }
    }

    void startEnrollment();
  }, [enrollmentAttempt]);

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
          if (classified.kind === 'platform') {
            setError(MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR);
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
          if (classified.kind === 'platform') {
            setError(MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR);
            return;
          }
          setError(classified.message);
          return;
        }

        onEnrolled();
      } catch {
        if (unmountedRef.current) return;
        setBusy(false);
        setError(MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR);
      }
    },
    [enrollmentData, code, onEnrolled]
  );

  const retryEnrollment = useCallback(() => {
    setError(null);
    setEnrollmentData(null);
    setCode('');
    setStarting(true);
    setEnrollmentAttempt((attempt) => attempt + 1);
  }, []);

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
          ) : enrollmentData ? (
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
          ) : (
            <Button type="button" className="w-full" onClick={retryEnrollment}>
              {MFA_ENROLLMENT_REQUIRED_LABELS.RETRY}
            </Button>
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

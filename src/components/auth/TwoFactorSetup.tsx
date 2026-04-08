/**
 * BETA-07: Two-Factor Authentication Setup
 *
 * Allows users to enroll/unenroll TOTP-based 2FA via Supabase MFA.
 * Displays QR code for authenticator app scanning and verifies codes.
 */

import { useState, useEffect, useCallback } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';

interface EnrollmentData {
  factorId: string;
  qrCode: string;
  secret: string;
}

type MfaState = 'loading' | 'disabled' | 'enrolling' | 'verifying' | 'enabled';

export function TwoFactorSetup() {
  const [state, setState] = useState<MfaState>('loading');
  const [enrollmentData, setEnrollmentData] = useState<EnrollmentData | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const checkEnrollment = useCallback(async () => {
    const { data, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError) {
      setError(listError.message);
      setState('disabled');
      return;
    }

    const verifiedFactor = data.totp.find(
      (f: { status: string }) => f.status === 'verified'
    );
    if (verifiedFactor) {
      setFactorId(verifiedFactor.id);
      setState('enabled');
    } else {
      setState('disabled');
    }
  }, []);

  useEffect(() => {
    checkEnrollment();
  }, [checkEnrollment]);

  const handleEnroll = useCallback(async () => {
    setBusy(true);
    setError(null);

    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
    });

    setBusy(false);

    if (enrollError || !data) {
      setError(enrollError?.message ?? 'Enrollment failed');
      return;
    }

    setEnrollmentData({
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    });
    setState('enrolling');
  }, []);

  const handleVerify = useCallback(async () => {
    if (!enrollmentData || verifyCode.length !== 6) return;

    setBusy(true);
    setError(null);

    const { data: challengeData, error: challengeError } =
      await supabase.auth.mfa.challenge({ factorId: enrollmentData.factorId });

    if (challengeError || !challengeData) {
      setError(challengeError?.message ?? 'Challenge failed');
      setBusy(false);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: enrollmentData.factorId,
      challengeId: challengeData.id,
      code: verifyCode,
    });

    setBusy(false);

    if (verifyError) {
      setError(verifyError.message);
      return;
    }

    setFactorId(enrollmentData.factorId);
    setEnrollmentData(null);
    setVerifyCode('');
    setState('enabled');
  }, [enrollmentData, verifyCode]);

  const handleDisable = useCallback(async () => {
    if (!factorId) return;

    setBusy(true);
    setError(null);

    const { error: unenrollError } = await supabase.auth.mfa.unenroll({
      factorId,
    });

    setBusy(false);

    if (unenrollError) {
      setError(unenrollError.message);
      return;
    }

    setFactorId(null);
    await checkEnrollment();
  }, [factorId, checkEnrollment]);

  if (state === 'loading') {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArkovaIcon className="h-5 w-5" />
          Two-Factor Authentication
        </CardTitle>
        <CardDescription>
          Add an extra layer of security to your account
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {state === 'enabled' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <span>Two-factor authentication is enabled</span>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDisable}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Disable 2FA
            </Button>
          </div>
        )}

        {state === 'disabled' && (
          <Button onClick={handleEnroll} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ArkovaIcon className="mr-2 h-4 w-4" />
            )}
            Enable 2FA
          </Button>
        )}

        {state === 'enrolling' && enrollmentData && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Scan this QR code with your authenticator app
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
                Manual entry code
              </Label>
              <code className="block rounded bg-muted px-3 py-2 font-mono text-xs break-all select-all">
                {enrollmentData.secret}
              </code>
            </div>
            <div className="space-y-2">
              <Label htmlFor="totp-code">Verification code</Label>
              <Input
                id="totp-code"
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000"
                maxLength={6}
                className="font-mono text-center text-lg tracking-widest"
              />
            </div>
            <Button
              onClick={handleVerify}
              disabled={busy || verifyCode.length !== 6}
              className="w-full"
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Verify & Enable
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

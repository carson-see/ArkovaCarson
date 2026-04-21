/**
 * Organization Verification Card (IDT WS4)
 *
 * Multi-step verification flow for organizations:
 * 1. Submit EIN/Tax ID
 * 2. Verify domain via email code
 * 3. Both complete → Verified checkmark
 *
 * In dev mode, steps auto-complete via dev bypass endpoints.
 */

import { useState, useCallback, useEffect } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Building2, Loader2, CheckCircle, Globe, Send, AlertCircle, Hash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { WORKER_URL } from '@/lib/workerClient';
import { supabase } from '@/lib/supabase';

const isDev = import.meta.env.DEV;

interface OrgVerificationProps {
  verificationStatus: string;
  domain?: string | null;
  domainVerified?: boolean;
  hasEin?: boolean;
  onVerified?: () => void;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not authenticated');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session.access_token}`,
  };
}

export function OrgVerification({
  verificationStatus: initialStatus,
  domain,
  domainVerified: initialDomainVerified,
  hasEin: initialHasEin,
  onVerified,
}: OrgVerificationProps) {
  const [status, setStatus] = useState(initialStatus);
  const [domainVerified, setDomainVerified] = useState(initialDomainVerified ?? false);
  const [hasEin, setHasEin] = useState(initialHasEin ?? false);

  // Sync props to local state when parent provides new values
  useEffect(() => {
    async function sync() {
      setStatus(initialStatus);
      setDomainVerified(initialDomainVerified ?? false);
      setHasEin(initialHasEin ?? false);
    }
    void sync();
  }, [initialStatus, initialDomainVerified, initialHasEin]);

  // Form state
  const [ein, setEin] = useState('');
  const [verificationCode, setVerificationCode] = useState('');

  // Loading states
  const [einLoading, setEinLoading] = useState(false);
  const [domainLoading, setDomainLoading] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [domainVerificationPending, setDomainVerificationPending] = useState(false);

  const isVerified = status === 'VERIFIED';

  /** Submit EIN — in dev mode, uses dev-verify to auto-complete everything */
  const handleSubmitEin = useCallback(async () => {
    if (!isDev && !ein.trim()) return;
    setEinLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const headers = await getAuthHeaders();

      // In dev mode, auto-verify the entire org
      if (isDev) {
        const response = await fetch(`${WORKER_URL}/api/v1/org/dev-verify`, {
          method: 'POST',
          headers,
        });

        const data = await response.json() as { error?: string; status?: string };
        if (!response.ok) {
          setError(data.error ?? 'Verification failed');
          return;
        }

        setStatus('VERIFIED');
        setDomainVerified(true);
        setHasEin(true);
        setSuccess('Organization verified');
        onVerified?.();
        return;
      }

      // Production: submit EIN normally
      const response = await fetch(`${WORKER_URL}/api/v1/org/verify-ein`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ein: ein.trim() }),
      });

      const data = await response.json() as { error?: string; status?: string; message?: string };
      if (!response.ok) {
        setError(data.error ?? 'Failed to submit EIN');
        return;
      }

      setHasEin(true);
      setStatus(data.status ?? 'PENDING');
      setSuccess(data.message ?? 'EIN submitted successfully');
      setEin('');
    } catch {
      setError('Failed to submit EIN');
    } finally {
      setEinLoading(false);
    }
  }, [ein, onVerified]);

  /** Start domain verification */
  const handleStartDomainVerification = useCallback(async () => {
    setDomainLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${WORKER_URL}/api/v1/org/verify-domain`, {
        method: 'POST',
        headers,
      });

      const data = await response.json() as { error?: string; message?: string; devCode?: string };
      if (!response.ok) {
        setError(data.error ?? 'Failed to start domain verification');
        return;
      }

      setDomainVerificationPending(true);
      setSuccess(data.message ?? 'Verification started');

      // In dev mode, auto-fill the code
      if (data.devCode) {
        setVerificationCode(data.devCode);
      }
    } catch {
      setError('Failed to start domain verification');
    } finally {
      setDomainLoading(false);
    }
  }, []);

  /** Confirm domain verification code */
  const handleConfirmDomain = useCallback(async () => {
    if (!verificationCode.trim()) return;
    setConfirmLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${WORKER_URL}/api/v1/org/confirm-domain`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: verificationCode.trim() }),
      });

      const data = await response.json() as { error?: string; verificationStatus?: string; message?: string };
      if (!response.ok) {
        setError(data.error ?? 'Failed to verify domain');
        return;
      }

      setDomainVerified(true);
      setDomainVerificationPending(false);
      if (data.verificationStatus) setStatus(data.verificationStatus);
      setSuccess(data.message ?? 'Domain verified!');

      if (data.verificationStatus === 'VERIFIED') {
        onVerified?.();
      }
    } catch {
      setError('Failed to confirm domain');
    } finally {
      setConfirmLoading(false);
    }
  }, [verificationCode, onVerified]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          Organization Verification
          {isVerified && (
            <CheckCircle className="h-5 w-5 text-emerald-500" />
          )}
        </CardTitle>
        <CardDescription>
          {isVerified
            ? 'Your organization is verified. This badge is shown on all your credentials.'
            : 'Verify your organization with an EIN/Tax ID and domain to earn a verified badge.'
          }
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {success && (
          <Alert>
            <CheckCircle className="h-4 w-4 text-emerald-500" />
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        )}

        {/* Step 1: EIN */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${hasEin ? 'bg-emerald-500/20 text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
              {hasEin ? <CheckCircle className="h-4 w-4" /> : '1'}
            </div>
            <Label className="text-sm font-medium">
              EIN / Tax ID
            </Label>
            {hasEin && (
              <Badge variant="outline" className="text-emerald-400 border-emerald-500/20 text-xs">
                Submitted
              </Badge>
            )}
          </div>

          {!hasEin && !isVerified && (
            <div className="flex gap-2 ml-8">
              <div className="relative flex-1">
                <Hash className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={ein}
                  onChange={(e) => setEin(e.target.value)}
                  placeholder="XX-XXXXXXX"
                  className="pl-10"
                  disabled={einLoading}
                />
              </div>
              <Button
                onClick={handleSubmitEin}
                disabled={einLoading || (!isDev && !ein.trim())}
                size="sm"
              >
                {einLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isDev ? 'Verify Organization' : 'Submit'}
              </Button>
            </div>
          )}
        </div>

        <Separator />

        {/* Step 2: Domain verification */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${domainVerified ? 'bg-emerald-500/20 text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
              {domainVerified ? <CheckCircle className="h-4 w-4" /> : '2'}
            </div>
            <Label className="text-sm font-medium">
              Domain Verification
            </Label>
            {domain && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Globe className="h-3 w-3" />
                {domain}
              </span>
            )}
            {domainVerified && (
              <Badge variant="outline" className="text-emerald-400 border-emerald-500/20 text-xs">
                Verified
              </Badge>
            )}
          </div>

          {!domainVerified && !isVerified && (
            <div className="ml-8 space-y-3">
              {!domain && (
                <p className="text-xs text-muted-foreground">
                  Set a domain in your organization settings first.
                </p>
              )}

              {domain && !domainVerificationPending && (
                <Button
                  onClick={handleStartDomainVerification}
                  disabled={domainLoading}
                  size="sm"
                  variant="outline"
                >
                  {domainLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  <Send className="mr-2 h-4 w-4" />
                  Send Verification Email
                </Button>
              )}

              {domainVerificationPending && (
                <div className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      value={verificationCode}
                      onChange={(e) => setVerificationCode(e.target.value)}
                      placeholder="Enter 6-digit code"
                      maxLength={6}
                      className="max-w-[200px] font-mono"
                      disabled={confirmLoading}
                    />
                    <Button
                      onClick={handleConfirmDomain}
                      disabled={confirmLoading || !verificationCode.trim()}
                      size="sm"
                    >
                      {confirmLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Confirm
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Verification summary */}
        {isVerified && (
          <>
            <Separator />
            <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/10">
              <ArkovaIcon className="h-5 w-5 text-emerald-500" />
              <div>
                <p className="text-sm font-medium text-emerald-400">Verified Organization</p>
                <p className="text-xs text-muted-foreground">
                  EIN confirmed, domain verified. All credentials show the verified badge.
                </p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

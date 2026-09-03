/**
 * SCRUM-3167 / SCRUM-3584: Two-Factor Authentication Settings
 *
 * Lists ALL TOTP factors (verified + unverified — Amendment A2: a stale
 * unverified factor must be visible and removable, never hidden), supports
 * enrolling a first factor and a second "backup" factor (up to the GoTrue
 * cap of 10 total), and honours the GoTrue v2.196.0 server rule that
 * enrolling a NEW factor — or unenrolling a VERIFIED one — while a verified
 * factor already exists requires an AAL2 session (Amendment A3). When the
 * server returns `insufficient_aal`, this component shows an inline
 * step-up code prompt (challengeAndVerify against an existing verified
 * factor) and retries the original action, rather than dead-ending the user.
 *
 * `mfa_factor_name_conflict` is handled by suggesting a retry (the default
 * friendly name is already de-duplicated client-side against the current
 * factor list, so a server-side conflict is a race, not the common case).
 * `mfa_totp_enroll_not_enabled` — the platform not having TOTP enabled — is
 * a non-blocking notice, never an error wall (Amendment A4-2's fail-open
 * principle applied to this settings card).
 *
 * After a successful verify or unenroll, `supabase.auth.refreshSession()` is
 * called so the JWT `aal` claim used elsewhere in the app is current in this
 * session (Amendment A4-8).
 */

import { useState, useEffect, useCallback } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Loader2, AlertCircle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
import { TWO_FACTOR_SETUP_LABELS as LABELS } from '@/lib/copy';

interface TotpFactor {
  id: string;
  friendly_name?: string;
  status: 'verified' | 'unverified';
  created_at: string;
}

interface EnrollmentData {
  factorId: string;
  qrCode: string;
  secret: string;
  friendlyName: string;
}

type PendingAction =
  | { type: 'enroll'; friendlyName: string }
  | { type: 'unenroll'; factorId: string };

type ViewState = 'loading' | 'list' | 'enrolling' | 'stepUp';

const MAX_TOTAL_FACTORS = 10;

function authErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function defaultFriendlyName(existingNames: string[]): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  const base = LABELS.DEFAULT_FACTOR_NAME(dateStr);
  if (!existingNames.includes(base)) return base;

  let suffix = 2;
  let candidate = `${base} (${suffix})`;
  while (existingNames.includes(candidate)) {
    suffix += 1;
    candidate = `${base} (${suffix})`;
  }
  return candidate;
}

function formatCreatedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString();
}

async function safeRefreshSession(): Promise<void> {
  try {
    await supabase.auth.refreshSession();
  } catch {
    // Best-effort — a stale AAL claim self-heals on the next natural token refresh.
  }
}

export function TwoFactorSetup() {
  const [view, setView] = useState<ViewState>('loading');
  const [factors, setFactors] = useState<TotpFactor[]>([]);
  const [enrollment, setEnrollment] = useState<EnrollmentData | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [stepUpCode, setStepUpCode] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshFactors = useCallback(async (): Promise<TotpFactor[]> => {
    const { data, error: listError } = await supabase.auth.mfa.listFactors();
    if (listError || !data) {
      setError(LABELS.ERROR_GENERIC);
      setFactors([]);
      setView('list');
      return [];
    }
    const list = (data.totp ?? []) as TotpFactor[];
    setFactors(list);
    setView('list');
    return list;
  }, []);

  useEffect(() => {
    void refreshFactors();
  }, [refreshFactors]);

  const performEnroll = useCallback(async (name: string) => {
    setBusy(true);
    const { data, error: enrollError } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: name,
    });
    setBusy(false);

    if (enrollError || !data) {
      const code = authErrorCode(enrollError);
      if (code === 'insufficient_aal') {
        setPendingAction({ type: 'enroll', friendlyName: name });
        setView('stepUp');
        return;
      }
      if (code === 'mfa_factor_name_conflict') {
        setError(LABELS.ERROR_NAME_CONFLICT);
        setView('list');
        return;
      }
      if (code === 'mfa_totp_enroll_not_enabled') {
        setNotice(LABELS.UNAVAILABLE);
        setView('list');
        return;
      }
      setError(LABELS.ERROR_GENERIC);
      setView('list');
      return;
    }

    setEnrollment({
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      friendlyName: name,
    });
    setVerifyCode('');
    setView('enrolling');
  }, []);

  const startEnroll = useCallback(() => {
    setError(null);
    setNotice(null);
    const name = defaultFriendlyName(
      factors.map((f) => f.friendly_name).filter((n): n is string => Boolean(n)),
    );
    void performEnroll(name);
  }, [factors, performEnroll]);

  const performUnenroll = useCallback(async (factorId: string) => {
    setBusy(true);
    const { error: unenrollError } = await supabase.auth.mfa.unenroll({ factorId });
    setBusy(false);

    if (unenrollError) {
      const code = authErrorCode(unenrollError);
      if (code === 'insufficient_aal') {
        setPendingAction({ type: 'unenroll', factorId });
        setView('stepUp');
        return;
      }
      setError(LABELS.ERROR_GENERIC);
      setView('list');
      return;
    }

    await safeRefreshSession();
    await refreshFactors();
  }, [refreshFactors]);

  const handleRemove = useCallback((factor: TotpFactor) => {
    setError(null);
    setNotice(null);
    void performUnenroll(factor.id);
  }, [performUnenroll]);

  const handleVerify = useCallback(async () => {
    if (!enrollment || verifyCode.length !== 6) return;

    setBusy(true);
    setError(null);

    const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId: enrollment.factorId,
    });

    if (challengeError || !challengeData) {
      setBusy(false);
      setError(LABELS.ERROR_GENERIC);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: enrollment.factorId,
      challengeId: challengeData.id,
      code: verifyCode,
    });

    setBusy(false);

    if (verifyError) {
      setError(LABELS.ERROR_STEP_UP_FAILED);
      return;
    }

    await safeRefreshSession();
    setEnrollment(null);
    setVerifyCode('');
    await refreshFactors();
  }, [enrollment, verifyCode, refreshFactors]);

  const cancelStepUp = useCallback(() => {
    setPendingAction(null);
    setStepUpCode('');
    setError(null);
    setView('list');
  }, []);

  const handleStepUpSubmit = useCallback(async () => {
    if (!pendingAction || stepUpCode.length !== 6) return;

    const verifiedFactorForStepUp = factors.find((f) => f.status === 'verified');
    if (!verifiedFactorForStepUp) {
      // Should not happen — insufficient_aal only occurs when a verified factor exists.
      setError(LABELS.ERROR_GENERIC);
      setPendingAction(null);
      setView('list');
      return;
    }

    setBusy(true);
    setError(null);

    const { error: stepUpError } = await supabase.auth.mfa.challengeAndVerify({
      factorId: verifiedFactorForStepUp.id,
      code: stepUpCode,
    });

    setBusy(false);

    if (stepUpError) {
      setError(LABELS.ERROR_STEP_UP_FAILED);
      return;
    }

    setStepUpCode('');
    const action = pendingAction;
    setPendingAction(null);

    if (action.type === 'enroll') {
      await performEnroll(action.friendlyName);
    } else {
      await performUnenroll(action.factorId);
    }
  }, [pendingAction, stepUpCode, factors, performEnroll, performUnenroll]);

  const hasVerifiedFactor = factors.some((f) => f.status === 'verified');
  const canAddMoreFactors = factors.length < MAX_TOTAL_FACTORS;

  if (view === 'loading') {
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
          {LABELS.CARD_TITLE}
        </CardTitle>
        <CardDescription>{LABELS.CARD_DESCRIPTION}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive" data-testid="twofactor-error">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {notice && (
          <Alert data-testid="twofactor-unavailable">
            <Info className="h-4 w-4" />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}

        {view === 'list' && (
          <div className="space-y-4">
            <div data-testid="twofactor-factor-list" className="space-y-2">
              {factors.length === 0 && (
                <p className="text-sm text-muted-foreground">{LABELS.LIST_EMPTY}</p>
              )}
              {factors.map((factor) => (
                <div
                  key={factor.id}
                  data-testid={`twofactor-factor-${factor.id}`}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">
                      {factor.friendly_name || LABELS.UNNAMED_FACTOR}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {factor.status === 'verified' ? LABELS.STATUS_ENABLED : LABELS.STATUS_INCOMPLETE}
                      {' · '}
                      {LABELS.ADDED_ON(formatCreatedDate(factor.created_at))}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid={`twofactor-remove-${factor.id}`}
                    aria-label={LABELS.REMOVE_ARIA(factor.friendly_name || LABELS.UNNAMED_FACTOR)}
                    onClick={() => handleRemove(factor)}
                    disabled={busy}
                  >
                    {LABELS.REMOVE_ACTION}
                  </Button>
                </div>
              ))}
            </div>

            {!hasVerifiedFactor && (
              <Button data-testid="twofactor-enable" onClick={startEnroll} disabled={busy}>
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <ArkovaIcon className="mr-2 h-4 w-4" />
                )}
                {LABELS.ENABLE_BUTTON}
              </Button>
            )}

            {hasVerifiedFactor && canAddMoreFactors && (
              <Button
                data-testid="twofactor-add-backup"
                variant="outline"
                onClick={startEnroll}
                disabled={busy}
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {LABELS.ADD_BACKUP_BUTTON}
              </Button>
            )}
          </div>
        )}

        {view === 'enrolling' && enrollment && (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="twofactor-friendly-name">{LABELS.FRIENDLY_NAME_LABEL}</Label>
              <Input
                id="twofactor-friendly-name"
                data-testid="twofactor-friendly-name"
                value={enrollment.friendlyName}
                readOnly
              />
            </div>

            <p className="text-sm text-muted-foreground">{LABELS.QR_INSTRUCTIONS}</p>
            <div className="flex justify-center rounded-lg border bg-white p-4">
              <img
                data-testid="twofactor-qr"
                src={enrollment.qrCode}
                alt={LABELS.QR_ALT}
                className="h-48 w-48"
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">{LABELS.SECRET_LABEL}</Label>
              <code
                data-testid="twofactor-secret"
                className="block rounded bg-muted px-3 py-2 font-mono text-xs break-all select-all"
              >
                {enrollment.secret}
              </code>
            </div>

            <div className="space-y-2">
              <Label htmlFor="twofactor-verify-code">{LABELS.VERIFY_CODE_LABEL}</Label>
              <Input
                id="twofactor-verify-code"
                data-testid="twofactor-verify-code"
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder={LABELS.VERIFY_CODE_PLACEHOLDER}
                maxLength={6}
                className="font-mono text-center text-lg tracking-widest"
              />
            </div>

            <Button
              data-testid="twofactor-verify-submit"
              onClick={handleVerify}
              disabled={busy || verifyCode.length !== 6}
              className="w-full"
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {LABELS.VERIFY_SUBMIT}
            </Button>
          </div>
        )}

        {view === 'stepUp' && (
          <div data-testid="twofactor-stepup" className="space-y-4">
            <p className="text-sm font-medium">{LABELS.STEP_UP_TITLE}</p>
            <p className="text-sm text-muted-foreground">{LABELS.STEP_UP_DESCRIPTION}</p>
            <div className="space-y-2">
              <Label htmlFor="twofactor-stepup-code">{LABELS.STEP_UP_CODE_LABEL}</Label>
              <Input
                id="twofactor-stepup-code"
                data-testid="twofactor-stepup-code"
                value={stepUpCode}
                onChange={(e) => setStepUpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder={LABELS.VERIFY_CODE_PLACEHOLDER}
                maxLength={6}
                className="font-mono text-center text-lg tracking-widest"
              />
            </div>
            <div className="flex gap-2">
              <Button
                data-testid="twofactor-stepup-submit"
                onClick={handleStepUpSubmit}
                disabled={busy || stepUpCode.length !== 6}
                className="flex-1"
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {LABELS.STEP_UP_SUBMIT}
              </Button>
              <Button
                type="button"
                variant="ghost"
                data-testid="twofactor-stepup-cancel"
                onClick={cancelStepUp}
                disabled={busy}
              >
                {LABELS.STEP_UP_CANCEL}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

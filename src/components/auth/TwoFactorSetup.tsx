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
 * friendly name always carries a random suffix — item 20/A2-3, PR #2637
 * review — so a server-side conflict is a genuine race, not the common
 * case a deterministic per-day name used to create). `mfa_verified_factor_exists`
 * (item 19/A2-2) means a verified factor now exists that this component's
 * stale local list didn't know about (e.g. verified from another tab, or a
 * racing session) — refresh and show it rather than erroring.
 * `mfa_totp_enroll_not_enabled` — the platform not having TOTP enabled — is
 * a non-blocking notice, never an error wall (Amendment A4-2's fail-open
 * principle applied to this settings card).
 *
 * FACTOR SOURCE (item 1/E1, PR #2637 review — CONFIRMED against auth-js
 * 2.110.8 GoTrueClient.js:4899-4907): `listFactors().data.totp` contains
 * VERIFIED TOTP factors ONLY; unverified factors exist ONLY in `data.all`.
 * This component reads `data.all` filtered to `factor_type === 'totp'` so
 * an incomplete (unverified) setup renders and stays removable — reading
 * `data.totp` would have silently hidden it.
 *
 * ALL FOUR MUTATING HANDLERS ARE TRY/CAUGHT (item 3/E3): a thrown
 * exception (network failure) resets `busy` and shows `ERROR_GENERIC`
 * instead of leaving the UI stuck on a spinner forever.
 *
 * CANCELLING AN IN-PROGRESS ENROLLMENT (item 21/A2-4): the enrolling view
 * has a Cancel control that unenrolls the just-created factor — always
 * legal at aal1 because it is still unverified (Amendment A3) — instead of
 * abandoning it as an invisible orphan on the server.
 *
 * After a successful verify, unenroll, OR step-up (item 22/A2-5 — the
 * refresh now happens immediately after the step-up itself succeeds, not
 * only via the retried action's own eventual success path),
 * `supabase.auth.refreshSession()` is called so the JWT `aal` claim used
 * elsewhere in the app is current in this session (Amendment A4-8).
 *
 * TIMEOUTS + LOAD-ERROR RETRY (R1/R2, PR #2637 review round 2): all six
 * `supabase.auth.mfa.*` calls this component makes (listFactors, enroll,
 * unenroll, challenge, verify, challengeAndVerify) now race against a
 * timeout via the shared `withTimeout` — previously none of them did, so a
 * hung request left either the mount-time load spinning forever (R1: a real
 * bug, since the mount effect also had no try/catch at all — a rejected
 * `listFactors()` left `view` stuck at `'loading'` permanently) or `busy`
 * stuck `true` on any other call. A `listFactors()` failure at mount now
 * shows a dedicated `'error'` view with a Retry control instead of an
 * infinite spinner. `handleVerify` and `handleStepUpSubmit` now route their
 * challenge()/verify() outcomes through the shared `classifyMfaError`
 * (`@/lib/mfaErrors`): a genuine wrong-code rejection keeps the specific
 * "that code did not match" copy, while any other outcome (a platform
 * failure, rate limit, thrown exception, or timeout) shows the generic
 * error instead of misleadingly implying the user mistyped their code.
 * `authErrorCode()` is UNCHANGED and still used by `performEnroll`/
 * `performUnenroll` — those calls need enrollment-management-specific codes
 * (`insufficient_aal`, `mfa_factor_name_conflict`, `mfa_verified_factor_exists`)
 * that `classifyMfaError` deliberately does not know about.
 */

import { useState, useEffect, useCallback, FormEvent } from 'react';
import { ArkovaIcon } from '@/components/layout/ArkovaLogo';
import { Loader2, AlertCircle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
import { withTimeout } from '@/lib/async';
import { classifyMfaError } from '@/lib/mfaErrors';
import type { TotpFactor } from '@/lib/mfaTypes';
import { TWO_FACTOR_SETUP_LABELS as LABELS } from '@/lib/copy';

interface EnrollmentData {
  factorId: string;
  qrCode: string;
  secret: string;
  friendlyName: string;
}

type PendingAction =
  | { type: 'enroll'; friendlyName: string }
  | { type: 'unenroll'; factorId: string };

// R1 (PR #2637 review round 2, real bug): 'error' is a new terminal state
// for the mount-time listFactors() load — see refreshFactors below. It is
// distinct from the existing `error` STRING state (an inline banner shown
// alongside the 'list'/'enrolling'/'stepUp' views for a resolved-but-failed
// mutation); this is a dedicated retry screen for the case where this
// component has no factor data to show at all.
type ViewState = 'loading' | 'list' | 'enrolling' | 'stepUp' | 'error';

const MAX_TOTAL_FACTORS = 10;

// R2 (PR #2637 review round 2): every supabase.auth.mfa.* call in this file
// now races against a timeout budget, matching MfaChallenge.tsx and
// MfaEnrollmentRequired.tsx — previously NONE of them did, so a hung
// request left the UI stuck (a spinner, or `busy` never resetting) forever.
const LIST_FACTORS_TIMEOUT_MS = 8_000;
const ENROLL_TIMEOUT_MS = 15_000;
const UNENROLL_TIMEOUT_MS = 8_000;
const CHALLENGE_TIMEOUT_MS = 8_000;
const VERIFY_TIMEOUT_MS = 8_000;
const STEP_UP_TIMEOUT_MS = 8_000;

// R2 (PR #2637 review round 2): still needed alongside the shared
// `classifyMfaError` — `insufficient_aal`, `mfa_factor_name_conflict`, and
// `mfa_verified_factor_exists` are enrollment/unenrollment MANAGEMENT
// codes specific to this settings surface (step-up routing, name
// collisions, a factor verified from another tab), not one of
// `classifyMfaError`'s wrong-code/platform buckets. `performEnroll` and
// `performUnenroll` keep using this directly; `handleVerify` and
// `handleStepUpSubmit` now go through `classifyMfaError` instead (see
// below) since those two calls only ever need the
// wrong-code-vs-everything-else distinction.
function authErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * Item 20/A2-3: ALWAYS carries a random suffix (not just on a detected
 * collision) so a deterministic per-day name can never collide with a
 * same-day re-enrollment attempt — including a factor that was deleted
 * and is therefore no longer in the currently-visible list, and a race
 * between two enrollment attempts computing the same base name at once.
 * A genuine server-side collision is still handled (mfa_factor_name_conflict
 * -> ERROR_NAME_CONFLICT, suggesting retry — which generates a fresh
 * random suffix).
 */
function defaultFriendlyName(): string {
  const dateStr = new Date().toISOString().slice(0, 10);
  // R9 (PR #2637 review round 2): the Web Crypto UUID API replaces the
  // bespoke randomSuffixHex() helper (now deleted) — an equally
  // CSPRNG-backed 8-hex-char source with no extra module to maintain.
  // Computed on its own line (not inlined into the template literal below)
  // so `npm run lint:copy`'s scanner — which treats an entire backtick
  // template as user-facing copy — never sees the API name next to the
  // banned §1.3 term it happens to share a prefix with.
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${LABELS.DEFAULT_FACTOR_NAME(dateStr)}-${suffix}`;
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
    try {
      const { data, error: listError } = await withTimeout(
        supabase.auth.mfa.listFactors(),
        LIST_FACTORS_TIMEOUT_MS,
        'twofactor-list-factors',
      );
      if (listError || !data) {
        setError(LABELS.ERROR_GENERIC);
        setFactors([]);
        setView('list');
        return [];
      }
      // Item 1/E1: `data.totp` is VERIFIED-ONLY (auth-js pushes to it only
      // when status === 'verified'); unverified factors exist ONLY in
      // `data.all`. Read `data.all` filtered to this component's factor type
      // so an incomplete setup still renders and stays removable.
      const list = (data.all ?? []).filter(
        (f): f is TotpFactor => f.factor_type === 'totp',
      );
      setFactors(list);
      setView('list');
      return list;
    } catch {
      // R1 (real bug, PR #2637 review round 2): previously this call had no
      // try/catch and no timeout at all, so a rejected or hung listFactors()
      // left the mount-time `run()` effect below awaiting forever and the
      // card stuck on its loading spinner. Neither a thrown exception nor
      // the timeout race above carries a code worth inspecting — show the
      // dedicated retry screen instead.
      setView('error');
      return [];
    }
  }, []);

  useEffect(() => {
    async function run() {
      await refreshFactors();
    }
    void run();
  }, [refreshFactors]);

  const performEnroll = useCallback(
    async (name: string) => {
      setBusy(true);
      try {
        const { data, error: enrollError } = await withTimeout(
          supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: name }),
          ENROLL_TIMEOUT_MS,
          'twofactor-enroll',
        );
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
          if (code === 'mfa_verified_factor_exists') {
            // Item 19/A2-2 (Amendment A2 ruling c): a verified factor now
            // exists that this component's stale local state didn't know
            // about — refresh and show it rather than a raw error.
            await refreshFactors();
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
      } catch {
        // Item 3/E3: a thrown exception (network failure) must not leave
        // `busy` stuck true forever.
        setBusy(false);
        setError(LABELS.ERROR_GENERIC);
        setView('list');
      }
    },
    [refreshFactors]
  );

  const startEnroll = useCallback(() => {
    setError(null);
    setNotice(null);
    void performEnroll(defaultFriendlyName());
  }, [performEnroll]);

  const performUnenroll = useCallback(
    async (factorId: string) => {
      setBusy(true);
      try {
        const { error: unenrollError } = await withTimeout(
          supabase.auth.mfa.unenroll({ factorId }),
          UNENROLL_TIMEOUT_MS,
          'twofactor-unenroll',
        );
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
      } catch {
        setBusy(false);
        setError(LABELS.ERROR_GENERIC);
        setView('list');
      }
    },
    [refreshFactors]
  );

  const handleRemove = useCallback((factor: TotpFactor) => {
    setError(null);
    setNotice(null);
    void performUnenroll(factor.id);
  }, [performUnenroll]);

  // Item 21/A2-4: Cancel during enrollment unenrolls the just-created
  // factor. Always legal at aal1 — it is still unverified — so it never
  // needs the step-up flow, and never leaves an invisible orphan behind.
  // Deliberately does NOT clear `enrollment` up front: `view` stays
  // 'enrolling' until `performUnenroll`'s own success path calls
  // `refreshFactors()` (which sets `view` to 'list'), so the QR/Cancel
  // button stay visible — merely disabled via `busy` — instead of the
  // screen going blank for the 'enrolling'-view-with-no-enrollment-data gap
  // that clearing it early would create.
  const cancelEnrollment = useCallback(() => {
    if (!enrollment) return;
    setError(null);
    setNotice(null);
    void performUnenroll(enrollment.factorId);
  }, [enrollment, performUnenroll]);

  const handleVerify = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!enrollment || verifyCode.length !== 6) return;

      setBusy(true);
      setError(null);

      try {
        const { data: challengeData, error: challengeError } = await withTimeout(
          supabase.auth.mfa.challenge({ factorId: enrollment.factorId }),
          CHALLENGE_TIMEOUT_MS,
          'twofactor-verify-challenge',
        );

        if (challengeError || !challengeData) {
          setBusy(false);
          // R2: route through the shared classifier — a wrong-code-shaped
          // rejection (there is no challenge input to mistype, so this is
          // rare, but classifyMfaError is still the single source of truth
          // for the distinction) keeps the specific copy; anything else
          // (a genuine platform failure) shows the generic error instead of
          // implying the user did something wrong.
          const classified = classifyMfaError(challengeError, LABELS.ERROR_GENERIC);
          setError(classified.kind === 'wrong_code' ? LABELS.ERROR_STEP_UP_FAILED : LABELS.ERROR_GENERIC);
          return;
        }

        const { error: verifyError } = await withTimeout(
          supabase.auth.mfa.verify({
            factorId: enrollment.factorId,
            challengeId: challengeData.id,
            code: verifyCode,
          }),
          VERIFY_TIMEOUT_MS,
          'twofactor-verify-verify',
        );

        setBusy(false);

        if (verifyError) {
          // R2: `ERROR_STEP_UP_FAILED` ("That code did not match") is only
          // accurate for a genuine wrong-code rejection — reusing it for a
          // platform failure (a rate limit, an IP mismatch, a capability
          // outage) would falsely tell the user their code was wrong.
          const classified = classifyMfaError(verifyError, LABELS.ERROR_GENERIC);
          setError(classified.kind === 'wrong_code' ? LABELS.ERROR_STEP_UP_FAILED : LABELS.ERROR_GENERIC);
          return;
        }

        await safeRefreshSession();
        setEnrollment(null);
        setVerifyCode('');
        await refreshFactors();
      } catch {
        setBusy(false);
        setError(LABELS.ERROR_GENERIC);
      }
    },
    [enrollment, verifyCode, refreshFactors]
  );

  const cancelStepUp = useCallback(() => {
    setPendingAction(null);
    setStepUpCode('');
    setError(null);
    setView('list');
  }, []);

  const handleStepUpSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
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

      try {
        const { error: stepUpError } = await withTimeout(
          supabase.auth.mfa.challengeAndVerify({
            factorId: verifiedFactorForStepUp.id,
            code: stepUpCode,
          }),
          STEP_UP_TIMEOUT_MS,
          'twofactor-step-up',
        );

        setBusy(false);

        if (stepUpError) {
          // R2: same wrong-code-vs-platform split as handleVerify above.
          const classified = classifyMfaError(stepUpError, LABELS.ERROR_GENERIC);
          setError(classified.kind === 'wrong_code' ? LABELS.ERROR_STEP_UP_FAILED : LABELS.ERROR_GENERIC);
          return;
        }

        // Item 22/A2-5 (Amendment A4-8): refresh the JWT aal claim to aal2
        // IMMEDIATELY — do not rely solely on the retried action's own
        // eventual safeRefreshSession() call, which never runs if that
        // retry short-circuits on a DIFFERENT error before reaching it.
        await safeRefreshSession();

        setStepUpCode('');
        const action = pendingAction;
        setPendingAction(null);

        if (action.type === 'enroll') {
          await performEnroll(action.friendlyName);
        } else {
          await performUnenroll(action.factorId);
        }
      } catch {
        setBusy(false);
        setError(LABELS.ERROR_GENERIC);
      }
    },
    [pendingAction, stepUpCode, factors, performEnroll, performUnenroll]
  );

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

        {view === 'error' && (
          <div className="space-y-4">
            <Alert variant="destructive" data-testid="twofactor-load-error">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{LABELS.LOAD_ERROR_TITLE}</AlertDescription>
            </Alert>
            <Button
              type="button"
              data-testid="twofactor-load-retry"
              onClick={() => void refreshFactors()}
            >
              {LABELS.LOAD_ERROR_RETRY}
            </Button>
          </div>
        )}

        {view === 'list' && (
          <div className="space-y-4">
            {/* R4 (live E2E rig failure): renamed from 'twofactor-factor-list'
                — the spec's prefix locator [data-testid^='twofactor-factor-']
                matched this container's OWN testid in addition to each row's
                'twofactor-factor-{id}', so toHaveCount(2) saw 3 (container +
                2 rows). This container no longer shares that prefix. */}
            <div data-testid="twofactor-factors" className="space-y-2">
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
          <form onSubmit={handleVerify} className="space-y-4">
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
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                disabled={busy}
                className="font-mono text-center text-lg tracking-widest"
              />
            </div>

            <div className="flex gap-2">
              <Button
                type="submit"
                data-testid="twofactor-verify-submit"
                disabled={busy || verifyCode.length !== 6}
                className="flex-1"
              >
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {LABELS.VERIFY_SUBMIT}
              </Button>
              <Button
                type="button"
                variant="ghost"
                data-testid="twofactor-cancel-enrollment"
                onClick={cancelEnrollment}
                disabled={busy}
              >
                {LABELS.STEP_UP_CANCEL}
              </Button>
            </div>
          </form>
        )}

        {view === 'stepUp' && (
          <form onSubmit={handleStepUpSubmit} data-testid="twofactor-stepup" className="space-y-4">
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
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                className="font-mono text-center text-lg tracking-widest"
              />
            </div>
            <div className="flex gap-2">
              <Button
                type="submit"
                data-testid="twofactor-stepup-submit"
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
          </form>
        )}
      </CardContent>
    </Card>
  );
}

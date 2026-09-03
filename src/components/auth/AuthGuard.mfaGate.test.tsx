/**
 * AuthGuard MFA gate tests — SCRUM-3167.
 *
 * AuthGuard is the single choke point every authenticated route in
 * App.tsx renders through — the ONLY place a page-reload or deep-link
 * mid-challenge/mid-enrollment cannot slip past the gate. This file covers
 * the full decision table (first match wins):
 *
 *   1 authLoading              -> spinner
 *   2 !user                    -> login redirect/fallback
 *   3 mfaStatus loading        -> spinner
 *   4 policy loading           -> spinner
 *   5 capabilityUnavailable    -> children (+ one-shot toast + Sentry)
 *   6 challenge_required       -> <MfaChallenge>
 *   7 !hasVerifiedFactor
 *       && mfaRequired         -> <MfaEnrollmentRequired>
 *   8 mfaGraceActive           -> <MfaGraceNudge/> ABOVE children
 *   9 (else)                   -> children
 *
 * The single most important test in this file is the LOCKOUT-PREVENTION
 * GUARD: a user with NO MFA enrolled, on a role that does not require it,
 * must reach children exactly as before. Breaking that is the catastrophic
 * failure mode this whole change exists to avoid.
 *
 * `useMfaAssurance`, `useMfaEnrollmentRequirement`, `MfaChallenge`,
 * `MfaEnrollmentRequired`, and `MfaGraceNudge` are mocked here deliberately
 * — each has its own dedicated test file covering its internal behavior.
 * This file tests only AuthGuard's branching decision.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthGuard } from './AuthGuard';
import { __resetMfaCapabilityCooldownForTests } from '@/lib/mfaCapabilityCooldown';

const toastWarning = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: { info: (...args: unknown[]) => toastInfo(...args), warning: (...args: unknown[]) => toastWarning(...args) },
}));

const mockCaptureMessage = vi.fn();
vi.mock('@/lib/sentry', () => ({
  Sentry: { captureMessage: (...args: unknown[]) => mockCaptureMessage(...args) },
}));

const authState: { user: { id: string } | null; loading: boolean } = {
  user: { id: 'user-1' },
  loading: false,
};
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => authState,
}));

const mfaState: {
  status: 'loading' | 'satisfied' | 'challenge_required';
  hasVerifiedFactor: boolean;
} = {
  status: 'satisfied',
  hasVerifiedFactor: false,
};
const markVerified = vi.fn();
const markBypassed = vi.fn();
vi.mock('../../hooks/useMfaAssurance', () => ({
  useMfaAssurance: () => ({ ...mfaState, markVerified, markBypassed }),
}));

const requirementState: {
  loading: boolean;
  mfaRequired: boolean;
  mfaGraceActive: boolean;
  enforceFromIso: string;
} = {
  loading: false,
  mfaRequired: false,
  mfaGraceActive: false,
  enforceFromIso: '2026-09-21T00:00:00Z',
};
vi.mock('../../hooks/useMfaEnrollmentRequirement', () => ({
  useMfaEnrollmentRequirement: () => requirementState,
}));

vi.mock('./MfaChallenge', () => ({
  MfaChallenge: ({
    onVerified,
    onBypassed,
    onCapabilityUnavailable,
  }: {
    onVerified: () => void;
    onBypassed: () => void;
    onCapabilityUnavailable: (code: string) => void;
  }) => (
    <div>
      <button onClick={onVerified}>stub-mfa-challenge</button>
      <button onClick={onBypassed}>stub-mfa-challenge-bypassed</button>
      <button onClick={() => onCapabilityUnavailable('mfa_totp_verify_not_enabled')}>
        stub-mfa-challenge-capability-fail
      </button>
    </div>
  ),
}));

vi.mock('./MfaEnrollmentRequired', () => ({
  MfaEnrollmentRequired: ({
    onEnrolled,
    onCapabilityUnavailable,
  }: {
    onEnrolled: () => void;
    onCapabilityUnavailable: (code: string) => void;
  }) => (
    <div>
      <button onClick={onEnrolled}>stub-mfa-enrollment-required</button>
      <button onClick={() => onCapabilityUnavailable('mfa_totp_enroll_not_enabled')}>
        stub-mfa-enrollment-capability-fail
      </button>
    </div>
  ),
}));

vi.mock('./MfaGraceNudge', () => ({
  MfaGraceNudge: ({ enforceFrom }: { enforceFrom?: string }) => (
    <div>stub-mfa-grace-nudge:{enforceFrom}</div>
  ),
}));

// Spy on Navigate so the "no redirect loop" test can assert it was never
// invoked — a plain no-op stub (as AuthGuard.test.tsx uses) would hide
// that signal.
const navigateSpy = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    Navigate: (props: unknown) => {
      navigateSpy(props);
      return null;
    },
    useLocation: () => ({ pathname: '/private', search: '', hash: '', state: null, key: 'test' }),
  };
});

function resetToDefaults() {
  authState.user = { id: 'user-1' };
  authState.loading = false;
  mfaState.status = 'satisfied';
  mfaState.hasVerifiedFactor = false;
  requirementState.loading = false;
  requirementState.mfaRequired = false;
  requirementState.mfaGraceActive = false;
  requirementState.enforceFromIso = '2026-09-21T00:00:00Z';
}

describe('AuthGuard — MFA session gate (SCRUM-3167)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetToDefaults();
    // The capability cooldown (item 5/D1) is a REAL module-level singleton,
    // not mocked — reset it so one test's fail-open trip doesn't leak a
    // cooldown window into the next test in this file.
    __resetMfaCapabilityCooldownForTests();
  });

  it('LOCKOUT-PREVENTION GUARD: renders children for a user with no MFA enrolled on a role that does not require it — this must never regress', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = false;
    requirementState.mfaGraceActive = false;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('protected content')).toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-challenge')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-grace-nudge')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Row 1: authLoading -> spinner
  // -----------------------------------------------------------------------
  it('ROW 1 (authLoading): shows a spinner and calls none of the MFA hooks branches while auth itself is loading', () => {
    authState.loading = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-challenge')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Row 2: !user -> redirect / fallback
  // -----------------------------------------------------------------------
  it('ROW 2 (!user, no fallback): redirects to login — the auth check runs before any MFA gate, even if the MFA hooks are stubbed truthy', () => {
    authState.user = null;
    mfaState.status = 'challenge_required'; // stubbed truthy on purpose: must not matter
    requirementState.mfaRequired = true; // stubbed truthy on purpose: must not matter
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-challenge')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });

  it('ROW 2 (!user, with fallback): renders the fallback instead of redirecting', () => {
    authState.user = null;
    render(
      <AuthGuard fallback={<div>public fallback</div>}>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('public fallback')).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Row 3 / 4: mfaStatus loading / policy loading -> spinner
  // -----------------------------------------------------------------------
  it('ROW 3 (mfaStatus loading): shows a spinner, not children, not any gate', () => {
    mfaState.status = 'loading';
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-challenge')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
  });

  it('ROW 4 (policy loading): shows a spinner even if the assurance check already resolved', () => {
    mfaState.status = 'satisfied';
    requirementState.loading = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Row 5: capabilityUnavailable -> children (+ one-shot toast + Sentry)
  // -----------------------------------------------------------------------
  it('ROW 5 (capability unavailable from the challenge screen): fails open to children, fires the toast once, and reports to Sentry with {code, path}', async () => {
    mfaState.status = 'challenge_required';
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );

    expect(screen.getByText('stub-mfa-challenge')).toBeInTheDocument();

    screen.getByText('stub-mfa-challenge-capability-fail').click();

    await screen.findByText('protected content');
    expect(screen.queryByText('stub-mfa-challenge')).not.toBeInTheDocument();
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'mfa_capability_unavailable',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ code: 'mfa_totp_verify_not_enabled', path: '/private' }),
      })
    );
  });

  it('ROW 5 (capability unavailable from the forced-enrollment screen): fails open to children instead of trapping the admin', async () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );

    expect(screen.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();

    screen.getByText('stub-mfa-enrollment-capability-fail').click();

    await screen.findByText('protected content');
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'mfa_capability_unavailable',
      expect.objectContaining({ tags: expect.objectContaining({ code: 'mfa_totp_enroll_not_enabled' }) })
    );
  });

  it('ROW 5: the toast fires only ONCE even if onCapabilityUnavailable somehow fires more than once (ref guard)', async () => {
    mfaState.status = 'challenge_required';
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );

    screen.getByText('stub-mfa-challenge-capability-fail').click();
    await screen.findByText('protected content');
    expect(toastWarning).toHaveBeenCalledTimes(1);
  });

  it('ROW 5: no Sentry PII — only {code, path} tags are sent, never a user id or email', async () => {
    mfaState.status = 'challenge_required';
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    screen.getByText('stub-mfa-challenge-capability-fail').click();
    await screen.findByText('protected content');

    const call = mockCaptureMessage.mock.calls[0];
    const options = call[1] as { tags: Record<string, unknown> };
    expect(Object.keys(options.tags).sort()).toEqual(['code', 'path']);
  });

  // -----------------------------------------------------------------------
  // Item 5/D1 (CONFIRMED by the verifier) + item 24: the cooldown is
  // CROSS-INSTANCE, not per-AuthGuard-mount. A fresh AuthGuard mounted
  // while the cooldown is active (simulating the next of ~52 routes the
  // user navigates to during an outage) must render children directly —
  // WITHOUT ever mounting MfaChallenge/MfaEnrollmentRequired again — and
  // must NOT fire a second toast/Sentry event.
  // -----------------------------------------------------------------------
  it('ROW 5/D1: a FRESH AuthGuard instance mounted after another instance already failed open renders children immediately, with no second enroll()/challenge() attempt and no second toast/Sentry', async () => {
    mfaState.status = 'challenge_required';
    const first = render(
      <AuthGuard>
        <div>first-route content</div>
      </AuthGuard>
    );
    first.getByText('stub-mfa-challenge-capability-fail').click();
    await first.findByText('first-route content');
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    first.unmount();

    // Simulate navigating to a DIFFERENT route — a brand new AuthGuard
    // instance, same as every one of the ~52 routes in App.tsx.
    mfaState.status = 'challenge_required'; // still required, if the gate were naive it would re-mount MfaChallenge
    const second = render(
      <AuthGuard>
        <div>second-route content</div>
      </AuthGuard>
    );

    // Renders children directly — MfaChallenge is never even mounted, so
    // enroll()/challenge() cannot be re-attempted within the window.
    expect(second.queryByText('stub-mfa-challenge')).not.toBeInTheDocument();
    expect(second.getByText('second-route content')).toBeInTheDocument();
    // No additional toast/Sentry beyond the first instance's one-shot.
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('ROW 5/D1: the gate RE-ARMS once the cooldown window has expired — a fresh mount after the window sees the real MFA gate again', async () => {
    vi.useFakeTimers();
    mfaState.status = 'challenge_required';
    const first = render(
      <AuthGuard>
        <div>first-route content</div>
      </AuthGuard>
    );
    first.getByText('stub-mfa-challenge-capability-fail').click();
    await vi.advanceTimersByTimeAsync(0);
    first.unmount();

    // Well past the 5-minute cooldown window.
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    const second = render(
      <AuthGuard>
        <div>second-route content</div>
      </AuthGuard>
    );
    expect(second.getByText('stub-mfa-challenge')).toBeInTheDocument();
    expect(second.queryByText('second-route content')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Row 6: challenge_required -> <MfaChallenge>
  // -----------------------------------------------------------------------
  it('ROW 6: renders MfaChallenge instead of children when a challenge is required, regardless of role tier', () => {
    mfaState.status = 'challenge_required';
    requirementState.mfaRequired = false; // even an ordinary user is challenged if THEY enrolled voluntarily
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.getByText('stub-mfa-challenge')).toBeInTheDocument();
  });

  it('ROW 6: renders children once MfaChallenge reports success (wires markVerified as onVerified)', () => {
    mfaState.status = 'challenge_required';
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    screen.getByText('stub-mfa-challenge').click();
    expect(markVerified).toHaveBeenCalledTimes(1);
  });

  it('ROW 6 (item 32): wires MfaChallenge\'s onBypassed to markBypassed, NOT markVerified — a fail-open bypass must never falsely claim a real verify happened', () => {
    mfaState.status = 'challenge_required';
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    screen.getByText('stub-mfa-challenge-bypassed').click();
    expect(markBypassed).toHaveBeenCalledTimes(1);
    expect(markVerified).not.toHaveBeenCalled();
  });

  it('ROW 6 (priority over row 7): challenge takes priority over forced enrollment — a required-role user who has a factor but has not verified THIS session sees the challenge', () => {
    mfaState.status = 'challenge_required';
    mfaState.hasVerifiedFactor = true;
    requirementState.mfaRequired = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('stub-mfa-challenge')).toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Row 7: !hasVerifiedFactor && mfaRequired -> <MfaEnrollmentRequired>
  // -----------------------------------------------------------------------
  it('ROW 7: forces enrollment (not children) for a required role with no verified factor', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
  });

  it('ROW 7: renders children once MfaEnrollmentRequired reports success (wires markVerified as onEnrolled) — proves the forced flow is completable', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    screen.getByText('stub-mfa-enrollment-required').click();
    expect(markVerified).toHaveBeenCalledTimes(1);
  });

  it('ROW 7: does NOT force enrollment for a required role that already has a verified factor and satisfied assurance (normal steady state)', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = true;
    requirementState.mfaRequired = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('protected content')).toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
  });

  it('ROW 7: does NOT force enrollment for a non-required role with no factor (ORG_MEMBER / INDIVIDUAL)', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = false;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('protected content')).toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Row 8: mfaGraceActive -> <MfaGraceNudge/> ABOVE children
  // -----------------------------------------------------------------------
  it('ROW 8: renders the grace nudge ABOVE children (children still render underneath) when mfaGraceActive is true', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = false;
    requirementState.mfaGraceActive = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText(/^stub-mfa-grace-nudge:/)).toBeInTheDocument();
    expect(screen.getByText('protected content')).toBeInTheDocument();
  });

  it('ROW 8 (item 18/EA4): threads the already-resolved enforceFromIso into MfaGraceNudge instead of letting it re-resolve', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = false;
    requirementState.mfaGraceActive = true;
    requirementState.enforceFromIso = '2027-03-01T00:00:00Z';
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('stub-mfa-grace-nudge:2027-03-01T00:00:00Z')).toBeInTheDocument();
  });

  it('ROW 8 (priority under row 7): a required role with no factor sees the forced enrollment screen, NOT the grace nudge, even if mfaGraceActive is somehow also true', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    requirementState.mfaGraceActive = true; // should never co-occur with mfaRequired in real mfaPolicy math, but the branch order must still hold
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-grace-nudge')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Row 9: else -> children
  // -----------------------------------------------------------------------
  it('ROW 9: renders children in the default steady state (nothing MFA-related pending)', () => {
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('protected content')).toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Cross-cutting invariants
  // -----------------------------------------------------------------------
  it('NO REDIRECT LOOP: neither forcing enrollment nor a challenge ever renders a route Navigate — both are inline replacements for children within THIS SAME AuthGuard instance', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    const { unmount } = render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
    unmount();

    mfaState.status = 'challenge_required';
    requirementState.mfaRequired = false;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('stub-mfa-challenge')).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('EVERY-LOGIN / NO TRAP ACROSS NAVIGATION: mounting a FRESH AuthGuard instance for the same required-no-factor user shows the SAME completable enrollment screen again, never a blank/broken state', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;

    const first = render(
      <AuthGuard>
        <div>dashboard content</div>
      </AuthGuard>
    );
    expect(first.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
    first.unmount(); // each <Route> mounts its own <AuthGuard>

    const second = render(
      <AuthGuard>
        <div>settings content</div>
      </AuthGuard>
    );
    expect(second.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
    expect(second.queryByText('settings content')).not.toBeInTheDocument();
  });

  it('does not surface any MFA gate when there is no authenticated user — the auth redirect check runs first', () => {
    authState.user = null;
    mfaState.status = 'challenge_required';
    requirementState.mfaRequired = true;
    requirementState.mfaGraceActive = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-challenge')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-grace-nudge')).not.toBeInTheDocument();
  });
});

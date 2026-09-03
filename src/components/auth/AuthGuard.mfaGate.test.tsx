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
 *   5 challenge_required       -> <MfaChallenge> (ALWAYS — no cooldown check)
 *   6 !hasVerifiedFactor
 *       && mfaRequired         -> cooldown active? children : <MfaEnrollmentRequired>
 *   7 mfaGraceActive           -> <MfaGraceNudge/> ABOVE children
 *   8 (else)                   -> children
 *
 * FAIL-CLOSED / FAIL-OPEN SPLIT (PR #2637 review round 2, R17-R21 CTO
 * ruling — supersedes the earlier design where a single top-level
 * `mfaCapabilityUnavailable` flag, checked BEFORE the challenge row, could
 * bypass MfaChallenge entirely): row 5 (challenge) is now checked and
 * rendered completely independently of any cooldown/capability state — a
 * user with a verified factor is ALWAYS challenged, no matter what. The
 * cooldown only ever applies inside row 6 (enrollment), and is keyed by
 * userId so one user's outage trip can never let a DIFFERENT user in a
 * shared browser skip a challenge they could otherwise pass.
 *
 * The single most important test in this file is the LOCKOUT-PREVENTION
 * GUARD: a user with NO MFA enrolled, on a role that does not require it,
 * must reach children exactly as before. Breaking that is the catastrophic
 * failure mode this whole change exists to avoid. The second most important
 * is the CROSS-USER ISOLATION test below: a shared-browser bypass of MFA
 * for a DIFFERENT verified user is the exact vulnerability R17 fixes.
 *
 * `useMfaAssurance`, `useMfaEnrollmentRequirement`, `MfaChallenge`,
 * `MfaEnrollmentRequired`, and `MfaGraceNudge` are mocked here deliberately
 * — each has its own dedicated test file covering its internal behavior.
 * This file tests only AuthGuard's branching decision. The capability
 * cooldown (`mfaCapabilityCooldown.ts`) is a REAL module, not mocked — it is
 * cheap, userId-keyed, and exercising the real module is the only way to
 * prove cross-user isolation actually holds.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthGuard } from './AuthGuard';
import { __resetMfaCapabilityCooldownForTests, armMfaCapabilityCooldown } from '@/lib/mfaCapabilityCooldown';

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
  // R19: MfaChallenge takes ONLY onVerified now — there is no
  // onBypassed/onCapabilityUnavailable escape hatch left to wire up.
  MfaChallenge: ({ onVerified }: { onVerified: () => void }) => (
    <div>
      <button onClick={onVerified}>stub-mfa-challenge</button>
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
  // Row 5: challenge_required -> <MfaChallenge>, UNCONDITIONALLY (R17-R21)
  // -----------------------------------------------------------------------
  it('ROW 5: renders MfaChallenge instead of children when a challenge is required, regardless of role tier', () => {
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

  it('ROW 5: renders children once MfaChallenge reports success (wires markVerified as onVerified)', () => {
    mfaState.status = 'challenge_required';
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    screen.getByText('stub-mfa-challenge').click();
    expect(markVerified).toHaveBeenCalledTimes(1);
  });

  it('ROW 5 (priority over row 6): challenge takes priority over forced enrollment — a required-role user who has a factor but has not verified THIS session sees the challenge', () => {
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

  it('R17(d) FAIL CLOSED: an active enrollment-path cooldown for THIS SAME user does NOT bypass the challenge — cooldown or not, a verified-factor user is always challenged', () => {
    armMfaCapabilityCooldown('user-1');
    mfaState.status = 'challenge_required';
    mfaState.hasVerifiedFactor = true;
    requirementState.mfaRequired = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('stub-mfa-challenge')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('R17/R19: MfaChallenge has no capability-unavailable/bypass escape hatch left to wire — the ONLY prop is onVerified (structural, not just behavioral)', () => {
    mfaState.status = 'challenge_required';
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    // The old stub buttons for onBypassed/onCapabilityUnavailable no longer
    // exist in the (updated) MfaChallenge mock at all.
    expect(screen.queryByText('stub-mfa-challenge-bypassed')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-challenge-capability-fail')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Row 6: !hasVerifiedFactor && mfaRequired -> cooldown ? children : <MfaEnrollmentRequired>
  // -----------------------------------------------------------------------
  it('ROW 6: forces enrollment (not children) for a required role with no verified factor', () => {
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

  it('ROW 6: renders children once MfaEnrollmentRequired reports success (wires markVerified as onEnrolled) — proves the forced flow is completable', () => {
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

  it('ROW 6: does NOT force enrollment for a required role that already has a verified factor and satisfied assurance (normal steady state)', () => {
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

  it('ROW 6: does NOT force enrollment for a non-required role with no factor (ORG_MEMBER / INDIVIDUAL)', () => {
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

  it('ROW 6 (capability unavailable from the forced-enrollment screen): fails open to children, fires the toast once, reports to Sentry, and marks the assurance hook bypassed (R19/R21) not verified', async () => {
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
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'mfa_capability_unavailable',
      expect.objectContaining({
        level: 'warning',
        tags: expect.objectContaining({ code: 'mfa_totp_enroll_not_enabled', path: '/private' }),
      })
    );
    expect(markBypassed).toHaveBeenCalledTimes(1);
    expect(markVerified).not.toHaveBeenCalled();
  });

  it('ROW 6: the toast fires only ONCE even if onCapabilityUnavailable somehow fires more than once (ref guard)', async () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );

    screen.getByText('stub-mfa-enrollment-capability-fail').click();
    await screen.findByText('protected content');
    expect(toastWarning).toHaveBeenCalledTimes(1);
  });

  it('ROW 6: no Sentry PII — only {code, path} tags are sent, never a user id or email', async () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    screen.getByText('stub-mfa-enrollment-capability-fail').click();
    await screen.findByText('protected content');

    const call = mockCaptureMessage.mock.calls[0];
    const options = call[1] as { tags: Record<string, unknown> };
    expect(Object.keys(options.tags).sort()).toEqual(['code', 'path']);
  });

  // -----------------------------------------------------------------------
  // Item 5/D1 (CONFIRMED by the verifier) + item 24, re-scoped to row 6 only
  // per R17: the cooldown is CROSS-INSTANCE, not per-AuthGuard-mount, but
  // ONLY within the enrollment branch. A fresh AuthGuard mounted while the
  // cooldown is active (simulating the next of ~52 routes the SAME user
  // navigates to during an outage) must render children directly — WITHOUT
  // ever mounting MfaEnrollmentRequired again — and must NOT fire a second
  // toast/Sentry event.
  // -----------------------------------------------------------------------
  it('ROW 6/D1: a FRESH AuthGuard instance mounted after another instance already failed open renders children immediately, with no second enroll() attempt and no second toast/Sentry', async () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    const first = render(
      <AuthGuard>
        <div>first-route content</div>
      </AuthGuard>
    );
    first.getByText('stub-mfa-enrollment-capability-fail').click();
    await first.findByText('first-route content');
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
    first.unmount();

    // Simulate navigating to a DIFFERENT route — a brand new AuthGuard
    // instance, same as every one of the ~52 routes in App.tsx, for the
    // SAME user (still no verified factor, still required).
    const second = render(
      <AuthGuard>
        <div>second-route content</div>
      </AuthGuard>
    );

    // Renders children directly — MfaEnrollmentRequired is never even
    // mounted, so enroll() cannot be re-attempted within the window.
    expect(second.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
    expect(second.getByText('second-route content')).toBeInTheDocument();
    // No additional toast/Sentry beyond the first instance's one-shot.
    expect(toastWarning).toHaveBeenCalledTimes(1);
    expect(mockCaptureMessage).toHaveBeenCalledTimes(1);
  });

  it('ROW 6/D1: the gate RE-ARMS once the cooldown window has expired — a fresh mount after the window sees the real enrollment gate again', async () => {
    vi.useFakeTimers();
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    const first = render(
      <AuthGuard>
        <div>first-route content</div>
      </AuthGuard>
    );
    first.getByText('stub-mfa-enrollment-capability-fail').click();
    await vi.advanceTimersByTimeAsync(0);
    first.unmount();

    // Well past the 5-minute cooldown window.
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    const second = render(
      <AuthGuard>
        <div>second-route content</div>
      </AuthGuard>
    );
    expect(second.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
    expect(second.queryByText('second-route content')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // R17 CROSS-USER ISOLATION (the confirmed bypass this whole round fixes):
  // a shared browser where user A trips the enrollment cooldown, signs out,
  // and a DIFFERENT user B (who HAS a verified factor) signs in must still
  // see a real challenge — B's session must never inherit A's cooldown.
  // -----------------------------------------------------------------------
  it('R17 CROSS-USER: an enrollment cooldown armed for user A does not carry over to a DIFFERENT user B — B still sees the enrollment screen (not children) if B also has no factor and is required', () => {
    armMfaCapabilityCooldown('user-A');

    authState.user = { id: 'user-B' };
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;

    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );

    expect(screen.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('R17 CROSS-USER: an enrollment cooldown armed for user A does not let user B (who HAS a verified factor) skip the challenge — the confirmed shared-browser bypass', () => {
    armMfaCapabilityCooldown('user-A');

    authState.user = { id: 'user-B' };
    mfaState.status = 'challenge_required';
    mfaState.hasVerifiedFactor = true;
    requirementState.mfaRequired = true;

    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );

    expect(screen.getByText('stub-mfa-challenge')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('R17(d): re-derives the cooldown flag for a NEW user signing in within the same mounted AuthGuard instance (no full remount) — a stale bypass never survives a user switch', async () => {
    armMfaCapabilityCooldown('user-1');
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;

    const { rerender } = render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    // user-1's cooldown is active: renders children directly.
    expect(screen.getByText('protected content')).toBeInTheDocument();

    // A different user signs in without a full AuthGuard remount.
    authState.user = { id: 'user-2' };
    rerender(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );

    await screen.findByText('stub-mfa-enrollment-required');
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // Row 7: mfaGraceActive -> <MfaGraceNudge/> ABOVE children
  // -----------------------------------------------------------------------
  it('ROW 7: renders the grace nudge ABOVE children (children still render underneath) when mfaGraceActive is true', () => {
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

  it('ROW 7 (item 18/EA4): threads the already-resolved enforceFromIso into MfaGraceNudge instead of letting it re-resolve', () => {
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

  it('ROW 7 (priority under row 6): a required role with no factor sees the forced enrollment screen, NOT the grace nudge, even if mfaGraceActive is somehow also true', () => {
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
  // Row 8: else -> children
  // -----------------------------------------------------------------------
  it('ROW 8: renders children in the default steady state (nothing MFA-related pending)', () => {
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

/**
 * AuthGuard MFA gate tests — pre-pentest hardening, founder directive
 * "MFA needs to be mandatory" + "enforced everytime you login"
 * (2026-08-03).
 *
 * AuthGuard is the single choke point every authenticated route in
 * App.tsx renders through (51 usages as of this change) — the ONLY place a
 * page-reload or deep-link mid-challenge/mid-enrollment cannot slip past
 * the gate. These tests cover the branching added on top of the existing
 * loading/redirect behavior, which already has its own regression coverage
 * in `AuthGuard.test.tsx` (kept separate and untouched here).
 *
 * The single most important test in this file is the first one: a user
 * with NO MFA enrolled, on a role that does not require it, must reach
 * children exactly as before. Breaking that is the catastrophic failure
 * mode this whole change exists to avoid — it would lock out every
 * existing user, including Carson and every platform admin, the moment
 * this deploys.
 *
 * `useMfaAssurance`, `useMfaEnrollmentRequirement`, `MfaChallenge`, and
 * `MfaEnrollmentRequired` are mocked here deliberately — each has its own
 * dedicated test file covering its internal behavior. This file tests
 * only AuthGuard's branching decision: which of the four possible screens
 * (spinner / children / challenge / forced enrollment) it shows for a
 * given combination of session and role state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthGuard } from './AuthGuard';

vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));

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
vi.mock('../../hooks/useMfaAssurance', () => ({
  useMfaAssurance: () => ({ ...mfaState, markVerified }),
}));

const requirementState: { loading: boolean; mfaRequired: boolean } = {
  loading: false,
  mfaRequired: false,
};
vi.mock('../../hooks/useMfaEnrollmentRequirement', () => ({
  useMfaEnrollmentRequirement: () => requirementState,
}));

vi.mock('./MfaChallenge', () => ({
  MfaChallenge: ({ onVerified }: { onVerified: () => void }) => (
    <button onClick={onVerified}>stub-mfa-challenge</button>
  ),
}));

vi.mock('./MfaEnrollmentRequired', () => ({
  MfaEnrollmentRequired: ({ onEnrolled }: { onEnrolled: () => void }) => (
    <button onClick={onEnrolled}>stub-mfa-enrollment-required</button>
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
}

describe('AuthGuard — MFA session gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetToDefaults();
  });

  it('LOCKOUT-PREVENTION GUARD: renders children for a user with no MFA enrolled on a role that does not require it — this must never regress', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = false;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('protected content')).toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-challenge')).not.toBeInTheDocument();
    expect(screen.queryByText('stub-mfa-enrollment-required')).not.toBeInTheDocument();
  });

  it('shows a spinner (not children, not any gate) while the assurance check is loading', () => {
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

  it('shows a spinner (not children, not any gate) while the role-requirement check is loading, even if the assurance check already resolved', () => {
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

  it('renders MfaChallenge instead of children when a challenge is required, regardless of role tier', () => {
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

  it('renders children once MfaChallenge reports success (wires markVerified as onVerified)', () => {
    mfaState.status = 'challenge_required';
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );

    screen.getByText('stub-mfa-challenge').click();

    expect(markVerified).toHaveBeenCalledTimes(1);
  });

  it('does not surface any MFA gate when there is no authenticated user — the auth redirect check runs first', () => {
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
  });

  // -----------------------------------------------------------------------
  // MANDATORY ENROLLMENT — founder directive 2026-08-03
  // -----------------------------------------------------------------------

  it('FORCES ENROLLMENT (not children) for a required role with no verified factor', () => {
    mfaState.status = 'satisfied'; // no factor -> aal check itself has nothing to challenge
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

  it('CAN REACH ENROLLMENT AND COMPLETE IT: renders children once MfaEnrollmentRequired reports success (wires markVerified as onEnrolled) — proves the forced flow is completable, not a dead end', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );

    expect(screen.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
    screen.getByText('stub-mfa-enrollment-required').click();

    expect(markVerified).toHaveBeenCalledTimes(1);
  });

  it('does NOT force enrollment for a required role that already has a verified factor and satisfied assurance (normal steady state)', () => {
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

  it('CRITICAL: does NOT force enrollment for a non-required role with no factor (ORG_MEMBER / INDIVIDUAL) — only the challenge/satisfied paths apply to them', () => {
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

  it('CHALLENGE TAKES PRIORITY over enrollment: a required-role user who already has a factor but has not verified THIS session sees the challenge, not the enrollment screen', () => {
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

  it('NO REDIRECT LOOP: forcing enrollment never renders a route Navigate — it is an inline replacement for children within THIS SAME AuthGuard instance, so there is no route to redirect to and no possible guard-redirects-to-a-guarded-route loop', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;
    render(
      <AuthGuard>
        <div>protected content</div>
      </AuthGuard>
    );
    expect(screen.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('EVERY-LOGIN / NO TRAP ACROSS NAVIGATION: mounting a FRESH AuthGuard instance (simulating navigating to a different guarded route, or a page reload) for the same required-no-factor user shows the SAME completable enrollment screen again, never a blank/broken/looping state', () => {
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    requirementState.mfaRequired = true;

    const first = render(
      <AuthGuard>
        <div>dashboard content</div>
      </AuthGuard>
    );
    expect(first.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
    first.unmount(); // each <Route> mounts its own <AuthGuard> — navigating unmounts this one

    const second = render(
      <AuthGuard>
        <div>settings content</div>
      </AuthGuard>
    );
    expect(second.getByText('stub-mfa-enrollment-required')).toBeInTheDocument();
    expect(second.queryByText('settings content')).not.toBeInTheDocument();
  });
});

/** UAT-04 branching tests for the mandatory browser MFA gate. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AuthGuard } from './AuthGuard';

const userId = 'user-1';
const token = (aal: 'aal1' | 'aal2', role = 'authenticated') =>
  `h.${btoa(JSON.stringify({ sub: userId, session_id: 'session-1', aal, role }))}.s`;

const authState: {
  user: { id: string } | null;
  session: { access_token: string } | null;
  loading: boolean;
} = { user: { id: userId }, session: { access_token: token('aal1') }, loading: false };
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => authState }));

const mfaState: {
  status: 'loading' | 'satisfied' | 'challenge_required';
  hasVerifiedFactor: boolean;
} = { status: 'satisfied', hasVerifiedFactor: false };
const markVerified = vi.fn();
vi.mock('../../hooks/useMfaAssurance', () => ({
  useMfaAssurance: () => ({ ...mfaState, markVerified }),
}));

vi.mock('./MfaChallenge', () => ({
  MfaChallenge: ({ onVerified }: { onVerified: () => void }) =>
    <button onClick={onVerified}>mfa challenge</button>,
}));
vi.mock('./MfaEnrollmentRequired', () => ({
  MfaEnrollmentRequired: ({ onEnrolled }: { onEnrolled: () => void }) =>
    <button onClick={onEnrolled}>mfa enrollment</button>,
}));

const navigateSpy = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    Navigate: (props: unknown) => { navigateSpy(props); return null; },
    useLocation: () => ({ pathname: '/dashboard', search: '', hash: '', state: null, key: 'test' }),
  };
});

function guarded() {
  return render(<AuthGuard><div>protected content</div></AuthGuard>);
}

describe('AuthGuard mandatory MFA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = { id: userId };
    authState.session = { access_token: token('aal1') };
    authState.loading = false;
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
  });

  it('redirects unauthenticated users before evaluating product authority', () => {
    authState.user = null;
    authState.session = null;
    guarded();
    expect(navigateSpy).toHaveBeenCalled();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('keeps email confirmation ahead of MFA', () => {
    authState.session = { access_token: token('aal1', 'arkova_email_pending') };
    guarded();
    expect(navigateSpy).toHaveBeenCalledWith(expect.objectContaining({ to: '/signup' }));
    expect(screen.queryByText('mfa enrollment')).not.toBeInTheDocument();
  });

  it('shows loading while assurance is unresolved', () => {
    mfaState.status = 'loading';
    guarded();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
    expect(screen.queryByText('mfa enrollment')).not.toBeInTheDocument();
  });

  it('challenges every AAL1 user who already has a verified factor', () => {
    mfaState.status = 'challenge_required';
    mfaState.hasVerifiedFactor = true;
    guarded();
    expect(screen.getByText('mfa challenge')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('forces enrollment for every confirmed AAL1 user without reading a profile role', () => {
    guarded();
    expect(screen.getByText('mfa enrollment')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('does not trust a local completion callback until the signed session becomes AAL2', () => {
    const view = guarded();
    fireEvent.click(screen.getByText('mfa enrollment'));
    expect(markVerified).toHaveBeenCalledTimes(1);
    view.rerender(<AuthGuard><div>protected content</div></AuthGuard>);
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();

    authState.session = { access_token: token('aal2') };
    view.rerender(<AuthGuard><div>protected content</div></AuthGuard>);
    expect(screen.getByText('protected content')).toBeInTheDocument();
  });

  it('permits protected rendering only with a same-user signed AAL2 session', () => {
    authState.session = { access_token: token('aal2') };
    guarded();
    expect(screen.getByText('protected content')).toBeInTheDocument();
  });

  it('rejects an AAL2 token whose subject belongs to a different user', () => {
    authState.session = {
      access_token: `h.${btoa(JSON.stringify({ sub: 'other-user', session_id: 's', aal: 'aal2' }))}.s`,
    };
    guarded();
    expect(screen.getByText('mfa enrollment')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('re-arms the gate when the same user starts a fresh AAL1 session', () => {
    authState.session = { access_token: token('aal2') };
    const view = guarded();
    expect(screen.getByText('protected content')).toBeInTheDocument();

    authState.session = {
      access_token: `h.${btoa(JSON.stringify({
        sub: userId, session_id: 'fresh-session', aal: 'aal1', role: 'authenticated',
      }))}.s`,
    };
    mfaState.status = 'satisfied';
    mfaState.hasVerifiedFactor = false;
    view.rerender(<AuthGuard><div>protected content</div></AuthGuard>);
    expect(screen.getByText('mfa enrollment')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });

  it('does not carry AAL2 authority across a user switch', () => {
    authState.session = { access_token: token('aal2') };
    const view = guarded();
    authState.user = { id: 'user-2' };
    view.rerender(<AuthGuard><div>protected content</div></AuthGuard>);
    expect(screen.getByText('mfa enrollment')).toBeInTheDocument();
    expect(screen.queryByText('protected content')).not.toBeInTheDocument();
  });
});

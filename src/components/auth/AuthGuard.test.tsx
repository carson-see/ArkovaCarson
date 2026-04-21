/**
 * AuthGuard tests — BUG-UAT-LR1-02 regression coverage.
 *
 * Original bug: after voluntary sign-out, AuthGuard flashed the
 * "Please sign in to access that page" toast — the same toast used for
 * deep-link unauthorized access. The fix suppresses the toast when
 * `arkova_signed_out` sessionStorage flag is set (survives the post-signout
 * navigation / reload) OR when `hadUser` ref indicates a same-mount
 * authenticated→unauthenticated transition.
 *
 * The uat report (`docs/bugs/uat_launch_readiness_1.md`) called out that
 * no regression test existed. This file plugs that gap.
 *
 * Note: `<Navigate>` from react-router is mocked to a no-op element to
 * keep the test narrowly focused on the toast-emit logic — otherwise
 * the full router redirect loop inflates memory on repeated test runs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { AuthGuard } from './AuthGuard';

const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: { info: (msg: string) => toastInfo(msg) },
}));

const authState: { user: { id: string } | null; loading: boolean } = {
  user: null,
  loading: false,
};
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => authState,
}));

// Neutralize Navigate + useLocation — we're testing the effect, not router plumbing.
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    Navigate: () => null,
    useLocation: () => ({ pathname: '/private', search: '', hash: '', state: null, key: 'test' }),
  };
});

describe('AuthGuard', () => {
  beforeEach(() => {
    toastInfo.mockClear();
    authState.user = null;
    authState.loading = false;
    sessionStorage.clear();
  });

  it('shows the redirect toast for unauthorized access when no prior session and no sign-out flag', () => {
    render(<AuthGuard><div>private</div></AuthGuard>);
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it('suppresses the redirect toast when the arkova_signed_out sessionStorage flag is set (BUG-UAT-LR1-02)', () => {
    sessionStorage.setItem('arkova_signed_out', '1');
    render(<AuthGuard><div>private</div></AuthGuard>);
    expect(toastInfo).not.toHaveBeenCalled();
    // Flag must be consumed so a subsequent genuine redirect still toasts.
    expect(sessionStorage.getItem('arkova_signed_out')).toBeNull();
  });

  it('does not fire the toast while auth is still loading', () => {
    authState.loading = true;
    render(<AuthGuard><div>private</div></AuthGuard>);
    expect(toastInfo).not.toHaveBeenCalled();
  });
});

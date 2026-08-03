/**
 * MfaEnrollmentRequired Component Tests — mandatory MFA, founder directive.
 *
 * Rendered by AuthGuard, in place of protected children, when the user's
 * role requires MFA (ORG_ADMIN / platform admin) and they have no
 * verified factor yet. Non-skippable by design — there is no "later"
 * affordance — but MUST remain completable: this screen IS "reaching
 * enrollment" for a user who has never enrolled. A user who cannot
 * complete it right now can still Sign out (lockout safety valve).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MfaEnrollmentRequired } from './MfaEnrollmentRequired';

const mockEnroll = vi.fn();
const mockChallenge = vi.fn();
const mockVerify = vi.fn();
const mockSignOut = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      mfa: {
        enroll: (...args: unknown[]) => mockEnroll(...args),
        challenge: (...args: unknown[]) => mockChallenge(...args),
        verify: (...args: unknown[]) => mockVerify(...args),
      },
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ signOut: mockSignOut }),
}));

describe('MfaEnrollmentRequired', () => {
  const onEnrolled = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnroll.mockResolvedValue({
      data: {
        id: 'factor-new',
        type: 'totp',
        totp: {
          qr_code: 'data:image/svg+xml;base64,test',
          secret: 'JBSWY3DPEHPK3PXP',
          uri: 'otpauth://totp/Arkova:test@test.com?secret=JBSWY3DPEHPK3PXP',
        },
      },
      error: null,
    });
  });

  it('CAN REACH ENROLLMENT: starts enrollment automatically and shows the QR code — this screen IS the completable path for a user with no factor', async () => {
    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} />);

    await waitFor(() => {
      expect(mockEnroll).toHaveBeenCalledWith({ factorType: 'totp' });
    });
    expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
  });

  it('is non-skippable: renders no "skip" / "later" / "remind me" affordance', async () => {
    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
    });

    expect(screen.queryByText(/skip/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/later/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/remind me/i)).not.toBeInTheDocument();
  });

  it('completes enrollment (challenge + verify) and calls onEnrolled — the user reaches aal2 in THIS same session, not just "enrolled for next time"', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/000000/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(mockChallenge).toHaveBeenCalledWith({ factorId: 'factor-new' });
    });
    expect(mockVerify).toHaveBeenCalledWith({
      factorId: 'factor-new',
      challengeId: 'challenge-1',
      code: '123456',
    });
    await waitFor(() => {
      expect(onEnrolled).toHaveBeenCalledTimes(1);
    });
  });

  it('shows an error and does NOT call onEnrolled when verification fails', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'Invalid code' } });

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/000000/i), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid code/i)).toBeInTheDocument();
    });
    expect(onEnrolled).not.toHaveBeenCalled();
  });

  it('LOCKOUT ESCAPE HATCH: offers a working sign-out affordance so a user without their device right now is never permanently trapped', async () => {
    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('shows a start error (with sign-out still available) when enroll() itself fails, without crashing or calling onEnrolled', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: { message: 'enroll failed' } });

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} />);

    await waitFor(() => {
      expect(screen.getByText(/enroll failed/i)).toBeInTheDocument();
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});

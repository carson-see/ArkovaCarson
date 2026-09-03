/**
 * MfaEnrollmentRequired Component Tests — SCRUM-3167 mandatory MFA.
 *
 * Restored from PR #1973 (3572fcd6e) — founder directive "yes it needs to
 * be mandatory" — and hardened per CTO ruling A4-2: an enroll() failure of
 * ANY KIND (known code, unknown code, thrown exception, or a hung request
 * that never resolves) calls `onCapabilityUnavailable(code)` rather than
 * showing an error the user cannot act on. There is no allowlist of
 * "acceptable" enroll error codes — every failure fails open, because a
 * broken enrollment platform must never permanently wall out an
 * otherwise-authenticated ORG_ADMIN or platform admin (see AuthGuard.tsx).
 *
 * Also verifies the unique-friendly-name enrollment call (Amendment A2 —
 * avoids `mfa_factor_name_conflict` against the stale unverified factor
 * already on prod for one platform admin).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

const VALID_ENROLL_RESPONSE = {
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
};

describe('MfaEnrollmentRequired', () => {
  const onEnrolled = vi.fn();
  const onCapabilityUnavailable = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnroll.mockResolvedValue(VALID_ENROLL_RESPONSE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('CAN REACH ENROLLMENT: starts enrollment automatically with a unique friendly name and shows the QR code', async () => {
    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(mockEnroll).toHaveBeenCalledTimes(1);
    });
    const call = mockEnroll.mock.calls[0][0];
    expect(call.factorType).toBe('totp');
    expect(call.friendlyName).toMatch(/^Authenticator \d{4}-\d{2}-\d{2}-[a-z0-9]+$/);

    expect(screen.getByTestId('mfa-enrollment-required')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-enrollment-qr')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-enrollment-secret')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
  });

  it('two mounts get two DIFFERENT friendly names (uniqueness, not just format)', async () => {
    const { unmount } = render(
      <MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />
    );
    await waitFor(() => expect(mockEnroll).toHaveBeenCalledTimes(1));
    const firstName = mockEnroll.mock.calls[0][0].friendlyName;
    unmount();

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);
    await waitFor(() => expect(mockEnroll).toHaveBeenCalledTimes(2));
    const secondName = mockEnroll.mock.calls[1][0].friendlyName;

    expect(secondName).not.toBe(firstName);
  });

  it('is non-skippable: renders no "skip" / "later" / "remind me" affordance', async () => {
    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    expect(screen.queryByText(/skip/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/later/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/remind me/i)).not.toBeInTheDocument();
  });

  it('completes enrollment (challenge + verify) and calls onEnrolled — the user reaches aal2 in THIS same session', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

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
    expect(onCapabilityUnavailable).not.toHaveBeenCalled();
  });

  it('shows an inline error and does NOT call onEnrolled when the verification CODE is wrong (user-fixable, not a capability failure)', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'Invalid code' } });

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(/invalid code/i);
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(onCapabilityUnavailable).not.toHaveBeenCalled();
  });

  it('LOCKOUT ESCAPE HATCH: offers a working sign-out affordance so a user without their device right now is never permanently trapped', async () => {
    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mfa-enrollment-signout'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // FAIL-OPEN ON ANY ENROLL ERROR (CTO ruling A4-2) — no allowlist of codes.
  // -----------------------------------------------------------------------

  it('FAIL-OPEN: a known enroll error code (mfa_totp_enroll_not_enabled) calls onCapabilityUnavailable with that code; no QR/verify form renders', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: { message: 'MFA enroll is disabled for TOTP', code: 'mfa_totp_enroll_not_enabled' } });

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('mfa_totp_enroll_not_enabled');
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-qr')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mfa-enrollment-code')).not.toBeInTheDocument();
  });

  it('FAIL-OPEN: an UNKNOWN enroll error code still calls onCapabilityUnavailable — no allowlist', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: { message: 'something new broke', code: 'some_future_error_code' } });

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('some_future_error_code');
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-qr')).not.toBeInTheDocument();
  });

  it('FAIL-OPEN: an error with no code at all reports "unknown"', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    });
  });

  it('FAIL-OPEN: missing data with no error object also calls onCapabilityUnavailable', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: null });

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    });
  });

  it('FAIL-OPEN: a THROWN TypeError during enroll() calls onCapabilityUnavailable("unknown"), never crashes; no QR/verify form renders', async () => {
    mockEnroll.mockRejectedValueOnce(new TypeError('unexpected shape'));

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-qr')).not.toBeInTheDocument();
  });

  it('FAIL-OPEN: a HUNG enroll() call that never resolves times out to onCapabilityUnavailable("unknown") instead of spinning forever; no QR/verify form renders', async () => {
    vi.useFakeTimers();
    const never = new Promise(() => {});
    mockEnroll.mockReturnValueOnce(never);

    render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);

    expect(screen.queryByTestId('mfa-enrollment-qr')).not.toBeInTheDocument();
    expect(onCapabilityUnavailable).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-qr')).not.toBeInTheDocument();
  });
});

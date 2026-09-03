/**
 * MfaEnrollmentRequired Component Tests — SCRUM-3167 mandatory MFA,
 * hardened again per PR #2637 code review.
 *
 * CHANGES FROM THE PRIOR VERSION (this batch):
 * - `handleVerify`'s challenge()/verify() calls are now wrapped in
 *   try/catch AND raced against the shared 8s timeout (items 4/E4/EA1) —
 *   previously neither call was try/caught, so a thrown exception left
 *   `busy=true` forever; and neither was timed out, so a hang spun forever.
 *   Non-wrong-code errors now route to `onCapabilityUnavailable` via the
 *   shared `classifyMfaError` (this was the EA1 gap: a platform blip during
 *   the post-enrollment verify step used to strand a mandatorily-enrolling
 *   admin on a generic inline error with no escape route).
 * - `randomSuffix()` now comes from `crypto.randomUUID().slice(0, 8)`
 *   directly (R9, PR #2637 review round 2 — replaces the bespoke
 *   `randomSuffixHex()` helper, now deleted; SonarCloud typescript:S2245,
 *   item 25 still holds — this is CSPRNG-backed, not `Math.random()`).
 * - The enroll timeout is raised from 8s to 15s, and a LATE-resolving
 *   `enroll()` (one that loses the timeout race but later succeeds
 *   server-side) is best-effort unenrolled so it never becomes an orphaned,
 *   invisible factor (item 31).
 * - The code input carries `inputMode="numeric"`, `autoComplete="one-time-code"`,
 *   `pattern="[0-9]*"` (item 8/D3); the QR `alt` text and code placeholder
 *   now come from `copy.ts` (item 10/C1/C2).
 * - "Sign out" is disabled while `starting` or `busy` (item 6/D8), and a
 *   `handleVerify` result arriving after unmount is ignored (item 6/D2).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MfaEnrollmentRequired } from './MfaEnrollmentRequired';
import { MFA_ENROLLMENT_REQUIRED_LABELS } from '@/lib/copy';

const mockEnroll = vi.fn();
const mockChallenge = vi.fn();
const mockVerify = vi.fn();
const mockUnenroll = vi.fn();
const mockSignOut = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      mfa: {
        enroll: (...args: unknown[]) => mockEnroll(...args),
        challenge: (...args: unknown[]) => mockChallenge(...args),
        verify: (...args: unknown[]) => mockVerify(...args),
        unenroll: (...args: unknown[]) => mockUnenroll(...args),
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
    mockUnenroll.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderScreen() {
    return render(<MfaEnrollmentRequired onEnrolled={onEnrolled} onCapabilityUnavailable={onCapabilityUnavailable} />);
  }

  it('CAN REACH ENROLLMENT: starts enrollment automatically with a unique friendly name and shows the QR code', async () => {
    renderScreen();

    await waitFor(() => {
      expect(mockEnroll).toHaveBeenCalledTimes(1);
    });
    const call = mockEnroll.mock.calls[0][0];
    expect(call.factorType).toBe('totp');
    expect(call.friendlyName).toMatch(/^Authenticator \d{4}-\d{2}-\d{2}-[0-9a-f]+$/);

    expect(screen.getByTestId('mfa-enrollment-required')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-enrollment-qr')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-enrollment-secret')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
  });

  it('the QR alt text and code placeholder come from copy.ts (item 10/C1/C2)', async () => {
    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-qr')).toBeInTheDocument();
    });

    const img = screen.getByAltText(MFA_ENROLLMENT_REQUIRED_LABELS.QR_ALT);
    expect(img).toBeInTheDocument();
    expect(screen.getByTestId('mfa-enrollment-code')).toHaveAttribute(
      'placeholder',
      MFA_ENROLLMENT_REQUIRED_LABELS.CODE_PLACEHOLDER,
    );
  });

  it('the code input carries the one-time-code UX attributes (item 8/D3)', async () => {
    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    const input = screen.getByTestId('mfa-enrollment-code');
    expect(input).toHaveAttribute('inputMode', 'numeric');
    expect(input).toHaveAttribute('autoComplete', 'one-time-code');
    expect(input).toHaveAttribute('pattern', '[0-9]*');
  });

  it('two mounts get two DIFFERENT friendly names (uniqueness, not just format)', async () => {
    const { unmount } = renderScreen();
    await waitFor(() => expect(mockEnroll).toHaveBeenCalledTimes(1));
    const firstName = mockEnroll.mock.calls[0][0].friendlyName;
    unmount();

    renderScreen();
    await waitFor(() => expect(mockEnroll).toHaveBeenCalledTimes(2));
    const secondName = mockEnroll.mock.calls[1][0].friendlyName;

    expect(secondName).not.toBe(firstName);
  });

  it('is non-skippable: renders no "skip" / "later" / "remind me" affordance', async () => {
    renderScreen();

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

    renderScreen();

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
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'Invalid code', code: 'mfa_verification_failed' } });

    renderScreen();

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

  // -----------------------------------------------------------------------
  // EA1 (PR #2637 review): a PLATFORM failure during the post-enroll verify
  // step used to strand the user on a generic inline error with no escape
  // — now it routes to onCapabilityUnavailable, same as MfaChallenge.
  // -----------------------------------------------------------------------

  it('ITEM 4/EA1: a PLATFORM error on challenge() (unrecognized code) calls onCapabilityUnavailable, not an inline error', async () => {
    mockChallenge.mockResolvedValueOnce({ data: null, error: { message: 'service down', code: 'mfa_totp_verify_not_enabled' } });

    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('mfa_totp_verify_not_enabled');
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-error')).not.toBeInTheDocument();
  });

  it('ITEM 4/EA1: a PLATFORM error on verify() calls onCapabilityUnavailable', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'bad request', code: 'validation_failed' } });

    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('validation_failed');
    });
  });

  it('ITEM 4/E4: a THROWN exception during handleVerify calls onCapabilityUnavailable, resets busy, never crashes', async () => {
    mockChallenge.mockRejectedValueOnce(new TypeError('boom'));

    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    });
    expect(screen.getByTestId('mfa-enrollment-submit')).not.toBeDisabled();
  });

  it('ITEM 4/EA6: a HUNG challenge() call during handleVerify times out to onCapabilityUnavailable("unknown")', async () => {
    vi.useFakeTimers();
    mockChallenge.mockReturnValueOnce(new Promise(() => {}));

    renderScreen();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
  });

  it('LOCKOUT ESCAPE HATCH: offers a working sign-out affordance so a user without their device right now is never permanently trapped', async () => {
    renderScreen();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mfa-enrollment-signout'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('ITEM 6/D8: Sign out is disabled while enrollment is starting', () => {
    mockEnroll.mockReturnValueOnce(new Promise(() => {}));
    renderScreen();

    expect(screen.getByTestId('mfa-enrollment-signout')).toBeDisabled();
  });

  it('ITEM 6/D8: Sign out is disabled while a verify submit is in flight', async () => {
    let resolveChallenge!: (v: { data: { id: string } | null; error: null }) => void;
    mockChallenge.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveChallenge = resolve;
      })
    );

    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-signout')).toBeDisabled();
    });

    resolveChallenge({ data: { id: 'challenge-1' }, error: null });
  });

  it('ITEM 6/D2: ignores a late-arriving verify result after unmount', async () => {
    let resolveVerify!: (v: { data: unknown; error: null }) => void;
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveVerify = resolve;
      })
    );

    const { unmount } = renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    unmount();
    resolveVerify({ data: { session: {} }, error: null });
    await Promise.resolve();
    await Promise.resolve();

    expect(onEnrolled).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // FAIL-OPEN ON ANY ENROLL ERROR (CTO ruling A4-2) — no allowlist of codes.
  // -----------------------------------------------------------------------

  it('FAIL-OPEN: a known enroll error code (mfa_totp_enroll_not_enabled) calls onCapabilityUnavailable with that code; no QR/verify form renders', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: { message: 'MFA enroll is disabled for TOTP', code: 'mfa_totp_enroll_not_enabled' } });

    renderScreen();

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('mfa_totp_enroll_not_enabled');
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-qr')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mfa-enrollment-code')).not.toBeInTheDocument();
  });

  it('FAIL-OPEN: an UNKNOWN enroll error code still calls onCapabilityUnavailable — no allowlist', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: { message: 'something new broke', code: 'some_future_error_code' } });

    renderScreen();

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('some_future_error_code');
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-qr')).not.toBeInTheDocument();
  });

  it('FAIL-OPEN: an error with no code at all reports "unknown"', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    renderScreen();

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    });
  });

  it('FAIL-OPEN: missing data with no error object also calls onCapabilityUnavailable', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: null });

    renderScreen();

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    });
  });

  it('FAIL-OPEN: a THROWN TypeError during enroll() calls onCapabilityUnavailable("unknown"), never crashes; no QR/verify form renders', async () => {
    mockEnroll.mockRejectedValueOnce(new TypeError('unexpected shape'));

    renderScreen();

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-qr')).not.toBeInTheDocument();
  });

  it('ITEM 31: the enroll() timeout is 15s, not 8s — a request still pending at 8s must NOT yet report unavailable', async () => {
    vi.useFakeTimers();
    mockEnroll.mockReturnValueOnce(new Promise(() => {}));

    renderScreen();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(onCapabilityUnavailable).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_001); // total 15_001ms
    });
    expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
  });

  it('ITEM 31: a LATE-resolving enroll() (loses the 15s race, then succeeds server-side) is best-effort unenrolled so no orphan factor is left behind', async () => {
    vi.useFakeTimers();
    let resolveEnroll!: (v: typeof VALID_ENROLL_RESPONSE) => void;
    mockEnroll.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEnroll = resolve;
      })
    );

    renderScreen();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    expect(mockUnenroll).not.toHaveBeenCalled();

    // The original request finally comes back, well after the timeout.
    await act(async () => {
      resolveEnroll(VALID_ENROLL_RESPONSE);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-new' });
  });

  it('ITEM 31: a late-resolving enroll() that itself failed (no factor id) does NOT call unenroll (nothing to clean up)', async () => {
    vi.useFakeTimers();
    let resolveEnroll!: (v: { data: null; error: { code: string } }) => void;
    mockEnroll.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEnroll = resolve;
      })
    );

    renderScreen();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    await act(async () => {
      resolveEnroll({ data: null, error: { code: 'mfa_totp_enroll_not_enabled' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUnenroll).not.toHaveBeenCalled();
  });

  it('R20: a late-resolving enroll() after an ORDINARY unmount (navigating away, not a timeout) is ALSO best-effort unenrolled — the orphan-cleanup extension is not limited to the timeout race', async () => {
    let resolveEnroll!: (v: typeof VALID_ENROLL_RESPONSE) => void;
    mockEnroll.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEnroll = resolve;
      })
    );

    const { unmount } = renderScreen();
    await waitFor(() => {
      expect(mockEnroll).toHaveBeenCalledTimes(1);
    });

    // The user navigates away before enroll() has resolved at all — no
    // timeout involved.
    unmount();
    expect(mockUnenroll).not.toHaveBeenCalled();

    // The original request finally comes back, after unmount, and
    // succeeded server-side.
    await act(async () => {
      resolveEnroll(VALID_ENROLL_RESPONSE);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-new' });
    expect(onCapabilityUnavailable).not.toHaveBeenCalled();
    expect(onEnrolled).not.toHaveBeenCalled();
  });

  it('R20: a late-resolving enroll() after an ordinary unmount that itself FAILED (no factor id) does not call unenroll', async () => {
    let resolveEnroll!: (v: { data: null; error: { code: string } }) => void;
    mockEnroll.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEnroll = resolve;
      })
    );

    const { unmount } = renderScreen();
    await waitFor(() => {
      expect(mockEnroll).toHaveBeenCalledTimes(1);
    });

    unmount();

    await act(async () => {
      resolveEnroll({ data: null, error: { code: 'mfa_totp_enroll_not_enabled' } });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUnenroll).not.toHaveBeenCalled();
  });

  it('R3: the orphan-cleanup unenroll() call is itself raced against a timeout — a HUNG unenroll() settles instead of lingering forever', async () => {
    vi.useFakeTimers();
    let resolveEnroll!: (v: typeof VALID_ENROLL_RESPONSE) => void;
    mockEnroll.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveEnroll = resolve;
      })
    );
    // unenroll() hangs forever — without R3's withTimeout wrap this
    // fire-and-forget promise would never settle at all.
    mockUnenroll.mockReturnValueOnce(new Promise(() => {}));

    renderScreen();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');

    await act(async () => {
      resolveEnroll(VALID_ENROLL_RESPONSE);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-new' });

    // The hung unenroll() call itself times out — this must not throw an
    // unhandled rejection or hang the test.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
  });
});

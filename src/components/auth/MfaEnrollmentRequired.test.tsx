/** Mandatory MFA enrollment remains non-skippable and fails closed. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnroll.mockResolvedValue(VALID_ENROLL_RESPONSE);
    mockUnenroll.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function renderScreen() {
    return render(<MfaEnrollmentRequired onEnrolled={onEnrolled} />);
  }

  // The real app renders inside <React.StrictMode> (src/main.tsx), and every
  // dev/CI build therefore mounts -> unmounts -> remounts each component,
  // double-invoking its effects. `renderScreen` above does NOT, so it cannot
  // see that class of defect at all.
  function renderScreenUnderStrictMode() {
    return render(
      <StrictMode>
        <MfaEnrollmentRequired onEnrolled={onEnrolled} />
      </StrictMode>,
    );
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
  });

  // -----------------------------------------------------------------------
  // Platform failures during enrollment verification remain inside the gate.
  // -----------------------------------------------------------------------

  it('ITEM 4/EA1: a PLATFORM error on challenge() (unrecognized code) keeps the gate closed with a retryable error', async () => {
    mockChallenge.mockResolvedValueOnce({ data: null, error: { message: 'service down', code: 'mfa_totp_verify_not_enabled' } });

    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
        MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
      );
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
      MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
    );
  });

  it('ITEM 4/EA1 (R24): a PLATFORM error on verify() (unrecognized code) keeps the gate closed', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'service down', code: 'mfa_totp_verify_not_enabled' } });

    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
        MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
      );
    });
    expect(onEnrolled).not.toHaveBeenCalled();
  });

  // Explicit backend rejections retain their actionable message; they never
  // call the completion callback or expose protected content.
  it.each(['validation_failed', 'over_request_rate_limit', 'mfa_ip_address_mismatch'])(
    'R24: a REJECTED verify() error (%s) stays in the gate with an inline error',
    async (code) => {
      mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
      mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'rejected by GoTrue', code } });

      renderScreen();
      await waitFor(() => {
        expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
      fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(/rejected by gotrue/i);
      });
      expect(onEnrolled).not.toHaveBeenCalled();
      // Stays on the same completable screen — a rejection is retryable,
      // not a reason to fail open or otherwise abandon the code form.
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    }
  );

  it.each(['validation_failed', 'over_request_rate_limit', 'mfa_ip_address_mismatch'])(
    'R24: a REJECTED challenge() error (%s) stays in the gate with an inline error',
    async (code) => {
      mockChallenge.mockResolvedValueOnce({ data: null, error: { message: 'rejected by GoTrue', code } });

      renderScreen();
      await waitFor(() => {
        expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
      fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(/rejected by gotrue/i);
      });
      expect(onEnrolled).not.toHaveBeenCalled();
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    }
  );

  it('ITEM 4/E4: a THROWN exception during handleVerify keeps the gate closed, resets busy, never crashes', async () => {
    mockChallenge.mockRejectedValueOnce(new TypeError('boom'));

    renderScreen();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
        MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
      );
    });
    expect(screen.getByTestId('mfa-enrollment-submit')).not.toBeDisabled();
  });

  it('ITEM 4/EA6: a HUNG challenge() call during handleVerify times out with the gate closed', async () => {
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

    expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
      MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
    );
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
  // Every enrollment error keeps the mandatory gate closed.
  // -----------------------------------------------------------------------

  it('FAIL-CLOSED: a known enroll error code (mfa_totp_enroll_not_enabled) keeps the gate closed with that code; no QR/verify form renders', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: { message: 'MFA enroll is disabled for TOTP', code: 'mfa_totp_enroll_not_enabled' } });

    renderScreen();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
        MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
      );
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-qr')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mfa-enrollment-code')).not.toBeInTheDocument();
  });

  it('FAIL-CLOSED: an UNKNOWN enroll error code still keeps the gate closed — no allowlist', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: { message: 'something new broke', code: 'some_future_error_code' } });

    renderScreen();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
        MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
      );
    });
    expect(onEnrolled).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-enrollment-qr')).not.toBeInTheDocument();
  });

  it('FAIL-CLOSED: an error with no code at all reports "unknown"', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    renderScreen();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
        MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
      );
    });
  });

  it('FAIL-CLOSED: missing data with no error object also keeps the gate closed', async () => {
    mockEnroll.mockResolvedValueOnce({ data: null, error: null });

    renderScreen();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
        MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
      );
    });
  });

  it('FAIL-CLOSED: a THROWN TypeError during enroll() keeps the gate closed without crashing', async () => {
    mockEnroll.mockRejectedValueOnce(new TypeError('unexpected shape'));

    renderScreen();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
        MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
      );
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
    expect(screen.queryByTestId('mfa-enrollment-error')).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_001); // total 15_001ms
    });
    expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
      MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
    );
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
    expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
      MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
    );
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
    expect(screen.getByTestId('mfa-enrollment-error')).toHaveTextContent(
      MFA_ENROLLMENT_REQUIRED_LABELS.GENERIC_ERROR,
    );

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

  // ------------------------------------------------------------------
  // StrictMode double-invoke (E2E flake root cause, 2026-09-08)
  //
  // `e2e/mfa-enrollment-and-challenge.spec.ts`'s two MfaEnrollmentRequired
  // scenarios (lines 208 and 385) failed intermittently on PRs #2442/#2485/
  // #2496 with "MFA verification failed; probe will not retry a platform
  // error" — deterministic within a job, intermittent across jobs, and never
  // on the TwoFactorSetup/MfaChallenge scenarios in the same file.
  //
  // Cause: the mount-time enroll() effect ran TWICE under StrictMode, so the
  // server held two unverified factors and the component rendered whichever
  // enroll() resolved LAST. The spec reads `mfa-enrollment-secret` once and
  // then computes TOTP codes from that snapshot; when the second enroll()
  // landed after that read, the displayed secret (and `enrollmentData
  // .factorId`) silently swapped to the other factor and every code the spec
  // submitted was computed from the wrong secret. GoTrue validates TOTP with
  // Skew: 1 (+/- one 30s step), so this is NOT a step-boundary race — the
  // codes were simply for a different factor, which is why the helper's
  // one-shot boundary retry could never recover.
  //
  // The component's own doc comment already states the intent these tests
  // pin: "Intentionally mount-once: re-enrolling on every re-render would
  // spam Supabase and burn the MaxEnrolledFactors cap (Amendment A3)."
  // ------------------------------------------------------------------

  it('enrolls EXACTLY ONCE under StrictMode: the mount effect is double-invoked, the enrollment is not', async () => {
    renderScreenUnderStrictMode();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-secret')).toBeInTheDocument();
    });
    // Let any second enroll() that a double-invoked effect would have fired
    // settle before asserting, so this cannot pass on timing alone.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockEnroll).toHaveBeenCalledTimes(1);
    // No second factor exists, so nothing has to be cleaned up either.
    expect(mockUnenroll).not.toHaveBeenCalled();
  });

  it('the secret shown to the user cannot be swapped by a later enroll(), and verify() targets the factor whose secret is displayed', async () => {
    let resolveSecondEnroll!: (v: unknown) => void;
    mockEnroll
      .mockResolvedValueOnce({
        data: {
          id: 'factor-displayed',
          type: 'totp',
          totp: { qr_code: 'data:image/svg+xml;base64,a', secret: 'AAAAAAAAAAAAAAAA', uri: 'otpauth://a' },
        },
        error: null,
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecondEnroll = resolve;
        }),
      );
    mockChallenge.mockResolvedValue({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValue({ data: { session: {} }, error: null });

    renderScreenUnderStrictMode();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-enrollment-secret')).toHaveTextContent('AAAAAAAAAAAAAAAA');
    });
    // This is the E2E spec's read: it snapshots the secret text HERE and
    // computes every subsequent TOTP code from it.
    const displayedSecret = screen.getByTestId('mfa-enrollment-secret').textContent;

    // A second enroll() landing after that read must not be able to move the
    // screen onto a different factor.
    await act(async () => {
      resolveSecondEnroll({
        data: {
          id: 'factor-orphan',
          type: 'totp',
          totp: { qr_code: 'data:image/svg+xml;base64,b', secret: 'BBBBBBBBBBBBBBBB', uri: 'otpauth://b' },
        },
        error: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('mfa-enrollment-secret')).toHaveTextContent(displayedSecret!);

    fireEvent.change(screen.getByTestId('mfa-enrollment-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-enrollment-submit'));

    await waitFor(() => {
      expect(mockVerify).toHaveBeenCalled();
    });
    expect(mockChallenge).toHaveBeenCalledWith({ factorId: 'factor-displayed' });
    expect(mockVerify).toHaveBeenCalledWith(
      expect.objectContaining({ factorId: 'factor-displayed', code: '123456' }),
    );
  });

});

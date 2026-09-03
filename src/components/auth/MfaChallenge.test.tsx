/**
 * MfaChallenge Component Tests — SCRUM-3167, hardened again per PR #2637
 * code review.
 *
 * CHANGES FROM THE PRIOR VERSION (this batch):
 * - `onVerified` is now called ONLY after a real, successful verify(). The
 *   two fail-open branches (listFactors() erroring/timing out, or
 *   defensively finding no verified factor) now call the new `onBypassed`
 *   prop instead — `useMfaAssurance.markVerified()` was being called from
 *   a non-verify path, falsely asserting `hasVerifiedFactor=true` for up to
 *   60s (item 32).
 * - `listFactors()` is now wrapped in try/catch AND raced against an 8s
 *   timeout (item 2/E2) — previously a THROWN rejection left
 *   `loadingFactor=true` forever, an infinite spinner on the login gate.
 * - `challenge()`/`verify()` are now ALSO raced against the timeout
 *   (item 4/E4/EA6) — previously only try/caught, so a hang spun forever.
 * - Error classification moved to the shared `classifyMfaError` helper
 *   (`@/lib/mfaErrors`); `validation_failed` is REMOVED from the wrong-code
 *   set (item 30) — it's a platform error now.
 * - A `mounted`/cancelled guard on `handleSubmit` (item 6/D2/D8): a result
 *   arriving after unmount is ignored.
 * - "Sign out" is disabled while `loadingFactor` or `busy` (item 6/D8).
 * - The code input carries `inputMode="numeric"`, `autoComplete="one-time-code"`,
 *   `pattern="[0-9]*"` (item 8/D3), and its placeholder now comes from
 *   `MFA_CHALLENGE_LABELS.CODE_PLACEHOLDER` (item 10/C2).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MfaChallenge } from './MfaChallenge';
import { MFA_CHALLENGE_LABELS } from '@/lib/copy';

const mockListFactors = vi.fn();
const mockChallenge = vi.fn();
const mockVerify = vi.fn();
const mockSignOut = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      mfa: {
        listFactors: (...args: unknown[]) => mockListFactors(...args),
        challenge: (...args: unknown[]) => mockChallenge(...args),
        verify: (...args: unknown[]) => mockVerify(...args),
      },
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ signOut: mockSignOut }),
}));

describe('MfaChallenge', () => {
  const onVerified = vi.fn();
  const onBypassed = vi.fn();
  const onCapabilityUnavailable = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', type: 'totp', status: 'verified' }] },
      error: null,
    });
  });

  function renderChallenge() {
    return render(
      <MfaChallenge onVerified={onVerified} onBypassed={onBypassed} onCapabilityUnavailable={onCapabilityUnavailable} />
    );
  }

  function enterCode(code: string) {
    fireEvent.change(screen.getByTestId('mfa-challenge-code'), { target: { value: code } });
  }

  it('renders with the mfa-challenge root testid once the verified factor loads', async () => {
    renderChallenge();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-challenge-submit')).toBeDisabled();
  });

  it('the code input carries the one-time-code UX attributes (item 8/D3)', async () => {
    renderChallenge();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    const input = screen.getByTestId('mfa-challenge-code');
    expect(input).toHaveAttribute('inputMode', 'numeric');
    expect(input).toHaveAttribute('autoComplete', 'one-time-code');
    expect(input).toHaveAttribute('pattern', '[0-9]*');
    expect(input).toHaveAttribute('placeholder', MFA_CHALLENGE_LABELS.CODE_PLACEHOLDER);
  });

  it('submits challenge + verify with the loaded factor id and calls onVerified (not onBypassed) on success', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    renderChallenge();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await waitFor(() => {
      expect(mockChallenge).toHaveBeenCalledWith({ factorId: 'factor-1' });
    });
    expect(mockVerify).toHaveBeenCalledWith({
      factorId: 'factor-1',
      challengeId: 'challenge-1',
      code: '123456',
    });
    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledTimes(1);
    });
    expect(onBypassed).not.toHaveBeenCalled();
    expect(onCapabilityUnavailable).not.toHaveBeenCalled();
  });

  it.each(['mfa_verification_failed', 'mfa_verification_rejected', 'mfa_challenge_expired'])(
    'WRONG-CODE (%s): shows a retryable inline error and does NOT call onVerified/onBypassed/onCapabilityUnavailable',
    async (code) => {
      mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
      mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'Invalid code', code } });

      renderChallenge();

      await waitFor(() => {
        expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
      });

      enterCode('000000');
      fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('mfa-challenge-error')).toHaveTextContent(/invalid code/i);
      });
      expect(onVerified).not.toHaveBeenCalled();
      expect(onBypassed).not.toHaveBeenCalled();
      expect(onCapabilityUnavailable).not.toHaveBeenCalled();

      // Still retryable: the code field and submit button are usable again.
      expect(screen.getByTestId('mfa-challenge-code')).not.toBeDisabled();
    }
  );

  it('CHANGED (item 30): validation_failed is now a PLATFORM error, not a retryable wrong-code error', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'bad request', code: 'validation_failed' } });

    renderChallenge();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('validation_failed');
    });
    expect(screen.queryByTestId('mfa-challenge-error')).not.toBeInTheDocument();
  });

  it('PLATFORM ERROR on verify() (unknown code): calls onCapabilityUnavailable with the code, not a retry error', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'service down', code: 'mfa_totp_verify_not_enabled' } });

    renderChallenge();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('mfa_totp_verify_not_enabled');
    });
    expect(onVerified).not.toHaveBeenCalled();
    expect(onBypassed).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-challenge-error')).not.toBeInTheDocument();
  });

  it('PLATFORM ERROR on challenge() (no code at all): calls onCapabilityUnavailable with "unknown"', async () => {
    mockChallenge.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    renderChallenge();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('PLATFORM ERROR: a thrown exception during submit calls onCapabilityUnavailable, never crashes', async () => {
    mockChallenge.mockRejectedValueOnce(new TypeError('boom'));

    renderChallenge();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('ITEM 4/EA6: a HUNG challenge() call times out to onCapabilityUnavailable("unknown") instead of spinning forever', async () => {
    vi.useFakeTimers();
    mockChallenge.mockReturnValueOnce(new Promise(() => {}));

    renderChallenge();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('ITEM 4/EA6: a HUNG verify() call times out to onCapabilityUnavailable("unknown")', async () => {
    vi.useFakeTimers();
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockReturnValueOnce(new Promise(() => {}));

    renderChallenge();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(onCapabilityUnavailable).toHaveBeenCalledWith('unknown');
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('only allows digits in the code field, capped at 6', async () => {
    renderChallenge();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    const input = screen.getByTestId('mfa-challenge-code') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ab12cd34ef' } });
    expect(input.value).toBe('1234');
  });

  it('LOCKOUT ESCAPE HATCH: offers a sign-out affordance so a user without their device is never fully trapped', async () => {
    renderChallenge();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mfa-challenge-signout'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('ITEM 6/D8: Sign out is disabled while the factor is still loading', () => {
    mockListFactors.mockReturnValueOnce(new Promise(() => {})); // never resolves during this assertion
    renderChallenge();

    expect(screen.getByTestId('mfa-challenge-signout')).toBeDisabled();
  });

  it('ITEM 6/D8: Sign out is disabled while a submit is in flight', async () => {
    let resolveChallenge!: (v: { data: { id: string } | null; error: null }) => void;
    mockChallenge.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveChallenge = resolve;
      })
    );

    renderChallenge();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-signout')).toBeDisabled();
    });

    resolveChallenge({ data: { id: 'challenge-1' }, error: null });
  });

  // -----------------------------------------------------------------------
  // FAIL-OPEN via onBypassed (CHANGED, item 32) — listFactors()-level fail-
  // open paths no longer call onVerified.
  // -----------------------------------------------------------------------

  it('FAIL-OPEN (onBypassed, not onVerified): calls onBypassed if listFactors unexpectedly returns no verified factor (defensive — should be unreachable via AuthGuard)', async () => {
    mockListFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null });

    renderChallenge();

    await waitFor(() => {
      expect(onBypassed).toHaveBeenCalledTimes(1);
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN (onBypassed, not onVerified): listFactors() erroring calls onBypassed — a platform read failure never trapped the user, and never falsely claims a real verify happened', async () => {
    mockListFactors.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    renderChallenge();

    await waitFor(() => {
      expect(onBypassed).toHaveBeenCalledTimes(1);
    });
    expect(onVerified).not.toHaveBeenCalled();
    expect(onCapabilityUnavailable).not.toHaveBeenCalled();
  });

  it('ITEM 2/E2: a THROWN listFactors() rejection calls onBypassed instead of leaving loadingFactor stuck forever', async () => {
    mockListFactors.mockRejectedValueOnce(new TypeError('network exploded'));

    renderChallenge();

    await waitFor(() => {
      expect(onBypassed).toHaveBeenCalledTimes(1);
    });
    expect(onVerified).not.toHaveBeenCalled();
    // Never got stuck on the loading spinner (no code field rendered, but
    // also no lingering "mfa-challenge" root without a bypass call).
  });

  it('ITEM 2/E2: a HUNG listFactors() call (never resolves) times out to onBypassed instead of spinning forever', async () => {
    vi.useFakeTimers();
    mockListFactors.mockReturnValueOnce(new Promise(() => {}));

    renderChallenge();

    expect(onBypassed).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(onBypassed).toHaveBeenCalledTimes(1);
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('ITEM 6/D2: ignores a late-arriving submit result after unmount (no state update, no callback)', async () => {
    let resolveVerify!: (v: { data: unknown; error: null }) => void;
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveVerify = resolve;
      })
    );

    const { unmount } = renderChallenge();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    unmount();
    resolveVerify({ data: { session: {} }, error: null });
    // Give the microtask queue a turn to process the resolved promise.
    await Promise.resolve();
    await Promise.resolve();

    expect(onVerified).not.toHaveBeenCalled();
  });
});

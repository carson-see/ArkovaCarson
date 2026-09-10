/**
 * MfaChallenge Component Tests — SCRUM-3167, FAIL-CLOSED rewrite
 * (PR #2637 review round 2, R17-R21 CTO ruling — supersedes the earlier
 * "fail open on any platform error").
 *
 * CTO ruling: fail-open is allowed ONLY on the ENROLLMENT path (no
 * verified factor, platform can't issue one — see MfaEnrollmentRequired).
 * The CHALLENGE path (this component — a session at aal1 whose user HAS a
 * verified factor) must FAIL CLOSED: ANY error — network, timeout,
 * unknown code, rate limit, IP mismatch — shows a retry screen with "Try
 * again" and "Sign out", and NEVER grants access to protected content. A
 * client-detected "platform error" is trivially attacker-triggerable
 * (block one request in DevTools), so the prior fail-open design made MFA
 * optional for anyone holding a password.
 *
 * `onVerified` is now the ONLY prop — it fires ONLY after a real,
 * successful `challenge()`+`verify()` round trip. There is no
 * `onBypassed`/`onCapabilityUnavailable` escape hatch from this
 * component at all: `AuthGuard` cannot be told to render children from
 * here, structurally, not just by convention.
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', type: 'totp', status: 'verified' }] },
      error: null,
    });
  });

  function renderChallenge() {
    return render(<MfaChallenge onVerified={onVerified} />);
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

  it('the code input carries the one-time-code UX attributes', async () => {
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

  it('submits challenge + verify with the loaded factor id and calls onVerified on success', async () => {
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
  });

  it.each(['mfa_verification_failed', 'mfa_verification_rejected', 'mfa_challenge_expired'])(
    'WRONG-CODE (%s): shows a retryable inline error and does NOT call onVerified, does NOT show the retry screen',
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
      expect(screen.queryByTestId('mfa-challenge-retry')).not.toBeInTheDocument();

      // Still retryable: the code field and submit button are usable again.
      expect(screen.getByTestId('mfa-challenge-code')).not.toBeDisabled();
    }
  );

  // -----------------------------------------------------------------------
  // FAIL CLOSED (R17-R21 CTO ruling): every non-wrong-code outcome shows
  // the retry screen. NONE of them call onVerified. There is no callback
  // this component could use to grant access even if it wanted to.
  // -----------------------------------------------------------------------

  it('R18: validation_failed (a "rejected" classification, distinct from wrong-code) shows an inline retryable error, NOT the fail-closed retry screen — the request reached GoTrue and got a real rejection, so the form stays usable', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'bad request', code: 'validation_failed' } });

    renderChallenge();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-error')).toHaveTextContent(/bad request/i);
    });
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-challenge-retry')).not.toBeInTheDocument();
    expect(screen.getByTestId('mfa-challenge-code')).not.toBeDisabled();
  });

  it.each(['over_request_rate_limit', 'mfa_ip_address_mismatch'])(
    'R18: the explicit rejection code %s shows an inline retryable error, NOT the fail-closed retry screen (a real backend rejection is not the fail-open bypass this ruling targets)',
    async (code) => {
      mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
      mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'rejected', code } });

      renderChallenge();
      await waitFor(() => {
        expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
      });

      enterCode('123456');
      fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('mfa-challenge-error')).toHaveTextContent(/rejected/i);
      });
      expect(onVerified).not.toHaveBeenCalled();
      expect(screen.queryByTestId('mfa-challenge-retry')).not.toBeInTheDocument();
    }
  );

  it('R19 CHANGED: a "platform" classification (e.g. mfa_totp_verify_not_enabled) on the CHALLENGE path ALSO fails closed — this used to grant access, now it does not', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'disabled', code: 'mfa_totp_verify_not_enabled' } });

    renderChallenge();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-retry')).toBeInTheDocument();
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('R19: a thrown exception during submit shows the retry screen, never crashes, never grants access', async () => {
    mockChallenge.mockRejectedValueOnce(new TypeError('boom'));

    renderChallenge();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-retry')).toBeInTheDocument();
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('a HUNG challenge() call times out to the retry screen instead of spinning forever', async () => {
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

    expect(screen.getByTestId('mfa-challenge-retry')).toBeInTheDocument();
    expect(onVerified).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // listFactors() failures (mount-time load) — item 2/E2 fixed the
  // infinite-spinner bug; R19 changes the OUTCOME from a bypass to the
  // fail-closed retry screen.
  // -----------------------------------------------------------------------

  it('FAIL-CLOSED (changed from fail-open): listFactors() unexpectedly returning no verified factor shows the retry screen, not access (defensive — should be unreachable via AuthGuard)', async () => {
    mockListFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null });

    renderChallenge();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-retry')).toBeInTheDocument();
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED (changed from fail-open): listFactors() erroring shows the retry screen', async () => {
    mockListFactors.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    renderChallenge();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-retry')).toBeInTheDocument();
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('a THROWN listFactors() rejection shows the retry screen instead of leaving the spinner stuck forever', async () => {
    mockListFactors.mockRejectedValueOnce(new TypeError('network exploded'));

    renderChallenge();

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-retry')).toBeInTheDocument();
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('a HUNG listFactors() call (never resolves) times out to the retry screen', async () => {
    vi.useFakeTimers();
    mockListFactors.mockReturnValueOnce(new Promise(() => {}));

    renderChallenge();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(screen.getByTestId('mfa-challenge-retry')).toBeInTheDocument();
    expect(onVerified).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // "Try again" retry control + auto-retry
  // -----------------------------------------------------------------------

  it('clicking "Try again" re-attempts listFactors() and can recover into the normal code form', async () => {
    mockListFactors.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    renderChallenge();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-retry')).toBeInTheDocument();
    });

    mockListFactors.mockResolvedValueOnce({
      data: { totp: [{ id: 'factor-1', type: 'totp', status: 'verified' }] },
      error: null,
    });
    fireEvent.click(screen.getByTestId('mfa-challenge-retry-button'));

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('mfa-challenge-retry')).not.toBeInTheDocument();
  });

  it('R19: auto-retries listFactors() on the live re-check cadence while on the retry screen (visibilitychange)', async () => {
    mockListFactors.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    // Flush the retry-state commit AND its passive polling effect before the event.
    // Seeing retry DOM alone does not prove the visibility listener is registered.
    await act(async () => {
      renderChallenge();
    });
    expect(screen.getByTestId('mfa-challenge-retry')).toBeInTheDocument();
    expect(mockListFactors).toHaveBeenCalledTimes(1);

    mockListFactors.mockResolvedValueOnce({
      data: { totp: [{ id: 'factor-1', type: 'totp', status: 'verified' }] },
      error: null,
    });
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(mockListFactors).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
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

  it('Sign out is ALSO available from the retry screen — the escape hatch must survive a fail-closed error', async () => {
    mockListFactors.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    renderChallenge();
    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-retry')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mfa-challenge-signout'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('Sign out is disabled while the factor is still loading', () => {
    mockListFactors.mockReturnValueOnce(new Promise(() => {}));
    renderChallenge();

    expect(screen.getByTestId('mfa-challenge-signout')).toBeDisabled();
  });

  it('Sign out is disabled while a submit is in flight', async () => {
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

  it('ignores a late-arriving submit result after unmount (no state update, no callback)', async () => {
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
    await Promise.resolve();
    await Promise.resolve();

    expect(onVerified).not.toHaveBeenCalled();
  });
});

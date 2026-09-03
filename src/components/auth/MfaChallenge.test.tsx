/**
 * MfaChallenge Component Tests — SCRUM-3167.
 *
 * Restored from PR #1973 (3572fcd6e) and hardened per CTO ruling A4:
 * - `listFactors()` erroring now fails OPEN (calls `onVerified`) instead of
 *   trapping the user on an unrecoverable error screen — a platform read
 *   failure is not the user's fault and must not block them.
 * - challenge()/verify() PLATFORM errors (anything whose `code` is not one
 *   of the four known wrong-code/expired codes, plus any thrown error or
 *   timeout) call the new `onCapabilityUnavailable(code)` prop instead of
 *   being shown as a retryable inline error — AuthGuard renders `children`
 *   for these so a platform misconfiguration can never wall anyone out.
 * - Only the four known wrong-code-shaped error codes keep the user on
 *   this screen with a retryable inline error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MfaChallenge } from './MfaChallenge';

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
  const onCapabilityUnavailable = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', type: 'totp', status: 'verified' }] },
      error: null,
    });
  });

  function enterCode(code: string) {
    fireEvent.change(screen.getByTestId('mfa-challenge-code'), { target: { value: code } });
  }

  it('renders with the mfa-challenge root testid once the verified factor loads', async () => {
    render(<MfaChallenge onVerified={onVerified} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge')).toBeInTheDocument();
    });
    expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-challenge-submit')).toBeDisabled();
  });

  it('submits challenge + verify with the loaded factor id and calls onVerified on success', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    render(<MfaChallenge onVerified={onVerified} onCapabilityUnavailable={onCapabilityUnavailable} />);

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
    expect(onCapabilityUnavailable).not.toHaveBeenCalled();
  });

  it.each(['mfa_verification_failed', 'mfa_verification_rejected', 'mfa_challenge_expired', 'validation_failed'])(
    'WRONG-CODE (%s): shows a retryable inline error and does NOT call onVerified or onCapabilityUnavailable',
    async (code) => {
      mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
      mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'Invalid code', code } });

      render(<MfaChallenge onVerified={onVerified} onCapabilityUnavailable={onCapabilityUnavailable} />);

      await waitFor(() => {
        expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
      });

      enterCode('000000');
      fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('mfa-challenge-error')).toHaveTextContent(/invalid code/i);
      });
      expect(onVerified).not.toHaveBeenCalled();
      expect(onCapabilityUnavailable).not.toHaveBeenCalled();

      // Still retryable: the code field and submit button are usable again.
      expect(screen.getByTestId('mfa-challenge-code')).not.toBeDisabled();
    }
  );

  it('PLATFORM ERROR on verify() (unknown code): calls onCapabilityUnavailable with the code, not a retry error', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'service down', code: 'mfa_totp_verify_not_enabled' } });

    render(<MfaChallenge onVerified={onVerified} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    enterCode('123456');
    fireEvent.click(screen.getByTestId('mfa-challenge-submit'));

    await waitFor(() => {
      expect(onCapabilityUnavailable).toHaveBeenCalledWith('mfa_totp_verify_not_enabled');
    });
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.queryByTestId('mfa-challenge-error')).not.toBeInTheDocument();
  });

  it('PLATFORM ERROR on challenge() (no code at all): calls onCapabilityUnavailable with "unknown"', async () => {
    mockChallenge.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    render(<MfaChallenge onVerified={onVerified} onCapabilityUnavailable={onCapabilityUnavailable} />);

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

    render(<MfaChallenge onVerified={onVerified} onCapabilityUnavailable={onCapabilityUnavailable} />);

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

  it('only allows digits in the code field, capped at 6', async () => {
    render(<MfaChallenge onVerified={onVerified} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    const input = screen.getByTestId('mfa-challenge-code') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ab12cd34ef' } });
    expect(input.value).toBe('1234');
  });

  it('LOCKOUT ESCAPE HATCH: offers a sign-out affordance so a user without their device is never fully trapped', async () => {
    render(<MfaChallenge onVerified={onVerified} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(screen.getByTestId('mfa-challenge-code')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('mfa-challenge-signout'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('FAIL-OPEN (A4): calls onVerified immediately if listFactors unexpectedly returns no verified factor (defensive — should be unreachable via AuthGuard)', async () => {
    mockListFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null });

    render(<MfaChallenge onVerified={onVerified} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledTimes(1);
    });
    expect(onCapabilityUnavailable).not.toHaveBeenCalled();
  });

  it('FAIL-OPEN (A4, changed from prior art): listFactors() erroring now calls onVerified — a platform read failure never traps the user on an unrecoverable screen', async () => {
    mockListFactors.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    render(<MfaChallenge onVerified={onVerified} onCapabilityUnavailable={onCapabilityUnavailable} />);

    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledTimes(1);
    });
    expect(onCapabilityUnavailable).not.toHaveBeenCalled();
  });
});

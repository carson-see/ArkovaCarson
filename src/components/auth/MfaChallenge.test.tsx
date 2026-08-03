/**
 * MfaChallenge Component Tests — pre-pentest MFA hardening.
 *
 * Rendered by AuthGuard in place of protected children when the session is
 * aal1 but the user has a verified TOTP factor. Mirrors the
 * challenge()+verify() sequence TwoFactorSetup already uses for enrollment.
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

  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue({
      data: { totp: [{ id: 'factor-1', type: 'totp', status: 'verified' }] },
      error: null,
    });
  });

  it('renders the verification prompt once the verified factor loads', async () => {
    render(<MfaChallenge onVerified={onVerified} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /verify/i })).toBeDisabled();
  });

  it('submits challenge + verify with the loaded factor id and calls onVerified on success', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    render(<MfaChallenge onVerified={onVerified} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/000000/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

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

  it('shows an error and does NOT call onVerified when the code is wrong', async () => {
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: null, error: { message: 'Invalid code' } });

    render(<MfaChallenge onVerified={onVerified} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/000000/i), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(screen.getByText(/invalid code/i)).toBeInTheDocument();
    });
    expect(onVerified).not.toHaveBeenCalled();
  });

  it('only allows digits in the code field, capped at 6', async () => {
    render(<MfaChallenge onVerified={onVerified} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/000000/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ab12cd34ef' } });
    expect(input.value).toBe('1234');
  });

  it('LOCKOUT ESCAPE HATCH: offers a sign-out affordance so a user without their device is never fully trapped', async () => {
    render(<MfaChallenge onVerified={onVerified} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('FAIL-OPEN: calls onVerified immediately if listFactors unexpectedly returns no verified factor (defensive — should be unreachable via AuthGuard, but must never hard-trap the user)', async () => {
    mockListFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null });

    render(<MfaChallenge onVerified={onVerified} />);

    await waitFor(() => {
      expect(onVerified).toHaveBeenCalledTimes(1);
    });
  });

  it('shows a load error (with sign-out still available) when listFactors errors, without calling onVerified', async () => {
    mockListFactors.mockResolvedValueOnce({ data: null, error: { message: 'network down' } });

    render(<MfaChallenge onVerified={onVerified} />);

    await waitFor(() => {
      expect(screen.getByText(/sign in again/i)).toBeInTheDocument();
    });
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});

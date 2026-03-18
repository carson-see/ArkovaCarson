/**
 * BETA-07: Two-Factor Authentication Component Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TwoFactorSetup } from './TwoFactorSetup';

const mockEnroll = vi.fn();
const mockChallenge = vi.fn();
const mockVerify = vi.fn();
const mockUnenroll = vi.fn();
const mockListFactors = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      mfa: {
        enroll: (...args: unknown[]) => mockEnroll(...args),
        challenge: (...args: unknown[]) => mockChallenge(...args),
        verify: (...args: unknown[]) => mockVerify(...args),
        unenroll: (...args: unknown[]) => mockUnenroll(...args),
        listFactors: (...args: unknown[]) => mockListFactors(...args),
      },
    },
  },
}));

describe('TwoFactorSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue({
      data: { totp: [] },
      error: null,
    });
  });

  it('renders enable 2FA button when not enrolled', async () => {
    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByText(/Two-Factor Authentication/i)).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /enable/i })).toBeInTheDocument();
  });

  it('shows QR code after enrollment starts', async () => {
    mockEnroll.mockResolvedValueOnce({
      data: {
        id: 'factor-1',
        type: 'totp',
        totp: {
          qr_code: 'data:image/svg+xml;base64,test',
          secret: 'JBSWY3DPEHPK3PXP',
          uri: 'otpauth://totp/Arkova:test@test.com?secret=JBSWY3DPEHPK3PXP',
        },
      },
      error: null,
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /enable/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));

    await waitFor(() => {
      expect(screen.getByText(/Scan this QR code/i)).toBeInTheDocument();
    });
  });

  it('verifies TOTP code after enrollment', async () => {
    mockEnroll.mockResolvedValueOnce({
      data: {
        id: 'factor-1',
        type: 'totp',
        totp: {
          qr_code: 'data:image/svg+xml;base64,test',
          secret: 'JBSWY3DPEHPK3PXP',
          uri: 'otpauth://totp/test',
        },
      },
      error: null,
    });

    mockChallenge.mockResolvedValueOnce({
      data: { id: 'challenge-1' },
      error: null,
    });

    mockVerify.mockResolvedValueOnce({
      data: { session: {} },
      error: null,
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /enable/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/000000/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(/000000/i), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify/i }));

    await waitFor(() => {
      expect(mockChallenge).toHaveBeenCalledWith({ factorId: 'factor-1' });
    });
  });

  it('shows disable button when already enrolled', async () => {
    mockListFactors.mockResolvedValueOnce({
      data: {
        totp: [{ id: 'factor-1', type: 'totp', status: 'verified' }],
      },
      error: null,
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disable/i })).toBeInTheDocument();
    });
  });

  it('handles enrollment errors', async () => {
    mockEnroll.mockResolvedValueOnce({
      data: null,
      error: { message: 'Enrollment failed' },
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /enable/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /enable/i }));

    await waitFor(() => {
      expect(screen.getByText(/Enrollment failed/i)).toBeInTheDocument();
    });
  });

  it('disables 2FA when unenroll is called', async () => {
    mockListFactors.mockResolvedValueOnce({
      data: {
        totp: [{ id: 'factor-1', type: 'totp', status: 'verified' }],
      },
      error: null,
    });

    mockUnenroll.mockResolvedValueOnce({
      data: {},
      error: null,
    });

    // After unenroll, factors should be empty
    mockListFactors.mockResolvedValueOnce({
      data: { totp: [] },
      error: null,
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disable/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /disable/i }));

    await waitFor(() => {
      expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-1' });
    });
  });
});

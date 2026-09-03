/**
 * SCRUM-3167 / SCRUM-3584 — Two-Factor Authentication Settings Card
 *
 * Rewritten to list ALL TOTP factors (verified + unverified, Amendment A2),
 * support a second "backup" authenticator, and honour the GoTrue v2.196.0
 * AAL2-required-to-enroll/unenroll-when-a-verified-factor-exists rule
 * (Amendment A3) via an inline step-up code prompt.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TwoFactorSetup } from './TwoFactorSetup';
import { TWO_FACTOR_SETUP_LABELS } from '@/lib/copy';

const mockEnroll = vi.fn();
const mockChallenge = vi.fn();
const mockVerify = vi.fn();
const mockChallengeAndVerify = vi.fn();
const mockUnenroll = vi.fn();
const mockListFactors = vi.fn();
const mockRefreshSession = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
      mfa: {
        enroll: (...args: unknown[]) => mockEnroll(...args),
        challenge: (...args: unknown[]) => mockChallenge(...args),
        verify: (...args: unknown[]) => mockVerify(...args),
        challengeAndVerify: (...args: unknown[]) => mockChallengeAndVerify(...args),
        unenroll: (...args: unknown[]) => mockUnenroll(...args),
        listFactors: (...args: unknown[]) => mockListFactors(...args),
      },
    },
  },
}));

function mkEnrollResponse(overrides: { id?: string; secret?: string } = {}) {
  return {
    data: {
      id: overrides.id ?? 'factor-new',
      type: 'totp',
      friendly_name: 'Authenticator 2026-09-03',
      totp: {
        qr_code: 'data:image/svg+xml;base64,test',
        secret: overrides.secret ?? 'JBSWY3DPEHPK3PXP',
        uri: 'otpauth://totp/Arkova:test@test.com?secret=JBSWY3DPEHPK3PXP',
      },
    },
    error: null,
  };
}

function verifiedFactor(id = 'factor-verified', friendly_name = 'Authenticator 2026-08-01') {
  return {
    id,
    factor_type: 'totp',
    friendly_name,
    status: 'verified',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
}

function unverifiedFactor(id = 'factor-unverified', friendly_name = 'Authenticator 2026-03-23') {
  return {
    id,
    factor_type: 'totp',
    friendly_name,
    status: 'unverified',
    created_at: '2026-03-23T00:00:00.000Z',
    updated_at: '2026-03-23T00:00:00.000Z',
  };
}

describe('TwoFactorSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue({ data: { totp: [] }, error: null });
    mockRefreshSession.mockResolvedValue({ data: { session: {} }, error: null });
  });

  it('lists both verified and unverified factors with status badges', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [verifiedFactor(), unverifiedFactor()] },
      error: null,
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-factor-list')).toBeInTheDocument();
    });

    const verifiedRow = screen.getByTestId('twofactor-factor-factor-verified');
    expect(verifiedRow).toHaveTextContent(TWO_FACTOR_SETUP_LABELS.STATUS_ENABLED);

    const unverifiedRow = screen.getByTestId('twofactor-factor-factor-unverified');
    expect(unverifiedRow).toHaveTextContent(TWO_FACTOR_SETUP_LABELS.STATUS_INCOMPLETE);

    expect(screen.getByTestId('twofactor-remove-factor-verified')).toBeInTheDocument();
    expect(screen.getByTestId('twofactor-remove-factor-unverified')).toBeInTheDocument();

    // A verified factor already exists, so the primary CTA is "add backup", not "enable".
    expect(screen.queryByTestId('twofactor-enable')).not.toBeInTheDocument();
    expect(screen.getByTestId('twofactor-add-backup')).toBeInTheDocument();
  });

  it('enable flow: no factors -> enable -> QR + secret shown -> verify succeeds -> refreshes session and list', async () => {
    mockEnroll.mockResolvedValueOnce(mkEnrollResponse());
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('twofactor-enable'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-qr')).toBeInTheDocument();
    });
    expect(screen.getByTestId('twofactor-secret')).toHaveTextContent('JBSWY3DPEHPK3PXP');
    expect(screen.getByTestId('twofactor-friendly-name')).toHaveValue('Authenticator 2026-09-03');

    fireEvent.change(screen.getByTestId('twofactor-verify-code'), { target: { value: '123456' } });

    // After verifying, the factor is now "enabled" — reflect it in the next listFactors() call.
    mockListFactors.mockResolvedValueOnce({
      data: { totp: [verifiedFactor('factor-new')] },
      error: null,
    });

    fireEvent.click(screen.getByTestId('twofactor-verify-submit'));

    await waitFor(() => {
      expect(mockChallenge).toHaveBeenCalledWith({ factorId: 'factor-new' });
    });
    expect(mockVerify).toHaveBeenCalledWith({
      factorId: 'factor-new',
      challengeId: 'challenge-1',
      code: '123456',
    });

    await waitFor(() => {
      expect(mockRefreshSession).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByTestId('twofactor-factor-factor-new')).toBeInTheDocument();
    });
  });

  it('add-backup flow: one verified factor -> add backup -> enroll succeeds directly (already aal2)', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [verifiedFactor()] },
      error: null,
    });
    mockEnroll.mockResolvedValueOnce(mkEnrollResponse({ id: 'factor-backup', secret: 'ANOTHERSECRET23' }));

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-add-backup')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('twofactor-add-backup'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-qr')).toBeInTheDocument();
    });
    expect(mockEnroll).toHaveBeenCalledWith(
      expect.objectContaining({ factorType: 'totp', friendlyName: expect.any(String) }),
    );
  });

  it('mfa_factor_name_conflict shows a friendly error and stays on the list view', async () => {
    mockEnroll.mockResolvedValueOnce({
      data: null,
      error: { message: 'Factor name conflict', code: 'mfa_factor_name_conflict' },
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('twofactor-enable'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-error')).toHaveTextContent(
        TWO_FACTOR_SETUP_LABELS.ERROR_NAME_CONFLICT,
      );
    });
    // Never reached the QR step.
    expect(screen.queryByTestId('twofactor-qr')).not.toBeInTheDocument();
    expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument();
  });

  it('mfa_totp_enroll_not_enabled shows the UNAVAILABLE notice, not an error wall', async () => {
    mockEnroll.mockResolvedValueOnce({
      data: null,
      error: { message: 'MFA enroll is disabled for TOTP', code: 'mfa_totp_enroll_not_enabled' },
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('twofactor-enable'));

    await waitFor(() => {
      expect(screen.getByText(TWO_FACTOR_SETUP_LABELS.UNAVAILABLE)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('twofactor-error')).not.toBeInTheDocument();
  });

  it('insufficient_aal on enroll -> step-up -> retry succeeds -> QR is shown', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [verifiedFactor()] },
      error: null,
    });
    mockEnroll
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'AAL2 required', code: 'insufficient_aal' },
      })
      .mockResolvedValueOnce(mkEnrollResponse({ id: 'factor-backup' }));
    mockChallengeAndVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-add-backup')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('twofactor-add-backup'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-stepup')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('twofactor-stepup-code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByTestId('twofactor-stepup-submit'));

    await waitFor(() => {
      expect(mockChallengeAndVerify).toHaveBeenCalledWith({
        factorId: 'factor-verified',
        code: '654321',
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-qr')).toBeInTheDocument();
    });
    expect(mockEnroll).toHaveBeenCalledTimes(2);
  });

  it('unenroll of a verified factor: insufficient_aal -> step-up -> retry unenrolls and refreshes', async () => {
    mockListFactors
      .mockResolvedValueOnce({ data: { totp: [verifiedFactor(), verifiedFactor('factor-other', 'Backup')] }, error: null });
    mockUnenroll.mockResolvedValueOnce({
      data: null,
      error: { message: 'AAL2 required', code: 'insufficient_aal' },
    });
    mockChallengeAndVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });
    mockUnenroll.mockResolvedValueOnce({ data: {}, error: null });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-remove-factor-other')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('twofactor-remove-factor-other'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-stepup')).toBeInTheDocument();
    });

    // After the retry succeeds, only the remaining factor should list.
    mockListFactors.mockResolvedValueOnce({ data: { totp: [verifiedFactor()] }, error: null });

    fireEvent.change(screen.getByTestId('twofactor-stepup-code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByTestId('twofactor-stepup-submit'));

    await waitFor(() => {
      expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-other' });
    });
    expect(mockUnenroll).toHaveBeenCalledTimes(2);

    await waitFor(() => {
      expect(mockRefreshSession).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.queryByTestId('twofactor-factor-factor-other')).not.toBeInTheDocument();
    });
  });

  it('unenroll of an unverified factor needs no step-up', async () => {
    mockListFactors.mockResolvedValueOnce({
      data: { totp: [unverifiedFactor()] },
      error: null,
    });
    mockUnenroll.mockResolvedValueOnce({ data: {}, error: null });
    mockListFactors.mockResolvedValueOnce({ data: { totp: [] }, error: null });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-remove-factor-unverified')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('twofactor-remove-factor-unverified'));

    await waitFor(() => {
      expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-unverified' });
    });
    expect(screen.queryByTestId('twofactor-stepup')).not.toBeInTheDocument();
    expect(mockRefreshSession).toHaveBeenCalled();
  });

  it('wrong step-up code stays on the step-up view with an error', async () => {
    mockListFactors.mockResolvedValue({
      data: { totp: [verifiedFactor()] },
      error: null,
    });
    mockEnroll.mockResolvedValueOnce({
      data: null,
      error: { message: 'AAL2 required', code: 'insufficient_aal' },
    });
    mockChallengeAndVerify.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invalid code', code: 'mfa_verification_failed' },
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-add-backup')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('twofactor-add-backup'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-stepup')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('twofactor-stepup-code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('twofactor-stepup-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-error')).toHaveTextContent(
        TWO_FACTOR_SETUP_LABELS.ERROR_STEP_UP_FAILED,
      );
    });
    // Stays put — never retried the underlying enroll().
    expect(screen.getByTestId('twofactor-stepup')).toBeInTheDocument();
    expect(mockEnroll).toHaveBeenCalledTimes(1);
  });

  it('calls refreshSession after a successful verify', async () => {
    mockEnroll.mockResolvedValueOnce(mkEnrollResponse());
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    render(<TwoFactorSetup />);

    await waitFor(() => screen.getByTestId('twofactor-enable'));
    fireEvent.click(screen.getByTestId('twofactor-enable'));
    await waitFor(() => screen.getByTestId('twofactor-verify-code'));

    fireEvent.change(screen.getByTestId('twofactor-verify-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('twofactor-verify-submit'));

    await waitFor(() => {
      expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    });
  });
});

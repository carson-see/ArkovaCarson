/**
 * SCRUM-3167 / SCRUM-3584 — Two-Factor Authentication Settings Card
 *
 * Rewritten to list ALL TOTP factors (verified + unverified, Amendment A2),
 * support a second "backup" authenticator, and honour the GoTrue v2.196.0
 * AAL2-required-to-enroll/unenroll-when-a-verified-factor-exists rule
 * (Amendment A3) via an inline step-up code prompt.
 *
 * HARDENED again per PR #2637 code review:
 * - E1 (CONFIRMED against auth-js 2.110.8 GoTrueClient.js:4899-4907):
 *   `listFactors().data.totp` contains VERIFIED factors ONLY — unverified
 *   factors exist ONLY in `data.all`. Every mock in this file now returns
 *   the REAL shape (`mkListFactorsResponse` derives `totp`/`phone` from a
 *   flat `all` list, exactly like the SDK does) instead of the wrong shape
 *   the prior test suite invented, which hid this defect.
 * - E3: performEnroll/performUnenroll/handleVerify/handleStepUpSubmit are
 *   now all try/caught — a thrown rejection resets `busy` and shows
 *   ERROR_GENERIC instead of leaving the UI stuck forever.
 * - A2-2: `mfa_verified_factor_exists` on enroll() now refreshes the list
 *   and returns to it, instead of a raw error.
 * - A2-3: the default friendly name ALWAYS carries a random suffix (not
 *   just on a detected collision), so a same-day re-enrollment can never
 *   collide via a deterministic name.
 * - A2-4: the enrolling view has a Cancel control that unenrolls the
 *   just-created (unverified, aal1-removable) factor and returns to list.
 * - A2-5: a successful step-up immediately calls safeRefreshSession()
 *   BEFORE retrying the deferred action, not only via that action's own
 *   eventual success path.
 * - D3/D4: the verify and step-up code inputs are one-time-code inputs
 *   inside real `<form>`s, so Enter submits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TwoFactorSetup } from './TwoFactorSetup';
import { TWO_FACTOR_SETUP_LABELS } from '@/lib/copy';
import type { TotpFactor } from '@/lib/mfaTypes';

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

function verifiedFactor(id = 'factor-verified', friendly_name = 'Authenticator 2026-08-01'): TotpFactor {
  return {
    id,
    factor_type: 'totp',
    friendly_name,
    status: 'verified',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
}

function unverifiedFactor(id = 'factor-unverified', friendly_name = 'Authenticator 2026-03-23'): TotpFactor {
  return {
    id,
    factor_type: 'totp',
    friendly_name,
    status: 'unverified',
    created_at: '2026-03-23T00:00:00.000Z',
    updated_at: '2026-03-23T00:00:00.000Z',
  };
}

/**
 * E1: builds the REAL `listFactors()` response shape. `all` is every
 * factor of every type; `totp` (and `phone`) are VERIFIED-ONLY per-type
 * subsets — exactly what `GoTrueClient._listFactors` returns. Tests pass
 * the full roster; this derives the verified-only slices the same way the
 * SDK does, so a test can never accidentally recreate the wrong shape.
 */
function mkListFactorsResponse(all: TotpFactor[] = []) {
  return {
    data: {
      all,
      totp: all.filter((f) => f.factor_type === 'totp' && f.status === 'verified'),
      phone: [],
    },
    error: null,
  };
}

describe('TwoFactorSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListFactors.mockResolvedValue(mkListFactorsResponse([]));
    mockRefreshSession.mockResolvedValue({ data: { session: {} }, error: null });
    mockUnenroll.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // R1 (PR #2637 review round 2, real bug): refreshFactors() had no
  // try/catch and no timeout at all — a rejected or hung listFactors() left
  // the mount-time effect awaiting forever and the card stuck on its
  // loading spinner permanently.
  // -----------------------------------------------------------------------
  it('R1: a REJECTED listFactors() at mount shows the load-error view with a Retry control, instead of an infinite loading spinner', async () => {
    mockListFactors.mockRejectedValueOnce(new TypeError('network exploded'));

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-load-error')).toHaveTextContent(
        TWO_FACTOR_SETUP_LABELS.LOAD_ERROR_TITLE,
      );
    });
    expect(screen.getByTestId('twofactor-load-retry')).toBeInTheDocument();
    expect(screen.queryByTestId('twofactor-factors')).not.toBeInTheDocument();
  });

  it('R1: a HUNG listFactors() call (never resolves) times out to the load-error view instead of spinning forever', async () => {
    vi.useFakeTimers();
    mockListFactors.mockReturnValueOnce(new Promise(() => {}));

    render(<TwoFactorSetup />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(screen.getByTestId('twofactor-load-error')).toBeInTheDocument();
  });

  it('R1: clicking Retry on the load-error view re-attempts listFactors() and can recover into the normal list view', async () => {
    mockListFactors.mockRejectedValueOnce(new TypeError('network exploded'));

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-load-error')).toBeInTheDocument();
    });

    mockListFactors.mockResolvedValueOnce(mkListFactorsResponse([verifiedFactor()]));
    fireEvent.click(screen.getByTestId('twofactor-load-retry'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-factors')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('twofactor-load-error')).not.toBeInTheDocument();
  });

  // -----------------------------------------------------------------------
  // R2 (PR #2637 review round 2): handleVerify/handleStepUpSubmit now route
  // through the shared classifyMfaError instead of a blanket error message
  // for every outcome — a genuine wrong-code rejection keeps the specific
  // copy, but a PLATFORM failure (rate limit, capability code, IP mismatch)
  // must never show the misleading "that code did not match" copy.
  // -----------------------------------------------------------------------
  it('R2: a platform-classified challenge() error during initial verify shows the GENERIC error, not the wrong-code copy', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([]));
    mockEnroll.mockResolvedValueOnce({
      data: {
        id: 'factor-new',
        type: 'totp',
        totp: { qr_code: 'data:image/svg+xml;base64,test', secret: 'JBSWY3DPEHPK3PXP', uri: '' },
      },
      error: null,
    });
    mockChallenge.mockResolvedValueOnce({
      data: null,
      error: { message: 'disabled', code: 'mfa_totp_verify_not_enabled' },
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('twofactor-enable'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-verify-code')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('twofactor-verify-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('twofactor-verify-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-error')).toHaveTextContent(TWO_FACTOR_SETUP_LABELS.ERROR_GENERIC);
    });
    expect(screen.queryByTestId('twofactor-error')).not.toHaveTextContent(
      TWO_FACTOR_SETUP_LABELS.ERROR_STEP_UP_FAILED,
    );
  });

  it('R2: a wrong-code verify() error during initial verify shows the specific "code did not match" copy (behavior change: previously always the generic message)', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([]));
    mockEnroll.mockResolvedValueOnce({
      data: {
        id: 'factor-new',
        type: 'totp',
        totp: { qr_code: 'data:image/svg+xml;base64,test', secret: 'JBSWY3DPEHPK3PXP', uri: '' },
      },
      error: null,
    });
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({
      data: null,
      error: { message: 'Invalid code', code: 'mfa_verification_failed' },
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('twofactor-enable'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-verify-code')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('twofactor-verify-code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('twofactor-verify-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-error')).toHaveTextContent(
        TWO_FACTOR_SETUP_LABELS.ERROR_STEP_UP_FAILED,
      );
    });
  });

  it('R2: a platform-classified challengeAndVerify() error during step-up shows the GENERIC error, not "that code did not match"', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([verifiedFactor()]));
    mockEnroll.mockResolvedValueOnce({
      data: null,
      error: { message: 'AAL2 required', code: 'insufficient_aal' },
    });
    mockChallengeAndVerify.mockResolvedValueOnce({
      data: null,
      error: { message: 'rate limited', code: 'over_request_rate_limit' },
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-add-backup')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('twofactor-add-backup'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-stepup')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('twofactor-stepup-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('twofactor-stepup-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-error')).toHaveTextContent(TWO_FACTOR_SETUP_LABELS.ERROR_GENERIC);
    });
    expect(screen.queryByTestId('twofactor-error')).not.toHaveTextContent(
      TWO_FACTOR_SETUP_LABELS.ERROR_STEP_UP_FAILED,
    );
  });

  it('R2: a HUNG challenge() call during initial verify times out to the generic error instead of spinning forever', async () => {
    vi.useFakeTimers();
    mockListFactors.mockResolvedValue(mkListFactorsResponse([]));
    mockEnroll.mockResolvedValueOnce({
      data: {
        id: 'factor-new',
        type: 'totp',
        totp: { qr_code: 'data:image/svg+xml;base64,test', secret: 'JBSWY3DPEHPK3PXP', uri: '' },
      },
      error: null,
    });
    mockChallenge.mockReturnValueOnce(new Promise(() => {}));

    render(<TwoFactorSetup />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByTestId('twofactor-enable'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.change(screen.getByTestId('twofactor-verify-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('twofactor-verify-submit'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(screen.getByTestId('twofactor-error')).toHaveTextContent(TWO_FACTOR_SETUP_LABELS.ERROR_GENERIC);
  });

  it('lists both verified and unverified factors with status badges (E1: sourced from data.all, not the verified-only data.totp)', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([verifiedFactor(), unverifiedFactor()]));

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-factors')).toBeInTheDocument();
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

  it('E1: an UNVERIFIED-ONLY user (no verified factor at all) sees a "Setup incomplete" row with Remove, sourced from data.all', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([unverifiedFactor()]));

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-factor-factor-unverified')).toBeInTheDocument();
    });

    expect(screen.getByTestId('twofactor-factor-factor-unverified')).toHaveTextContent(
      TWO_FACTOR_SETUP_LABELS.STATUS_INCOMPLETE,
    );
    expect(screen.getByTestId('twofactor-remove-factor-unverified')).toBeInTheDocument();
    // Since data.totp (verified-only) is empty, the pre-fix bug would have
    // shown ZERO factors and the "Enable" CTA instead of "Add backup" —
    // this pins that hasVerifiedFactor correctly reads false while a
    // (merely unverified) factor is still visible.
    expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument();
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
    expect((screen.getByTestId('twofactor-friendly-name') as HTMLInputElement).value).toMatch(
      /^Authenticator \d{4}-\d{2}-\d{2}-[0-9a-f]+$/,
    );

    fireEvent.change(screen.getByTestId('twofactor-verify-code'), { target: { value: '123456' } });

    // After verifying, the factor is now "enabled" — reflect it in the next listFactors() call.
    mockListFactors.mockResolvedValueOnce(mkListFactorsResponse([verifiedFactor('factor-new')]));

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

  it('D4: pressing Enter in the verify-code field submits (real <form>, not a bare div + onClick)', async () => {
    mockEnroll.mockResolvedValueOnce(mkEnrollResponse());
    mockChallenge.mockResolvedValueOnce({ data: { id: 'challenge-1' }, error: null });
    mockVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-enable'));
    await waitFor(() => expect(screen.getByTestId('twofactor-verify-code')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('twofactor-verify-code'), { target: { value: '123456' } });
    fireEvent.submit(screen.getByTestId('twofactor-verify-code').closest('form')!);

    await waitFor(() => {
      expect(mockChallenge).toHaveBeenCalledWith({ factorId: 'factor-new' });
    });
  });

  it('D3: the verify-code and step-up-code inputs carry one-time-code UX attributes', async () => {
    mockEnroll.mockResolvedValueOnce(mkEnrollResponse());
    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-enable'));
    await waitFor(() => expect(screen.getByTestId('twofactor-verify-code')).toBeInTheDocument());

    const verifyInput = screen.getByTestId('twofactor-verify-code');
    expect(verifyInput).toHaveAttribute('inputMode', 'numeric');
    expect(verifyInput).toHaveAttribute('autoComplete', 'one-time-code');
    expect(verifyInput).toHaveAttribute('pattern', '[0-9]*');
  });

  it('add-backup flow: one verified factor -> add backup -> enroll succeeds directly (already aal2)', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([verifiedFactor()]));
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

  it('A2-3: two consecutive default friendly names differ (random suffix, not a deterministic per-day name)', async () => {
    mockEnroll.mockResolvedValue(mkEnrollResponse());
    mockUnenroll.mockResolvedValue({ data: {}, error: null });

    const { unmount } = render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-enable'));
    await waitFor(() => expect(mockEnroll).toHaveBeenCalledTimes(1));
    const firstName = mockEnroll.mock.calls[0][0].friendlyName;
    unmount();

    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-enable'));
    await waitFor(() => expect(mockEnroll).toHaveBeenCalledTimes(2));
    const secondName = mockEnroll.mock.calls[1][0].friendlyName;

    expect(secondName).not.toBe(firstName);
    expect(firstName).toMatch(/^Authenticator \d{4}-\d{2}-\d{2}-[0-9a-f]+$/);
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

  it('A2-2: mfa_verified_factor_exists refreshes the list and returns to it, instead of a raw error', async () => {
    mockEnroll.mockResolvedValueOnce({
      data: null,
      error: { message: 'A verified factor already exists', code: 'mfa_verified_factor_exists' },
    });

    render(<TwoFactorSetup />);

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument();
    });

    // The refresh this triggers (once enroll() reports the conflict)
    // reveals the factor that already exists elsewhere (e.g. verified in
    // another tab / a racing session) — queued AFTER the initial mount's
    // listFactors() call, which must still see the empty starting state.
    mockListFactors.mockResolvedValueOnce(mkListFactorsResponse([verifiedFactor()]));
    fireEvent.click(screen.getByTestId('twofactor-enable'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-factor-factor-verified')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('twofactor-error')).not.toBeInTheDocument();
    expect(screen.queryByTestId('twofactor-qr')).not.toBeInTheDocument();
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

  // -----------------------------------------------------------------------
  // E3: all four handlers reset `busy` and surface ERROR_GENERIC on a
  // thrown rejection instead of getting stuck.
  // -----------------------------------------------------------------------

  it('E3: a thrown enroll() rejection resets busy and shows ERROR_GENERIC', async () => {
    mockEnroll.mockRejectedValueOnce(new TypeError('network exploded'));

    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-enable'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-error')).toHaveTextContent(TWO_FACTOR_SETUP_LABELS.ERROR_GENERIC);
    });
    expect(screen.getByTestId('twofactor-enable')).not.toBeDisabled();
  });

  it('E3: a thrown unenroll() rejection resets busy and shows ERROR_GENERIC', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([verifiedFactor()]));
    mockUnenroll.mockRejectedValueOnce(new TypeError('network exploded'));

    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-remove-factor-verified')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-remove-factor-verified'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-error')).toHaveTextContent(TWO_FACTOR_SETUP_LABELS.ERROR_GENERIC);
    });
    expect(screen.getByTestId('twofactor-remove-factor-verified')).not.toBeDisabled();
  });

  it('E3: a thrown challenge() rejection during verify resets busy and shows ERROR_GENERIC', async () => {
    mockEnroll.mockResolvedValueOnce(mkEnrollResponse());
    mockChallenge.mockRejectedValueOnce(new TypeError('network exploded'));

    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-enable'));
    await waitFor(() => expect(screen.getByTestId('twofactor-verify-code')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('twofactor-verify-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('twofactor-verify-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-error')).toHaveTextContent(TWO_FACTOR_SETUP_LABELS.ERROR_GENERIC);
    });
    expect(screen.getByTestId('twofactor-verify-submit')).not.toBeDisabled();
  });

  it('E3: a thrown challengeAndVerify() rejection during step-up resets busy and shows ERROR_GENERIC', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([verifiedFactor()]));
    mockEnroll.mockResolvedValueOnce({
      data: null,
      error: { message: 'AAL2 required', code: 'insufficient_aal' },
    });
    mockChallengeAndVerify.mockRejectedValueOnce(new TypeError('network exploded'));

    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-add-backup')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-add-backup'));
    await waitFor(() => expect(screen.getByTestId('twofactor-stepup')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('twofactor-stepup-code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByTestId('twofactor-stepup-submit'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-error')).toHaveTextContent(TWO_FACTOR_SETUP_LABELS.ERROR_GENERIC);
    });
    expect(screen.getByTestId('twofactor-stepup-submit')).not.toBeDisabled();
  });

  it('insufficient_aal on enroll -> step-up -> retry succeeds -> QR is shown', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([verifiedFactor()]));
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

  it('A2-5: a successful step-up calls safeRefreshSession() IMMEDIATELY, before the deferred action even starts retrying', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([verifiedFactor()]));
    mockEnroll.mockResolvedValueOnce({
      data: null,
      error: { message: 'AAL2 required', code: 'insufficient_aal' },
    });
    mockChallengeAndVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    // The retried enroll() call order-checks that refreshSession already
    // happened by the time it runs.
    let refreshedBeforeRetry = false;
    mockEnroll.mockImplementationOnce(async () => {
      refreshedBeforeRetry = mockRefreshSession.mock.calls.length > 0;
      return mkEnrollResponse({ id: 'factor-backup' });
    });

    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-add-backup')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-add-backup'));
    await waitFor(() => expect(screen.getByTestId('twofactor-stepup')).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('twofactor-stepup-code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByTestId('twofactor-stepup-submit'));

    await waitFor(() => {
      expect(mockEnroll).toHaveBeenCalledTimes(2);
    });
    expect(refreshedBeforeRetry).toBe(true);
  });

  it('unenroll of a verified factor: insufficient_aal -> step-up -> retry unenrolls and refreshes', async () => {
    mockListFactors
      .mockResolvedValueOnce(mkListFactorsResponse([verifiedFactor(), verifiedFactor('factor-other', 'Backup')]));
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
    mockListFactors.mockResolvedValueOnce(mkListFactorsResponse([verifiedFactor()]));

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
    mockListFactors.mockResolvedValueOnce(mkListFactorsResponse([unverifiedFactor()]));
    mockUnenroll.mockResolvedValueOnce({ data: {}, error: null });
    mockListFactors.mockResolvedValueOnce(mkListFactorsResponse([]));

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
    mockListFactors.mockResolvedValue(mkListFactorsResponse([verifiedFactor()]));
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

  it('D3/D4: the step-up-code input carries one-time-code attributes and Enter submits', async () => {
    mockListFactors.mockResolvedValue(mkListFactorsResponse([verifiedFactor()]));
    mockEnroll.mockResolvedValueOnce({
      data: null,
      error: { message: 'AAL2 required', code: 'insufficient_aal' },
    });
    mockChallengeAndVerify.mockResolvedValueOnce({ data: { session: {} }, error: null });

    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-add-backup')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-add-backup'));
    await waitFor(() => expect(screen.getByTestId('twofactor-stepup-code')).toBeInTheDocument());

    const stepUpInput = screen.getByTestId('twofactor-stepup-code');
    expect(stepUpInput).toHaveAttribute('inputMode', 'numeric');
    expect(stepUpInput).toHaveAttribute('autoComplete', 'one-time-code');
    expect(stepUpInput).toHaveAttribute('pattern', '[0-9]*');

    fireEvent.change(stepUpInput, { target: { value: '654321' } });
    fireEvent.submit(stepUpInput.closest('form')!);

    await waitFor(() => {
      expect(mockChallengeAndVerify).toHaveBeenCalledWith({ factorId: 'factor-verified', code: '654321' });
    });
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

  // -----------------------------------------------------------------------
  // A2-4: the enrolling view has a Cancel control that unenrolls the
  // just-created (unverified, aal1-removable) factor rather than
  // abandoning it as an orphan.
  // -----------------------------------------------------------------------

  it('A2-4: Cancel during enrollment unenrolls the just-created factor and returns to the list', async () => {
    mockEnroll.mockResolvedValueOnce(mkEnrollResponse({ id: 'factor-new' }));

    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-enable'));
    await waitFor(() => expect(screen.getByTestId('twofactor-qr')).toBeInTheDocument());

    mockListFactors.mockResolvedValueOnce(mkListFactorsResponse([]));
    fireEvent.click(screen.getByTestId('twofactor-cancel-enrollment'));

    await waitFor(() => {
      expect(mockUnenroll).toHaveBeenCalledWith({ factorId: 'factor-new' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('twofactor-qr')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument();
  });

  it('A2-4: Cancel is disabled while busy', async () => {
    mockEnroll.mockResolvedValueOnce(mkEnrollResponse({ id: 'factor-new' }));

    render(<TwoFactorSetup />);
    await waitFor(() => expect(screen.getByTestId('twofactor-enable')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('twofactor-enable'));
    await waitFor(() => expect(screen.getByTestId('twofactor-qr')).toBeInTheDocument());

    let resolveUnenroll!: (v: { data: unknown; error: null }) => void;
    mockUnenroll.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUnenroll = resolve;
      })
    );

    fireEvent.click(screen.getByTestId('twofactor-cancel-enrollment'));

    await waitFor(() => {
      expect(screen.getByTestId('twofactor-cancel-enrollment')).toBeDisabled();
    });

    resolveUnenroll({ data: {}, error: null });
  });
});

/**
 * SCRUM-1631 (PR #680) tests — shared anchor-credit gate helper.
 *
 * Pins the 402/503/402 response shapes that both /api/v1/anchor and
 * /api/v1/contracts/anchor-pre-signing rely on. The endpoint-level tests
 * already pin call-site behavior; these tests pin the helper's contract
 * in isolation so future refactors of the helper alone get caught.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

const mockDeductOrgCredit = vi.hoisted(() => vi.fn());
vi.mock('./orgCredits.js', () => ({
  deductOrgCredit: mockDeductOrgCredit,
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ensureAnchorCreditAvailable } from './anchorCreditGate.js';

function makeRes(): Response {
  // Minimal Express Response mock — only needs status() + json() + chainability.
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  (res.json as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

// The helper is pure relative to deductOrgCredit; we don't actually need
// a real Supabase client to test it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeDb = {} as any;

describe('ensureAnchorCreditAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true and writes nothing when deduction succeeds', async () => {
    mockDeductOrgCredit.mockResolvedValue({ allowed: true });
    const res = makeRes();

    const ok = await ensureAnchorCreditAvailable(fakeDb, 'org-1', res);
    expect(ok).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('writes 402 insufficient_credits with balance + required when out of credits', async () => {
    mockDeductOrgCredit.mockResolvedValue({
      allowed: false,
      error: 'insufficient_credits',
      balance: 0,
      required: 1,
    });
    const res = makeRes();

    const ok = await ensureAnchorCreditAvailable(fakeDb, 'org-1', res);
    expect(ok).toBe(false);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      error: 'insufficient_credits',
      message: 'Organization has insufficient anchor credits for this cycle.',
      balance: 0,
      required: 1,
    });
  });

  it('writes 503 credit_check_unavailable when deduction RPC fails', async () => {
    mockDeductOrgCredit.mockResolvedValue({
      allowed: false,
      error: 'rpc_failure',
      message: 'connection reset',
    });
    const res = makeRes();

    const ok = await ensureAnchorCreditAvailable(fakeDb, 'org-1', res);
    expect(ok).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'credit_check_unavailable' });
  });

  it('writes 402 org_credits_not_initialized for the org_not_initialized branch', async () => {
    // Per CodeRabbit on PR #680: the real deductOrgCredit() contract emits
    // `error: 'org_not_initialized'` for orgs without a credit ledger row.
    // Pinning the actual error value (rather than just `allowed: false`)
    // means a future helper change that tightens the switch on `error` —
    // e.g., adding a separate code for "expired" — surfaces here.
    mockDeductOrgCredit.mockResolvedValue({
      allowed: false,
      error: 'org_not_initialized',
    });
    const res = makeRes();

    const ok = await ensureAnchorCreditAvailable(fakeDb, 'org-1', res);
    expect(ok).toBe(false);
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.json).toHaveBeenCalledWith({
      error: 'org_credits_not_initialized',
      message:
        'This organization is not provisioned for credit-based billing. ' +
        'An operator must seed org_credits before this API key can submit.',
    });
  });
});

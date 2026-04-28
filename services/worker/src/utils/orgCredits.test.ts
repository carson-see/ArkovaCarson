/**
 * SCRUM-1170-B — orgCredits helper tests.
 *
 * Pin every branch of the deduct-credit response shape so /api/v1/anchor
 * (the eventual caller) has a stable contract. The actual RPC is exercised
 * separately via Supabase migration tests; this file mocks it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc, mockConfig } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockConfig: { enableOrgCreditEnforcement: false },
}));

vi.mock('../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

vi.mock('./db.js', () => ({ db: { rpc: mockRpc } }));

import { deductOrgCredit } from './orgCredits.js';
import { db } from './db.js';

const ORG = '00000000-0000-0000-0000-000000000001';

describe('deductOrgCredit (SCRUM-1170-B)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockConfig.enableOrgCreditEnforcement = false;
  });

  it('short-circuits when flag is off (existing callers unaffected)', async () => {
    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create');
    expect(out).toEqual({ allowed: true, reason: 'feature_disabled' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns allowed=true with new balance on RPC success', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({ data: { success: true, balance: 99, deducted: 1 }, error: null });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create');

    expect(out).toEqual({ allowed: true, balance: 99 });
    expect(mockRpc).toHaveBeenCalledWith('deduct_org_credit', {
      p_org_id: ORG,
      p_amount: 1,
      p_reason: 'anchor.create',
      p_reference_id: null,
    });
  });

  it('surfaces insufficient_credits with balance + required for the API 402 body', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({
      data: { success: false, error: 'insufficient_credits', balance: 0, required: 1 },
      error: null,
    });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create');

    expect(out).toEqual({
      allowed: false,
      error: 'insufficient_credits',
      balance: 0,
      required: 1,
    });
  });

  it('surfaces org_not_initialized when the row is missing', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({
      data: { success: false, error: 'org_not_initialized' },
      error: null,
    });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create');

    expect(out).toEqual({ allowed: false, error: 'org_not_initialized' });
  });

  it('surfaces rpc_failure on a PostgREST/network error', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'connection refused' } });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create');

    expect(out.allowed).toBe(false);
    expect(out.error).toBe('rpc_failure');
    expect(out.message).toBe('connection refused');
  });

  it('passes a reference_id through to the RPC when provided', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({ data: { success: true, balance: 50 }, error: null });

    await deductOrgCredit(db, ORG, 1, 'anchor.create', 'anchor-ref-uuid');

    expect(mockRpc).toHaveBeenCalledWith('deduct_org_credit', {
      p_org_id: ORG,
      p_amount: 1,
      p_reason: 'anchor.create',
      p_reference_id: 'anchor-ref-uuid',
    });
  });

  it('treats unknown rpc-error values as rpc_failure (safe default)', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({
      data: { success: false, error: 'something_new' },
      error: null,
    });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create');

    expect(out.allowed).toBe(false);
    expect(out.error).toBe('rpc_failure');
  });
});

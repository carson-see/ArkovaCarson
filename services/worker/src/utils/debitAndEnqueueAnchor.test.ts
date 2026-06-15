/**
 * SCRUM-2350 (QUEUE-04) — debitAndEnqueueAnchor helper tests.
 *
 * Pins the response shape of the worker wrapper around the atomic
 * `debit_and_enqueue_anchor` RPC. The actual RPC semantics (atomicity,
 * idempotent replay, crash-between-steps, insufficient-credit-no-partial-debit)
 * are exercised against a live Postgres in
 * supabase/tests/0341_credit_foundation_test.sql; this file mocks the RPC.
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

import { debitAndEnqueueAnchor } from './orgCredits.js';
import { db } from './db.js';

const ORG = '10000000-1000-4000-8000-000000000001';
const ANCHOR = '20000000-2000-4000-8000-000000000002';

describe('debitAndEnqueueAnchor (SCRUM-2350)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockConfig.enableOrgCreditEnforcement = false;
  });

  it('short-circuits when org-credit enforcement is off (anchor enqueues free)', async () => {
    const out = await debitAndEnqueueAnchor(db, {
      orgId: ORG,
      anchorId: ANCHOR,
      reason: 'rule.fast_track_anchor_queue_run',
    });
    expect(out).toEqual({ allowed: true, reason: 'feature_disabled' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('calls the atomic RPC with the per-anchor reference id (NOT a batch id)', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({
      data: { success: true, balance: 41, deducted: 1, anchor_status: 'BROADCASTING' },
      error: null,
    });

    const out = await debitAndEnqueueAnchor(db, {
      orgId: ORG,
      anchorId: ANCHOR,
      reason: 'rule.auto_anchor_queue_run',
      targetStatus: 'BROADCASTING',
      expectedStatus: 'PENDING',
    });

    expect(out).toEqual({ allowed: true, balance: 41, anchorStatus: 'BROADCASTING' });
    expect(mockRpc).toHaveBeenCalledWith('debit_and_enqueue_anchor', {
      p_org_id: ORG,
      p_anchor_id: ANCHOR,
      p_amount: 1,
      p_reason: 'rule.auto_anchor_queue_run',
      p_target_status: 'BROADCASTING',
      p_expected_status: 'PENDING',
    });
  });

  it('surfaces idempotent=true when the RPC replayed an existing debit (crash retry)', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({
      data: { success: true, balance: 41, deducted: 0, idempotent: true, anchor_status: 'BROADCASTING' },
      error: null,
    });

    const out = await debitAndEnqueueAnchor(db, { orgId: ORG, anchorId: ANCHOR, reason: 'anchor.secure' });

    expect(out).toEqual({ allowed: true, balance: 41, idempotent: true, anchorStatus: 'BROADCASTING' });
  });

  it('surfaces insufficient_credits with no partial debit (item stays queued)', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({
      data: { success: false, error: 'insufficient_credits', balance: 0, required: 1 },
      error: null,
    });

    const out = await debitAndEnqueueAnchor(db, { orgId: ORG, anchorId: ANCHOR, reason: 'anchor.secure' });

    expect(out).toEqual({ allowed: false, error: 'insufficient_credits', balance: 0, required: 1 });
  });

  it('surfaces anchor_not_in_expected_status as a non-charged conflict', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({
      data: { success: false, error: 'anchor_not_in_expected_status', anchor_status: 'SUBMITTED' },
      error: null,
    });

    const out = await debitAndEnqueueAnchor(db, { orgId: ORG, anchorId: ANCHOR, reason: 'anchor.secure' });

    expect(out.allowed).toBe(false);
    expect(out.error).toBe('anchor_not_in_expected_status');
  });

  it('surfaces org_not_initialized', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({
      data: { success: false, error: 'org_not_initialized' },
      error: null,
    });

    const out = await debitAndEnqueueAnchor(db, { orgId: ORG, anchorId: ANCHOR, reason: 'anchor.secure' });

    expect(out).toEqual({ allowed: false, error: 'org_not_initialized' });
  });

  it('surfaces rpc_failure on a PostgREST/network error (caller leaves item queued)', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'connection refused' } });

    const out = await debitAndEnqueueAnchor(db, { orgId: ORG, anchorId: ANCHOR, reason: 'anchor.secure' });

    expect(out.allowed).toBe(false);
    expect(out.error).toBe('rpc_failure');
    expect(out.message).toBe('connection refused');
  });

  it('defaults amount to 1 and statuses to PENDING->BROADCASTING', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({ data: { success: true, balance: 9, deducted: 1 }, error: null });

    await debitAndEnqueueAnchor(db, { orgId: ORG, anchorId: ANCHOR, reason: 'anchor.secure' });

    expect(mockRpc).toHaveBeenCalledWith('debit_and_enqueue_anchor', {
      p_org_id: ORG,
      p_anchor_id: ANCHOR,
      p_amount: 1,
      p_reason: 'anchor.secure',
      p_target_status: 'BROADCASTING',
      p_expected_status: 'PENDING',
    });
  });
});

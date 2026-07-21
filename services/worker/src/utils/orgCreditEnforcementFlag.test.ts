/**
 * G4 (PI-0.5 24h slice) — ENABLE_ORG_CREDIT_ENFORCEMENT fail-closed semantics.
 *
 * Pairs with `src/tests/0363-enable-org-credit-enforcement-flag.test.ts`
 * (which pins the migration + seed artifacts). This file pins the WORKER
 * behavior the seed must match, verified against the existing code paths:
 *
 *  - `config.enableOrgCreditEnforcement` is env-backed with Zod default
 *    `false` (`services/worker/src/config.ts` `boolFlag(false)`), and is the
 *    single gate consulted by `deductOrgCredit` (`utils/orgCredits.ts`).
 *    The DB `get_flag()` RPC likewise returns its `p_default = false` for an
 *    absent row — so "row missing" and "row seeded enabled=false" are the
 *    SAME designed state: enforcement OFF, anchoring proceeds ungated.
 *
 *  - Fail-closed is scoped to the ENFORCED path only: when enforcement is ON
 *    and the credit RPC errors, the request gets 503
 *    `credit_check_unavailable` (no silent free anchoring) — but a missing /
 *    false flag NEVER hard-blocks the anchor path for non-credit orgs,
 *    because the flag-off short-circuit runs before any RPC.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response } from 'express';

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

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { deductOrgCredit } from './orgCredits.js';
import { ensureAnchorCreditAvailable } from './anchorCreditGate.js';
import { db } from './db.js';

const ORG = '10000000-1000-4000-8000-000000000001';
const REF = '20000000-2000-4000-8000-000000000002';

function mockRes(): Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & typeof res;
}

describe('G4: ENABLE_ORG_CREDIT_ENFORCEMENT off-by-default (absent/false row → NOT enforcing)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockConfig.enableOrgCreditEnforcement = false;
  });

  it('flag OFF (the seeded default) short-circuits deduction: allowed=true, feature_disabled, no RPC touched', async () => {
    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create', REF);
    expect(out).toEqual({ allowed: true, reason: 'feature_disabled' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('flag OFF does NOT hard-block the anchor path: gate returns true and writes no error response (non-credit orgs unaffected)', async () => {
    const res = mockRes();
    const proceed = await ensureAnchorCreditAvailable(db, ORG, res, REF);
    expect(proceed).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('G4: fail-closed path — enforcement ON + flag/credit read failure must not silently allow free anchoring', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockConfig.enableOrgCreditEnforcement = true;
  });

  it('credit RPC error fails CLOSED per-request: allowed=false / rpc_failure, never allowed=true', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create', REF);
    expect(out.allowed).toBe(false);
    expect(out.error).toBe('rpc_failure');
  });

  it('gate maps the rpc_failure to 503 credit_check_unavailable (bounded outage response, not unlimited free anchoring)', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: 'connection reset' } });
    const res = mockRes();
    const proceed = await ensureAnchorCreditAvailable(db, ORG, res, REF);
    expect(proceed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: 'credit_check_unavailable' });
  });

  it('empty RPC response also fails CLOSED (no undefined-row free pass)', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create', REF);
    expect(out.allowed).toBe(false);
    expect(out.error).toBe('rpc_failure');
  });
});

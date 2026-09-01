/**
 * SCRUM-3866 — per-org credit enforcement scope.
 *
 * Pre-mortem F2: `ENABLE_ORG_CREDIT_ENFORCEMENT` is a single GLOBAL flag, so
 * enabling it to make one partner's sub-org budgets mean anything would 402
 * every other zero-balance org in prod — 7 of 13 at the time of writing,
 * including the Login Defense partner org and the UAT demo org. Migration 0429
 * adds `organizations.credit_enforcement_enabled` so the scope can be one org
 * (or one org tree) instead of the whole tenant base.
 *
 * Contract pinned here:
 *   - enforced  ⇔  global flag ON  OR  that org's column is true
 *   - global ON short-circuits: no per-org lookup, no extra round trip
 *   - a lookup that errors or finds no row FAILS OPEN
 *
 * Fail-open is deliberate and matches the design intent already pinned by
 * `orgCreditEnforcementFlag.test.ts`: "a missing / false flag NEVER hard-blocks
 * the anchor path for non-credit orgs". Failing closed here would turn a
 * transient read error into a 503 for every org on the platform, to protect a
 * budget that applies to one partner. The residual risk — an enrolled org gets
 * an unbilled anchor during a database incident — is bounded and is logged at
 * error level for reconciliation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRpc, mockFrom, mockConfig, mockLoggerError } = vi.hoisted(() => ({
  mockRpc: vi.fn(),
  mockFrom: vi.fn(),
  mockConfig: { enableOrgCreditEnforcement: false },
  mockLoggerError: vi.fn(),
}));

vi.mock('../config.js', () => ({
  get config() {
    return mockConfig;
  },
}));

vi.mock('./db.js', () => ({ db: { rpc: mockRpc, from: mockFrom } }));

vi.mock('./logger.js', () => ({
  logger: { error: mockLoggerError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { deductOrgCredit, __resetOrgCreditEnforcementCache } from './orgCredits.js';
import { db } from './db.js';

const ORG = '10000000-1000-4000-8000-000000000001';

/** Mimics `db.from('organizations').select(...).eq('id', ...).maybeSingle()`. */
function mockOrgLookup(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  mockFrom.mockReturnValue({ select });
  return { select, eq, maybeSingle };
}

describe('per-org credit enforcement (SCRUM-3866)', () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockFrom.mockReset();
    mockLoggerError.mockReset();
    mockConfig.enableOrgCreditEnforcement = false;
    __resetOrgCreditEnforcementCache();
  });

  it('global off + org not enrolled: allowed, and never touches the RPC', async () => {
    mockOrgLookup({ data: { credit_enforcement_enabled: false }, error: null });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-1');

    expect(out).toEqual({ allowed: true, reason: 'feature_disabled' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('global off + org ENROLLED: enforcement runs for that org alone', async () => {
    mockOrgLookup({ data: { credit_enforcement_enabled: true }, error: null });
    mockRpc.mockResolvedValueOnce({ data: { success: true, balance: 41 }, error: null });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-2');

    expect(out).toEqual({ allowed: true, balance: 41 });
    expect(mockRpc).toHaveBeenCalledWith('deduct_org_credit', {
      p_org_id: ORG,
      p_amount: 1,
      p_reason: 'anchor.create',
      p_reference_id: 'ref-2',
    });
  });

  it('enrolled org at zero balance still gets the frozen 402 shape', async () => {
    mockOrgLookup({ data: { credit_enforcement_enabled: true }, error: null });
    mockRpc.mockResolvedValueOnce({
      data: { success: false, error: 'insufficient_credits', balance: 0, required: 1 },
      error: null,
    });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-3');

    expect(out).toEqual({
      allowed: false,
      error: 'insufficient_credits',
      balance: 0,
      required: 1,
    });
  });

  it('global ON short-circuits: no per-org lookup, no extra round trip', async () => {
    mockConfig.enableOrgCreditEnforcement = true;
    mockRpc.mockResolvedValueOnce({ data: { success: true, balance: 7 }, error: null });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-4');

    expect(out).toEqual({ allowed: true, balance: 7 });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it('lookup error FAILS OPEN and is logged for reconciliation', async () => {
    mockOrgLookup({ data: null, error: { message: 'connection reset' } });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-5');

    expect(out).toEqual({ allowed: true, reason: 'feature_disabled' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG }),
      'org_credit_enforcement_lookup_failed',
    );
  });

  it('missing org row fails open without logging an error', async () => {
    mockOrgLookup({ data: null, error: null });

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-6');

    expect(out).toEqual({ allowed: true, reason: 'feature_disabled' });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it('memoises the enrolment answer instead of re-reading per anchor', async () => {
    // batch-anchor.ts calls deductOrgCredit once per anchor inside a sequential
    // loop over up to BATCH_SIZE claimed anchors, so an unconditional lookup
    // would add a round trip per anchor to the nightly drain.
    mockOrgLookup({ data: { credit_enforcement_enabled: false }, error: null });

    await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-a');
    await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-b');
    await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-c');

    expect(mockFrom).toHaveBeenCalledTimes(1);
  });

  it('does not memoise a failed read', async () => {
    mockOrgLookup({ data: null, error: { message: 'connection reset' } });

    await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-d');
    await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-e');

    // Caching an outage would extend unbilled anchoring past the incident.
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it('a THROWN rejection also fails open, not 500', async () => {
    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.reject(new Error('socket hang up')) }),
      }),
    }));

    const out = await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-f');

    expect(out).toEqual({ allowed: true, reason: 'feature_disabled' });
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG }),
      'org_credit_enforcement_lookup_failed',
    );
  });

  it('reads only the enforcement column, scoped to the one org', async () => {
    const { select, eq } = mockOrgLookup({
      data: { credit_enforcement_enabled: false },
      error: null,
    });

    await deductOrgCredit(db, ORG, 1, 'anchor.create', 'ref-7');

    expect(mockFrom).toHaveBeenCalledWith('organizations');
    expect(select).toHaveBeenCalledWith('credit_enforcement_enabled');
    expect(eq).toHaveBeenCalledWith('id', ORG);
  });
});

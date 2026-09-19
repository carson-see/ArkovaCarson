/**
 * Tests for the SCRUM-1740 anchor quota gate.
 *
 * Pins the contract that:
 *   - prod orgs (anchor_quota = NULL) are never gated
 *   - cap_enforced = false is never gated, whatever is_test says
 *   - cap_enforced = true IS gated even when is_test = false (SCRUM-4474:
 *     a billable customer may carry a contractual cap)
 *   - sandbox orgs are allowed under the cap
 *   - sandbox orgs get 402 problem+json with type "quota-exhausted" at the cap
 *   - config and usage read failures fail CLOSED with a retryable 503
 */

import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { ensureAnchorQuotaAvailable } from './anchorQuotaGate.js';

vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

interface OrgRow {
  is_test: boolean | null;
  anchor_quota: number | null;
  cap_enforced?: boolean | null;
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; type: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const type = vi.fn(() => ({ json }));
  const status = vi.fn(() => ({ type, json }));
  const res = { status, type, json } as unknown as Response;
  return { res, status, type, json };
}

interface FakeDbOpts {
  org?: OrgRow | null;
  orgError?: { message: string } | null;
  count?: number;
  countError?: { message: string } | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(opts: FakeDbOpts): any {
  return {
    from: vi.fn((table: string) => {
      if (table === 'org_credits') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: opts.org ?? null,
                error: opts.orgError ?? null,
              })),
            })),
          })),
        };
      }
      if (table === 'anchors') {
        // After SCRUM-1254 refactor: select('id').eq.is.limit(quota+1)
        // returns rows array; quota gate counts rows.length. Build a chain
        // that resolves with `data: <rows-of-length-count>`.
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              is: vi.fn(() => ({
                limit: vi.fn(async () => ({
                  data: opts.countError ? null : Array.from({ length: opts.count ?? 0 }, (_, i) => ({ id: `id-${i}` })),
                  error: opts.countError ?? null,
                })),
              })),
            })),
          })),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

describe('ensureAnchorQuotaAvailable', () => {
  it('allows when org_credits row is missing (no test-org config)', async () => {
    const db = makeDb({ org: null });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('allows prod orgs (anchor_quota = NULL)', async () => {
    const db = makeDb({ org: { is_test: false, anchor_quota: null } });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('allows an org whose cap is NOT enforced, even with a quota set and far over it', async () => {
    // The Login Defense shape: anchor_quota = 15 recorded, is_test = false, so
    // the quota is inert. SCRUM-4474 preserved that exactly rather than letting
    // a stored number start biting on its own.
    const db = makeDb({ org: { is_test: false, anchor_quota: 10, cap_enforced: false }, count: 50 });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('allows a TEST org whose cap is not enforced (is_test alone no longer gates)', async () => {
    const db = makeDb({ org: { is_test: true, anchor_quota: 10, cap_enforced: false }, count: 50 });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('GATES a billable org (is_test = false) when its cap is enforced', async () => {
    // The reason SCRUM-4474 exists. HakiChain is invoiced, not a test org, and
    // is contractually capped at 2,000. Before this change the only way to get
    // the cap enforced was to flag them is_test = true, which also excluded
    // them from Stripe metered billing.
    const db = makeDb({ org: { is_test: false, anchor_quota: 2000, cap_enforced: true }, count: 2000 });
    const { res, status, json } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(false);
    expect(status).toHaveBeenCalledWith(402);
    expect(json.mock.calls[0][0].quota).toBe(2000);
  });

  it('allows a billable capped org that is still under its cap', async () => {
    const db = makeDb({ org: { is_test: false, anchor_quota: 2000, cap_enforced: true }, count: 4 });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('allows sandbox org under the cap', async () => {
    const db = makeDb({ org: { is_test: true, anchor_quota: 10, cap_enforced: true }, count: 5 });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('blocks sandbox org at the cap with 402 problem+json', async () => {
    const db = makeDb({ org: { is_test: true, anchor_quota: 10, cap_enforced: true }, count: 10 });
    const { res, status, type, json } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(false);
    expect(status).toHaveBeenCalledWith(402);
    expect(type).toHaveBeenCalledWith('application/problem+json');
    const body = json.mock.calls[0][0];
    expect(body.type).toBe('https://arkova.ai/errors/quota-exhausted');
    expect(body.error).toBe('quota_exhausted');
    expect(body.status).toBe(402);
    expect(body.used).toBe(10);
    expect(body.quota).toBe(10);
    expect(body.message).toMatch(/used all 10/i);
  });

  it('blocks sandbox org over the cap (defensive: not just at exactly the cap)', async () => {
    const db = makeDb({ org: { is_test: true, anchor_quota: 10, cap_enforced: true }, count: 11 });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(false);
    expect(status).toHaveBeenCalledWith(402);
  });

  it('fails closed when the org_credits read fails (transient DB error)', async () => {
    const db = makeDb({ orgError: { message: 'connection reset' } });
    const { res, status, type, json } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(false);
    expect(status).toHaveBeenCalledWith(503);
    expect(type).toHaveBeenCalledWith('application/problem+json');
    expect(json).toHaveBeenCalledWith({
      type: 'https://arkova.ai/errors/quota-check-unavailable',
      title: 'Anchor quota check unavailable',
      status: 503,
      error: 'quota_check_unavailable',
      message: 'Anchor capacity could not be verified. Retry the request.',
    });
  });

  it('fails closed when the anchor usage read fails', async () => {
    const db = makeDb({ org: { is_test: true, anchor_quota: 10, cap_enforced: true }, countError: { message: 'timeout' } });
    const { res, status, type, json } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(false);
    expect(status).toHaveBeenCalledWith(503);
    expect(type).toHaveBeenCalledWith('application/problem+json');
    expect(json).toHaveBeenCalledWith({
      type: 'https://arkova.ai/errors/quota-check-unavailable',
      title: 'Anchor quota check unavailable',
      status: 503,
      error: 'quota_check_unavailable',
      message: 'Anchor capacity could not be verified. Retry the request.',
    });
  });
});

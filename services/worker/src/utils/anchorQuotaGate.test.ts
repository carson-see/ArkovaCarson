/**
 * Tests for the SCRUM-1740 anchor quota gate.
 *
 * Pins the contract that:
 *   - prod orgs (anchor_quota = NULL) are never gated
 *   - non-test orgs are never gated
 *   - sandbox orgs are allowed under the cap
 *   - sandbox orgs get 402 problem+json with type "quota-exhausted" at the cap
 *   - read failures fail OPEN (allow + log) — sandbox quota is a soft cap,
 *     not a security boundary
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
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              is: vi.fn(async () => ({
                count: opts.count ?? 0,
                error: opts.countError ?? null,
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

  it('allows non-test orgs even if anchor_quota is set (defensive: only is_test=true is gated)', async () => {
    const db = makeDb({ org: { is_test: false, anchor_quota: 10 }, count: 50 });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('allows sandbox org under the cap', async () => {
    const db = makeDb({ org: { is_test: true, anchor_quota: 10 }, count: 5 });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('blocks sandbox org at the cap with 402 problem+json', async () => {
    const db = makeDb({ org: { is_test: true, anchor_quota: 10 }, count: 10 });
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
    const db = makeDb({ org: { is_test: true, anchor_quota: 10 }, count: 11 });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(false);
    expect(status).toHaveBeenCalledWith(402);
  });

  it('fails open when the org_credits read fails (transient DB error)', async () => {
    const db = makeDb({ orgError: { message: 'connection reset' } });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });

  it('fails open when the anchor count read fails', async () => {
    const db = makeDb({ org: { is_test: true, anchor_quota: 10 }, countError: { message: 'timeout' } });
    const { res, status } = makeRes();
    await expect(ensureAnchorQuotaAvailable(db, 'org-1', res)).resolves.toBe(true);
    expect(status).not.toHaveBeenCalled();
  });
});

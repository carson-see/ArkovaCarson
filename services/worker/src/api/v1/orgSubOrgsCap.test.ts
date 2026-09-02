/**
 * SCRUM-3863 (D3) — the sub-org cap is real, not decorative.
 *
 * `organizations.max_sub_orgs` existed, was settable via POST /max and was
 * returned by the list endpoint — and was checked by NOTHING. A parent could
 * create unlimited affiliates. Carson set the limit at 20 on 2026-09-01; this
 * pins that it is actually enforced, on both paths that add a sub-org.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/db.js', () => ({ db: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../config.js', () => ({ config: { frontendUrl: 'https://app.test' } }));
vi.mock('../../email/templates.js', () => ({
  buildInvitationEmail: vi.fn(() => ({ subject: 'x', html: '<p>x</p>' })),
}));
vi.mock('../../email/sender.js', () => ({
  sendEmail: vi.fn(async () => ({ success: true, messageId: 'e1' })),
}));

import { DEFAULT_MAX_SUB_ORGS, resolveSubOrgCap } from './orgSubOrgs.js';
import { db } from '../../utils/db.js';

const PARENT = '22222222-2222-4222-8222-222222222222';

/** organizations.max_sub_orgs + a COUNT of approved children. */
function mockCap(opts: { max?: number | null; approved?: number; countError?: boolean }) {
  (db.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === 'organizations') {
      const chain = {
        select: (_cols: string, o?: { count?: string; head?: boolean }) =>
          o?.count
            ? {
                eq: () => ({
                  eq: () => Promise.resolve(
                    opts.countError
                      ? { count: null, error: { message: 'boom' } }
                      : { count: opts.approved ?? 0, error: null },
                  ),
                }),
              }
            : chain,
        eq: () => chain,
        maybeSingle: () => Promise.resolve({
          data: { max_sub_orgs: opts.max === undefined ? null : opts.max },
          error: null,
        }),
      };
      return chain;
    }
    throw new Error(`unexpected table ${table}`);
  });
}

describe('sub-org cap (D3)', () => {
  // Block body, NOT a concise arrow: `mockReset()` returns the mock, a concise
  // arrow returns it, and vitest treats a value returned from beforeEach as a
  // teardown function — so it called `db.from()` with no arguments after every
  // test and the stub threw "unexpected table undefined".
  beforeEach(() => {
    (db.from as ReturnType<typeof vi.fn>).mockReset();
  });

  it('defaults to 20 when the org has no explicit override', async () => {
    expect(DEFAULT_MAX_SUB_ORGS).toBe(20);
    mockCap({ max: null, approved: 5 });
    const cap = await resolveSubOrgCap(db, PARENT);
    expect(cap).toEqual({ ok: true, limit: 20, current: 5 });
  });

  it('refuses at the limit', async () => {
    mockCap({ max: null, approved: 20 });
    const cap = await resolveSubOrgCap(db, PARENT);
    expect(cap).toEqual({ ok: false, limit: 20, current: 20 });
  });

  it('honours an explicit per-org override above the default', async () => {
    mockCap({ max: 50, approved: 25 });
    expect(await resolveSubOrgCap(db, PARENT)).toEqual({ ok: true, limit: 50, current: 25 });
  });

  it('honours an explicit override BELOW the default', async () => {
    mockCap({ max: 3, approved: 3 });
    expect(await resolveSubOrgCap(db, PARENT)).toEqual({ ok: false, limit: 3, current: 3 });
  });

  it('treats an explicit 0 as a real zero, not as "unset"', async () => {
    // `max_sub_orgs ?? DEFAULT` would be 0 here only if written with ??, not
    // ||. A `||` would silently hand a barred org the full default of 20.
    mockCap({ max: 0, approved: 0 });
    expect(await resolveSubOrgCap(db, PARENT)).toEqual({ ok: false, limit: 0, current: 0 });
  });

  it('fails CLOSED when the count cannot be read', async () => {
    // Unlike the credit-enforcement lookup, guessing here would let a parent
    // walk past the cap during a database blip. Refusing costs one retry.
    mockCap({ max: null, countError: true });
    const cap = await resolveSubOrgCap(db, PARENT);
    expect(cap.ok).toBe(false);
    expect(cap).toMatchObject({ unavailable: true });
  });
});

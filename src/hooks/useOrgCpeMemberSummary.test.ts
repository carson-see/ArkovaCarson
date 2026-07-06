/**
 * CPE-02 (SCRUM-2380) — org CPE dashboard MVP data layer.
 *
 * Pins:
 *  - live Supabase reads over EXISTING tables only (anchors + profiles); the
 *    anchors read matches the 0342 partial-index shape
 *    (org_id + cpe_metadata IS NOT NULL, issued_at DESC).
 *  - org-admin path queries org-wide; a plain member's query is scoped to
 *    their OWN user_id (defense-in-depth on top of RLS).
 *  - per-member aggregation: secured vs pending counts + last activity.
 *  - §1.6: only user_id/status/issued_at are selected — never the cpe_metadata
 *    blob (member PII like participantName must not leave Postgres).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fromMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => fromMock(...args),
  },
}));

import { fetchOrgCpeMemberSummary } from './useOrgCpeMemberSummary';

interface QueryCapture {
  select: string | null;
  filters: Array<[string, ...unknown[]]>;
}

/** Chainable Supabase query-builder mock that records filters and resolves. */
function makeQuery(result: { data: unknown; error: { message: string } | null }) {
  const capture: QueryCapture = { select: null, filters: [] };
  const query: Record<string, unknown> = {};
  for (const method of ['eq', 'neq', 'not', 'is', 'in', 'gte', 'lte', 'order', 'limit']) {
    query[method] = vi.fn().mockImplementation((...args: unknown[]) => {
      capture.filters.push([method, ...args]);
      return query;
    });
  }
  query.select = vi.fn().mockImplementation((cols: string) => {
    capture.select = cols;
    return query;
  });
  (query as { then: unknown }).then = (
    resolve: (v: unknown) => void,
    reject: (e: unknown) => void,
  ) => Promise.resolve(result).then(resolve, reject);
  return { query, capture };
}

const ORG_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const ADMIN_ID = '44444444-0000-0000-0000-000000000001';
const MEMBER_ID = '44444444-0000-0000-0000-000000000002';

const ANCHOR_ROWS = [
  { user_id: ADMIN_ID, status: 'SECURED', issued_at: '2026-06-01T00:00:00.000Z' },
  { user_id: ADMIN_ID, status: 'SECURED', issued_at: '2026-05-01T00:00:00.000Z' },
  { user_id: ADMIN_ID, status: 'PENDING', issued_at: '2026-06-10T00:00:00.000Z' },
  { user_id: MEMBER_ID, status: 'SUBMITTED', issued_at: '2026-04-01T00:00:00.000Z' },
  { user_id: MEMBER_ID, status: 'SECURED', issued_at: '2026-03-01T00:00:00.000Z' },
];

const PROFILE_ROWS = [
  { id: ADMIN_ID, full_name: 'Carson Seeger', email: 'carson@arkova.ai' },
  { id: MEMBER_ID, full_name: null, email: 'sarah@arkova.ai' },
];

beforeEach(() => {
  fromMock.mockReset();
});

function wire(anchorsResult: { data: unknown; error: { message: string } | null }, profilesResult: { data: unknown; error: { message: string } | null }) {
  const anchors = makeQuery(anchorsResult);
  const profiles = makeQuery(profilesResult);
  fromMock.mockImplementation((table: string) =>
    table === 'anchors' ? anchors.query : profiles.query,
  );
  return { anchors, profiles };
}

describe('fetchOrgCpeMemberSummary — org admin', () => {
  it('aggregates per-member secured vs pending counts and last activity, org-wide', async () => {
    wire({ data: ANCHOR_ROWS, error: null }, { data: PROFILE_ROWS, error: null });

    const summary = await fetchOrgCpeMemberSummary({
      orgId: ORG_ID,
      userId: ADMIN_ID,
      isOrgAdmin: true,
      periodStart: null,
    });

    expect(summary.scopedToSelf).toBe(false);
    expect(summary.totals).toEqual({ members: 2, secured: 3, pending: 2 });

    const carson = summary.rows.find((r) => r.userId === ADMIN_ID);
    expect(carson).toMatchObject({
      displayName: 'Carson Seeger',
      identifier: 'carson@arkova.ai',
      securedCount: 2,
      pendingCount: 1,
      lastActivity: '2026-06-10T00:00:00.000Z',
    });

    const sarah = summary.rows.find((r) => r.userId === MEMBER_ID);
    // No full_name → falls back to the email identifier.
    expect(sarah).toMatchObject({
      displayName: 'sarah@arkova.ai',
      securedCount: 1,
      pendingCount: 1,
      lastActivity: '2026-04-01T00:00:00.000Z',
    });
  });

  it('queries the 0342 partial-index shape: org_id + cpe_metadata NOT NULL + issued_at DESC, no PII columns', async () => {
    const { anchors } = wire({ data: [], error: null }, { data: [], error: null });

    await fetchOrgCpeMemberSummary({
      orgId: ORG_ID,
      userId: ADMIN_ID,
      isOrgAdmin: true,
      periodStart: null,
    });

    // §1.6: never select the cpe_metadata blob (member PII stays in Postgres).
    expect(anchors.capture.select).toBe('user_id, status, issued_at');
    // Tenant scoping (arkova/no-unscoped-service-test): the org filter is real.
    expect(anchors.query.eq).toHaveBeenCalledWith('org_id', ORG_ID);
    expect(anchors.capture.filters).toContainEqual(['eq', 'org_id', ORG_ID]);
    expect(anchors.capture.filters).toContainEqual(['eq', 'credential_type', 'CPE']);
    expect(anchors.capture.filters).toContainEqual(['not', 'cpe_metadata', 'is', null]);
    expect(anchors.capture.filters).toContainEqual(['is', 'deleted_at', null]);
    expect(anchors.capture.filters).toContainEqual(['order', 'issued_at', { ascending: false }]);
    // Admin org-wide read must NOT be user-scoped.
    expect(anchors.capture.filters.some(([m, col]) => m === 'eq' && col === 'user_id')).toBe(false);
  });

  it('applies the reporting-period lower bound when provided', async () => {
    const { anchors } = wire({ data: [], error: null }, { data: [], error: null });

    await fetchOrgCpeMemberSummary({
      orgId: ORG_ID,
      userId: ADMIN_ID,
      isOrgAdmin: true,
      periodStart: '2026-01-01T00:00:00.000Z',
    });

    expect(anchors.capture.filters).toContainEqual(['gte', 'issued_at', '2026-01-01T00:00:00.000Z']);
  });

  it('throws when the anchors read fails (error banner, not silent zeros)', async () => {
    wire({ data: null, error: { message: 'boom' } }, { data: [], error: null });

    await expect(
      fetchOrgCpeMemberSummary({ orgId: ORG_ID, userId: ADMIN_ID, isOrgAdmin: true, periodStart: null }),
    ).rejects.toThrow();
  });

  it('degrades gracefully when the profiles read fails (identifiers fall back, counts intact)', async () => {
    wire({ data: ANCHOR_ROWS, error: null }, { data: null, error: { message: 'nope' } });

    const summary = await fetchOrgCpeMemberSummary({
      orgId: ORG_ID,
      userId: ADMIN_ID,
      isOrgAdmin: true,
      periodStart: null,
    });

    expect(summary.totals.secured).toBe(3);
    expect(summary.rows.every((r) => r.displayName.length > 0)).toBe(true);
  });
});

describe('fetchOrgCpeMemberSummary — plain member', () => {
  it('scopes the anchors AND profiles queries to the caller (own rows only)', async () => {
    const { anchors, profiles } = wire(
      { data: ANCHOR_ROWS.filter((r) => r.user_id === MEMBER_ID), error: null },
      { data: PROFILE_ROWS.filter((p) => p.id === MEMBER_ID), error: null },
    );

    const summary = await fetchOrgCpeMemberSummary({
      orgId: ORG_ID,
      userId: MEMBER_ID,
      isOrgAdmin: false,
      periodStart: null,
    });

    expect(summary.scopedToSelf).toBe(true);
    // Caller scoping (arkova/no-unscoped-service-test): pinned to own user_id.
    expect(anchors.query.eq).toHaveBeenCalledWith('user_id', MEMBER_ID);
    expect(anchors.capture.filters).toContainEqual(['eq', 'user_id', MEMBER_ID]);
    expect(profiles.capture.filters).toContainEqual(['eq', 'id', MEMBER_ID]);
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0].userId).toBe(MEMBER_ID);
  });
});

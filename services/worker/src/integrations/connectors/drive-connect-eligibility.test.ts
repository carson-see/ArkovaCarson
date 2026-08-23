/**
 * DRIVE-01 (SCRUM-2366) — verified-only Google Drive connect eligibility.
 *
 * The connector OAuth path must DENY unverified / free accounts. Three distinct
 * entitlement paths (org-admin, sub-org-admin, paid-verified-individual) each
 * resolve through the canonical owner-inclusive resolver in api/_org-auth.ts —
 * NEVER re-resolving org from org_members alone (the #1325/#1326 drift class).
 *
 * The gate is re-evaluated at BOTH oauth/start and oauth/callback so a caller
 * holding a stale/valid `state` token whose entitlement lapsed cannot bypass.
 *
 * Pure/injectable: no real DB, no real Drive. All lookups are the injected `db`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Canonical resolver is the single source of truth for org membership/admin —
// mock it so these tests assert we route THROUGH it (not org_members directly).
vi.mock('../../api/_org-auth.js', () => ({
  getCallerOrgIdResult: vi.fn(),
  isCallerOrgAdminResult: vi.fn(),
}));

import { getCallerOrgIdResult, isCallerOrgAdminResult } from '../../api/_org-auth.js';
import {
  resolveDriveConnectEligibility,
  type DriveEligibilityDb,
} from './drive-connect-eligibility.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOrgId = getCallerOrgIdResult as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockAdmin = isCallerOrgAdminResult as any;

beforeEach(() => {
  vi.clearAllMocks();
});

/** A minimal injectable DB that serves org + profile rows from fixtures. */
function makeDb(fixtures: {
  org?: { verification_status?: string; suspended?: boolean | null } | null;
  orgError?: boolean;
  profile?: { subscription_tier?: string; identity_verified_at?: string | null } | null;
  profileError?: boolean;
}): DriveEligibilityDb {
  return {
    getOrganization: vi.fn(async () =>
      fixtures.orgError
        ? { row: null, error: true }
        : { row: fixtures.org ?? null, error: false },
    ),
    getProfileEntitlement: vi.fn(async () =>
      fixtures.profileError
        ? { row: null, error: true }
        : { row: fixtures.profile ?? null, error: false },
    ),
  };
}

const USER = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';

describe('resolveDriveConnectEligibility — org-admin path', () => {
  it('allows a verified-org admin (routes through _org-auth, not org_members)', async () => {
    mockOrgId.mockResolvedValue({ value: ORG, error: false });
    mockAdmin.mockResolvedValue({ value: true, error: false });
    const db = makeDb({ org: { verification_status: 'VERIFIED', suspended: false } });

    const result = await resolveDriveConnectEligibility({
      userId: USER,
      orgId: ORG,
      db,
    });

    expect(result).toEqual({ allowed: true, scope: 'org', orgId: ORG });
    // Proves we resolved admin via the canonical owner-inclusive resolver.
    expect(mockAdmin).toHaveBeenCalledWith(USER, ORG);
  });

  it('denies a non-admin member of a verified org (must be admin to connect for the org)', async () => {
    mockOrgId.mockResolvedValue({ value: ORG, error: false });
    mockAdmin.mockResolvedValue({ value: false, error: false });
    const db = makeDb({ org: { verification_status: 'VERIFIED', suspended: false } });

    const result = await resolveDriveConnectEligibility({ userId: USER, orgId: ORG, db });
    expect(result).toEqual({ allowed: false, reason: 'not_admin' });
  });

  it('denies an admin of an UNVERIFIED org', async () => {
    mockOrgId.mockResolvedValue({ value: ORG, error: false });
    mockAdmin.mockResolvedValue({ value: true, error: false });
    const db = makeDb({ org: { verification_status: 'UNVERIFIED', suspended: false } });

    const result = await resolveDriveConnectEligibility({ userId: USER, orgId: ORG, db });
    expect(result).toEqual({ allowed: false, reason: 'org_unverified' });
  });

  it('denies an admin of a suspended-but-VERIFIED org (worker must not be narrower than the UI)', async () => {
    mockOrgId.mockResolvedValue({ value: ORG, error: false });
    mockAdmin.mockResolvedValue({ value: true, error: false });
    const db = makeDb({ org: { verification_status: 'VERIFIED', suspended: true } });

    const result = await resolveDriveConnectEligibility({ userId: USER, orgId: ORG, db });
    expect(result).toEqual({ allowed: false, reason: 'org_suspended' });
  });

  it('denies when the caller does not belong to the requested org (cross-tenant guard)', async () => {
    // Resolver reports the caller's org is a DIFFERENT org than requested.
    mockOrgId.mockResolvedValue({ value: 'other-org', error: false });
    mockAdmin.mockResolvedValue({ value: false, error: false });
    const db = makeDb({ org: { verification_status: 'VERIFIED', suspended: false } });

    const result = await resolveDriveConnectEligibility({ userId: USER, orgId: ORG, db });
    expect(result).toEqual({ allowed: false, reason: 'not_admin' });
  });

  it('fails closed to lookup_failed on an org-lookup DB error (retryable, distinct from denial)', async () => {
    mockOrgId.mockResolvedValue({ value: ORG, error: false });
    mockAdmin.mockResolvedValue({ value: true, error: false });
    const db = makeDb({ orgError: true });

    const result = await resolveDriveConnectEligibility({ userId: USER, orgId: ORG, db });
    expect(result).toEqual({ allowed: false, reason: 'lookup_failed' });
  });

  it('fails closed to lookup_failed when the admin resolver itself errors', async () => {
    mockOrgId.mockResolvedValue({ value: ORG, error: false });
    mockAdmin.mockResolvedValue({ value: false, error: true });
    const db = makeDb({ org: { verification_status: 'VERIFIED', suspended: false } });

    const result = await resolveDriveConnectEligibility({ userId: USER, orgId: ORG, db });
    expect(result).toEqual({ allowed: false, reason: 'lookup_failed' });
  });
});

/**
 * FD-D1 (CTO ruling, `docs/staging/fullsoak-2026-08/cto-claims-rulings-2026-08-12.md`).
 *
 * The gate used to ADMIT `scope: 'individual'` for a paid, identity-verified
 * solo user — and the OAuth callback then refused exactly that case, because
 * `org_integrations.org_id` is NOT NULL. Net effect: a paying solo user granted
 * Google access to their entire Drive and silently got nothing back. The consent
 * was real; the capability was not.
 *
 * Ruling: do NOT build personal-connect storage. Stop admitting the case, at the
 * gate, with a reason the user can act on — BEFORE the OAuth round-trip, so no
 * Drive grant is ever issued for a scope that cannot be persisted.
 */
describe('resolveDriveConnectEligibility — individual scope is NOT admitted (FD-D1)', () => {
  it('denies a paid + identity-verified solo user instead of admitting a scope that cannot persist', async () => {
    mockOrgId.mockResolvedValue({ value: null, error: false });
    const db = makeDb({
      profile: { subscription_tier: 'professional', identity_verified_at: '2026-01-01T00:00:00Z' },
    });

    const result = await resolveDriveConnectEligibility({ userId: USER, db });

    expect(result).toEqual({ allowed: false, reason: 'individual_scope_unsupported' });
    // No org → admin resolver must NOT be consulted.
    expect(mockAdmin).not.toHaveBeenCalled();
  });

  it('never returns an `allowed` individual result for ANY solo-user entitlement shape', async () => {
    mockOrgId.mockResolvedValue({ value: null, error: false });

    const fixtures = [
      { subscription_tier: 'enterprise', identity_verified_at: '2026-01-01T00:00:00Z' },
      { subscription_tier: 'free', identity_verified_at: '2026-01-01T00:00:00Z' },
      { subscription_tier: 'professional', identity_verified_at: null },
    ];

    for (const profile of fixtures) {
      const result = await resolveDriveConnectEligibility({
        userId: USER,
        db: makeDb({ profile }),
      });
      expect(result).toEqual({ allowed: false, reason: 'individual_scope_unsupported' });
    }

    // …and with no profile row at all.
    const noProfile = await resolveDriveConnectEligibility({
      userId: USER,
      db: makeDb({ profile: null }),
    });
    expect(noProfile).toEqual({ allowed: false, reason: 'individual_scope_unsupported' });
  });

  it('does not read profile entitlement at all — the tier is no longer load-bearing', async () => {
    mockOrgId.mockResolvedValue({ value: null, error: false });
    const db = makeDb({
      profile: { subscription_tier: 'professional', identity_verified_at: '2026-01-01T00:00:00Z' },
    });

    await resolveDriveConnectEligibility({ userId: USER, db });

    // Upgrading a plan cannot open this path, so the gate must not imply it can
    // by consulting the plan. A `needs_paid_plan` denial here would have been a
    // false promise: paying does not unlock personal connect.
    expect(db.getProfileEntitlement).not.toHaveBeenCalled();
  });

  it('still fails closed to lookup_failed when the org lookup itself errors', async () => {
    mockOrgId.mockResolvedValue({ value: null, error: true });

    const result = await resolveDriveConnectEligibility({ userId: USER, db: makeDb({}) });
    // Retryable, and distinct from the policy denial — the UI must offer a
    // retry here, not a dead-end "you need an organization".
    expect(result).toEqual({ allowed: false, reason: 'lookup_failed' });
  });

  it('keeps individual_scope_unsupported distinct from org_scope_required', async () => {
    // Two different users of the personal path: one HAS an org (retry with
    // org_id — actionable), one has none (needs an org at all). Collapsing
    // these tells the second user to "resend with org_id" they do not have.
    const db = makeDb({
      profile: { subscription_tier: 'professional', identity_verified_at: '2026-01-01T00:00:00Z' },
    });

    mockOrgId.mockResolvedValue({ value: ORG, error: false });
    const hasOrg = await resolveDriveConnectEligibility({ userId: USER, db });

    mockOrgId.mockResolvedValue({ value: null, error: false });
    const noOrg = await resolveDriveConnectEligibility({ userId: USER, db });

    expect(hasOrg).toEqual({ allowed: false, reason: 'org_scope_required' });
    expect(noOrg).toEqual({ allowed: false, reason: 'individual_scope_unsupported' });
  });

  /**
   * FD-D3 (side-rig, 2026-08-13). This branch — "caller HAS an org but called the
   * personal path without an org_id" — was the only one in this module with no
   * test, and it returned the same `not_admin` reason the ORG path returns for a
   * genuine non-admin. Two structurally different conditions, one indistinguishable
   * 403 `not_authorized`, and no log on either. Diagnosing it cost a live founder
   * OAuth consent: an actual org OWNER was reported as "not admin".
   *
   * The reason is now distinct, so the two are separable from the response alone.
   */
  it('denies an org-holder who called the PERSONAL path with a distinct, non-not_admin reason', async () => {
    mockOrgId.mockResolvedValue({ value: ORG, error: false });
    const db = makeDb({
      profile: { subscription_tier: 'professional', identity_verified_at: '2026-01-01T00:00:00Z' },
    });

    const result = await resolveDriveConnectEligibility({ userId: USER, db });
    expect(result).toEqual({ allowed: false, reason: 'org_scope_required' });
    // The admin resolver is irrelevant here — the caller never named an org.
    expect(mockAdmin).not.toHaveBeenCalled();
  });

  it('keeps org_scope_required distinct from the ORG path\'s not_admin', async () => {
    // Same user, same org, same fixtures — only the presence of org_id differs.
    mockOrgId.mockResolvedValue({ value: ORG, error: false });
    mockAdmin.mockResolvedValue({ value: false, error: false });
    const db = makeDb({
      org: { verification_status: 'VERIFIED', suspended: false },
      profile: { subscription_tier: 'professional', identity_verified_at: '2026-01-01T00:00:00Z' },
    });

    const personal = await resolveDriveConnectEligibility({ userId: USER, db });
    const org = await resolveDriveConnectEligibility({ userId: USER, orgId: ORG, db });

    expect(personal).toEqual({ allowed: false, reason: 'org_scope_required' });
    expect(org).toEqual({ allowed: false, reason: 'not_admin' });
  });
});

describe('assertDriveConnectAllowed — token-reuse / callback re-check', () => {
  it('re-evaluates entitlement so a stale-but-valid state token cannot bypass a lapsed entitlement', async () => {
    // First call (start): eligible. Second call (callback): entitlement revoked.
    mockOrgId.mockResolvedValue({ value: ORG, error: false });
    mockAdmin.mockResolvedValue({ value: true, error: false });

    const dbStart = makeDb({ org: { verification_status: 'VERIFIED', suspended: false } });
    const startGate = await resolveDriveConnectEligibility({ userId: USER, orgId: ORG, db: dbStart });
    expect(startGate.allowed).toBe(true);

    // Between start and callback the org was suspended.
    const dbCallback = makeDb({ org: { verification_status: 'VERIFIED', suspended: true } });
    const callbackGate = await resolveDriveConnectEligibility({ userId: USER, orgId: ORG, db: dbCallback });
    expect(callbackGate).toEqual({ allowed: false, reason: 'org_suspended' });
  });
});

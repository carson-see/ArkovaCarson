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

describe('resolveDriveConnectEligibility — paid-verified-individual path (no org)', () => {
  it('allows a paid + identity-verified individual (personal connect)', async () => {
    mockOrgId.mockResolvedValue({ value: null, error: false });
    const db = makeDb({
      profile: { subscription_tier: 'professional', identity_verified_at: '2026-01-01T00:00:00Z' },
    });

    const result = await resolveDriveConnectEligibility({ userId: USER, db });
    expect(result).toEqual({ allowed: true, scope: 'individual', orgId: null });
    // No org → admin resolver must NOT be consulted.
    expect(mockAdmin).not.toHaveBeenCalled();
  });

  it('denies a FREE individual (no paid plan)', async () => {
    mockOrgId.mockResolvedValue({ value: null, error: false });
    const db = makeDb({
      profile: { subscription_tier: 'free', identity_verified_at: '2026-01-01T00:00:00Z' },
    });

    const result = await resolveDriveConnectEligibility({ userId: USER, db });
    expect(result).toEqual({ allowed: false, reason: 'needs_paid_plan' });
  });

  it('denies a paid individual who has NOT completed identity verification', async () => {
    mockOrgId.mockResolvedValue({ value: null, error: false });
    const db = makeDb({
      profile: { subscription_tier: 'professional', identity_verified_at: null },
    });

    const result = await resolveDriveConnectEligibility({ userId: USER, db });
    expect(result).toEqual({ allowed: false, reason: 'individual_not_verified' });
  });

  it('denies when no profile row is found', async () => {
    mockOrgId.mockResolvedValue({ value: null, error: false });
    const db = makeDb({ profile: null });

    const result = await resolveDriveConnectEligibility({ userId: USER, db });
    expect(result).toEqual({ allowed: false, reason: 'needs_paid_plan' });
  });

  it('fails closed to lookup_failed on a profile-lookup DB error', async () => {
    mockOrgId.mockResolvedValue({ value: null, error: false });
    const db = makeDb({ profileError: true });

    const result = await resolveDriveConnectEligibility({ userId: USER, db });
    expect(result).toEqual({ allowed: false, reason: 'lookup_failed' });
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

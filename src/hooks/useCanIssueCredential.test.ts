/**
 * useCanIssueCredential resolver tests (SCRUM-1755).
 *
 * Pure-resolver pattern: the gating logic is exercised directly via
 * `resolveIssueGate`; the React hook is a thin wrapper that pipes
 * useProfile + supabase rows into the resolver.
 *
 * Every gate branch and every multi-input boundary is pinned here.
 */

import { describe, expect, it } from 'vitest';
import { resolveIssueGate, type OrgGateRow, type ResolveIssueGateInput } from './useCanIssueCredential';

const ROOT_ORG_ID = '11111111-1111-4111-8111-111111111111';
const SUB_ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_ORG_ID = '33333333-3333-4333-8333-333333333333';

const verifiedRoot: OrgGateRow = {
  id: ROOT_ORG_ID,
  verification_status: 'VERIFIED',
  suspended: false,
  parent_org_id: null,
  parent_approval_status: null,
};

const verifiedParent: OrgGateRow = {
  id: PARENT_ORG_ID,
  verification_status: 'VERIFIED',
  suspended: false,
  parent_org_id: null,
  parent_approval_status: null,
};

const verifiedApprovedSub: OrgGateRow = {
  id: SUB_ORG_ID,
  verification_status: 'VERIFIED',
  suspended: false,
  parent_org_id: PARENT_ORG_ID,
  parent_approval_status: 'APPROVED',
};

const rootGateInput: ResolveIssueGateInput = {
  profileLoading: false,
  role: 'ORG_ADMIN',
  orgId: ROOT_ORG_ID,
  org: verifiedRoot,
  orgLoading: false,
  parent: undefined,
  parentLoading: false,
  orgError: false,
  parentError: false,
};

const subGateInput: ResolveIssueGateInput = {
  ...rootGateInput,
  orgId: SUB_ORG_ID,
  org: verifiedApprovedSub,
  parent: verifiedParent,
};

function rootGate(overrides: Partial<ResolveIssueGateInput> = {}) {
  return resolveIssueGate({ ...rootGateInput, ...overrides });
}

function subGate(overrides: Partial<ResolveIssueGateInput> = {}) {
  return resolveIssueGate({ ...subGateInput, ...overrides });
}

describe('resolveIssueGate (SCRUM-1755 ORG-08)', () => {
  it('allows verified root-org admin to issue credentials', () => {
    expect(rootGate().allowed).toBe(true);
  });

  it('allows verified APPROVED sub-org admin when parent is verified and active', () => {
    expect(subGate().allowed).toBe(true);
  });

  it('returns loading while the profile or the org row is in flight', () => {
    expect(rootGate({ profileLoading: true, org: undefined }))
      .toMatchObject({ allowed: false, loading: true, reason: 'loading' });
    expect(rootGate({ org: undefined, orgLoading: true }))
      .toMatchObject({ allowed: false, loading: true, reason: 'loading' });
  });

  it('blocks INDIVIDUAL users — Issue Credential is org-admin-only', () => {
    expect(rootGate({ role: 'INDIVIDUAL', orgId: null, org: null }))
      .toMatchObject({ allowed: false, reason: 'not_admin' });
  });

  it('returns not_admin before org loading for non-admin users', () => {
    expect(rootGate({ role: 'INDIVIDUAL', org: undefined, orgLoading: true }))
      .toMatchObject({ allowed: false, loading: false, reason: 'not_admin' });
  });

  it('blocks ORG_ADMIN with no org_id (orphaned profile)', () => {
    expect(rootGate({ orgId: null, org: null }))
      .toMatchObject({ allowed: false, reason: 'no_org' });
  });

  it.each(['UNVERIFIED', 'PENDING'] as const)(
    'blocks ORG_ADMIN of a %s-verification org',
    (verificationStatus) => {
      expect(rootGate({ org: { ...verifiedRoot, verification_status: verificationStatus } }))
        .toMatchObject({ allowed: false, reason: 'org_unverified' });
    },
  );

  it('blocks ORG_ADMIN of a SUSPENDED org even when verified', () => {
    expect(rootGate({ org: { ...verifiedRoot, suspended: true } }))
      .toMatchObject({ allowed: false, reason: 'org_suspended' });
  });

  it.each(['PENDING', 'REVOKED', null] as const)(
    'blocks sub-org with parent_approval_status=%s',
    (approvalStatus) => {
      expect(subGate({ org: { ...verifiedApprovedSub, parent_approval_status: approvalStatus } }))
        .toMatchObject({ allowed: false, reason: 'parent_unapproved' });
    },
  );

  it.each([
    [{ ...verifiedParent, verification_status: 'UNVERIFIED' }, 'parent_unverified'],
    [{ ...verifiedParent, suspended: true }, 'parent_suspended'],
  ] as const)('blocks sub-org for invalid parent state %#', (parent, reason) => {
    expect(subGate({ parent })).toMatchObject({ allowed: false, reason });
  });

  it('returns loading while the parent row is in flight', () => {
    expect(subGate({ parent: undefined, parentLoading: true }))
      .toMatchObject({ allowed: false, loading: true, reason: 'loading' });
  });

  it('returns query_error when the org fetch failed (does NOT collapse to no_org)', () => {
    // useQuery left data undefined because the fetch errored.
    expect(rootGate({ org: undefined, orgError: true }))
      .toMatchObject({ allowed: false, reason: 'query_error' });
  });

  it('returns query_error when the parent fetch failed (does NOT collapse to parent_unverified)', () => {
    expect(subGate({ parent: undefined, parentError: true }))
      .toMatchObject({ allowed: false, reason: 'query_error' });
  });

  it('treats null/undefined `suspended` as not-suspended (legacy rows pre-0289)', () => {
    expect(rootGate({ org: { ...verifiedRoot, suspended: null } }).allowed).toBe(true);
  });
});

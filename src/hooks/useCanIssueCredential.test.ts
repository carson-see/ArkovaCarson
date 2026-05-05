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
import { resolveIssueGate, type OrgGateRow } from './useCanIssueCredential';

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

describe('resolveIssueGate (SCRUM-1755 ORG-08)', () => {
  it('allows verified root-org admin to issue credentials', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: ROOT_ORG_ID,
      org: verifiedRoot,
      orgLoading: false,
      parent: undefined,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r.allowed).toBe(true);
  });

  it('allows verified APPROVED sub-org admin when parent is verified and active', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: SUB_ORG_ID,
      org: verifiedApprovedSub,
      orgLoading: false,
      parent: verifiedParent,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r.allowed).toBe(true);
  });

  it('returns loading while the profile or the org row is in flight', () => {
    expect(resolveIssueGate({
      profileLoading: true,
      role: 'ORG_ADMIN',
      orgId: ROOT_ORG_ID,
      org: undefined,
      orgLoading: false,
      parent: undefined,
      parentLoading: false,
      orgError: false,
      parentError: false,
    })).toMatchObject({ allowed: false, loading: true, reason: 'loading' });

    expect(resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: ROOT_ORG_ID,
      org: undefined,
      orgLoading: true,
      parent: undefined,
      parentLoading: false,
      orgError: false,
      parentError: false,
    })).toMatchObject({ allowed: false, loading: true, reason: 'loading' });
  });

  it('blocks INDIVIDUAL users — Issue Credential is org-admin-only', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'INDIVIDUAL',
      orgId: null,
      org: null,
      orgLoading: false,
      parent: undefined,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'not_admin' });
  });

  it('returns not_admin before org loading for non-admin users', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'INDIVIDUAL',
      orgId: ROOT_ORG_ID,
      org: undefined,
      orgLoading: true,
      parent: undefined,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, loading: false, reason: 'not_admin' });
  });

  it('blocks ORG_ADMIN with no org_id (orphaned profile)', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: null,
      org: null,
      orgLoading: false,
      parent: undefined,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'no_org' });
  });

  it('blocks ORG_ADMIN of an UNVERIFIED org', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: ROOT_ORG_ID,
      org: { ...verifiedRoot, verification_status: 'UNVERIFIED' },
      orgLoading: false,
      parent: undefined,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'org_unverified' });
  });

  it('blocks ORG_ADMIN of a PENDING-verification org', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: ROOT_ORG_ID,
      org: { ...verifiedRoot, verification_status: 'PENDING' },
      orgLoading: false,
      parent: undefined,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'org_unverified' });
  });

  it('blocks ORG_ADMIN of a SUSPENDED org even when verified', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: ROOT_ORG_ID,
      org: { ...verifiedRoot, suspended: true },
      orgLoading: false,
      parent: undefined,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'org_suspended' });
  });

  it('blocks sub-org with parent_approval_status=PENDING', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: SUB_ORG_ID,
      org: { ...verifiedApprovedSub, parent_approval_status: 'PENDING' },
      orgLoading: false,
      parent: verifiedParent,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'parent_unapproved' });
  });

  it('blocks sub-org with parent_approval_status=REVOKED', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: SUB_ORG_ID,
      org: { ...verifiedApprovedSub, parent_approval_status: 'REVOKED' },
      orgLoading: false,
      parent: verifiedParent,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'parent_unapproved' });
  });

  it('blocks sub-org with NULL parent_approval_status (legacy / never approved)', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: SUB_ORG_ID,
      org: { ...verifiedApprovedSub, parent_approval_status: null },
      orgLoading: false,
      parent: verifiedParent,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'parent_unapproved' });
  });

  it('blocks sub-org when parent is UNVERIFIED', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: SUB_ORG_ID,
      org: verifiedApprovedSub,
      orgLoading: false,
      parent: { ...verifiedParent, verification_status: 'UNVERIFIED' },
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'parent_unverified' });
  });

  it('blocks sub-org when parent is SUSPENDED', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: SUB_ORG_ID,
      org: verifiedApprovedSub,
      orgLoading: false,
      parent: { ...verifiedParent, suspended: true },
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'parent_suspended' });
  });

  it('returns loading while the parent row is in flight', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: SUB_ORG_ID,
      org: verifiedApprovedSub,
      orgLoading: false,
      parent: undefined,
      parentLoading: true,
      orgError: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, loading: true, reason: 'loading' });
  });

  it('returns query_error when the org fetch failed (does NOT collapse to no_org)', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: ROOT_ORG_ID,
      org: undefined, // useQuery left data undefined because the fetch errored
      orgLoading: false,
      orgError: true,
      parent: undefined,
      parentLoading: false,
      parentError: false,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'query_error' });
  });

  it('returns query_error when the parent fetch failed (does NOT collapse to parent_unverified)', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: SUB_ORG_ID,
      org: verifiedApprovedSub,
      orgLoading: false,
      orgError: false,
      parent: undefined,
      parentLoading: false,
      parentError: true,
    });
    expect(r).toMatchObject({ allowed: false, reason: 'query_error' });
  });

  it('treats null/undefined `suspended` as not-suspended (legacy rows pre-0289)', () => {
    const r = resolveIssueGate({
      profileLoading: false,
      role: 'ORG_ADMIN',
      orgId: ROOT_ORG_ID,
      org: { ...verifiedRoot, suspended: null },
      orgLoading: false,
      parent: undefined,
      parentLoading: false,
      orgError: false,
      parentError: false,
    });
    expect(r.allowed).toBe(true);
  });
});

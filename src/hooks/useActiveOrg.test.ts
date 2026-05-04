/**
 * SCRUM-1651 ORG-HIER-01 — Active org resolver tests.
 *
 * Tests the pure resolver directly. The React hook is a thin wrapper that
 * adapts useProfile + useUserOrgs + useParams; the resolver is where the
 * launch-critical security invariant lives, so the unit-level test pins
 * every branch of resolution + every membership-membership boundary.
 */
import { describe, expect, it } from 'vitest';
import { resolveActiveOrg } from './useActiveOrg';

const ORG_PARENT = '11111111-1111-4111-8111-111111111111';
const ORG_SUB = '22222222-2222-4222-8222-222222222222';
const ORG_OTHER_TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('resolveActiveOrg (SCRUM-1651 ORG-02)', () => {
  it('URL wins over session and profile when user is a member of that org', () => {
    const r = resolveActiveOrg({
      urlOrgId: ORG_SUB,
      sessionOrgId: ORG_PARENT,
      profileOrgId: ORG_PARENT,
      membershipOrgIds: [ORG_PARENT, ORG_SUB],
    });
    expect(r.orgId).toBe(ORG_SUB);
    expect(r.source.kind).toBe('url');
    expect(r.hasMultipleMemberships).toBe(true);
  });

  it('URL pointing to a non-member org is ignored — falls through to session/profile', () => {
    const r = resolveActiveOrg({
      urlOrgId: ORG_OTHER_TENANT,
      sessionOrgId: null,
      profileOrgId: ORG_PARENT,
      membershipOrgIds: [ORG_PARENT],
    });
    expect(r.orgId).toBe(ORG_PARENT);
    expect(r.source.kind).toBe('implicit_primary');
  });

  it('session selection is honored when URL is absent and user is still a member', () => {
    const r = resolveActiveOrg({
      urlOrgId: null,
      sessionOrgId: ORG_SUB,
      profileOrgId: ORG_PARENT,
      membershipOrgIds: [ORG_PARENT, ORG_SUB],
    });
    expect(r.orgId).toBe(ORG_SUB);
    expect(r.source.kind).toBe('session');
  });

  it('implicit_primary surfaces multiMembership=true so callers can warn the user', () => {
    const r = resolveActiveOrg({
      urlOrgId: null,
      sessionOrgId: null,
      profileOrgId: ORG_PARENT,
      membershipOrgIds: [ORG_PARENT, ORG_SUB],
    });
    expect(r.source).toEqual({ kind: 'implicit_primary', orgId: ORG_PARENT, multiMembership: true });
  });

  it('implicit_primary surfaces multiMembership=false for single-org users', () => {
    const r = resolveActiveOrg({
      urlOrgId: null,
      sessionOrgId: null,
      profileOrgId: ORG_PARENT,
      membershipOrgIds: [ORG_PARENT],
    });
    expect(r.source).toEqual({ kind: 'implicit_primary', orgId: ORG_PARENT, multiMembership: false });
  });

  it('profileOrgId pointing to a revoked membership is rejected — returns none', () => {
    const r = resolveActiveOrg({
      urlOrgId: null,
      sessionOrgId: null,
      profileOrgId: ORG_PARENT,
      membershipOrgIds: [], // membership was revoked since profile cached
    });
    expect(r.orgId).toBeNull();
    expect(r.source.kind).toBe('none');
  });

  it('individual-tier user with no memberships and no profile org returns none', () => {
    const r = resolveActiveOrg({
      urlOrgId: null,
      sessionOrgId: null,
      profileOrgId: null,
      membershipOrgIds: [],
    });
    expect(r.orgId).toBeNull();
    expect(r.source.kind).toBe('none');
  });

  it('cross-tenant safety: every input pointing to a non-member org returns none (no active selection)', () => {
    // All three inputs reference an org the user is NOT a member of. The
    // user's only real membership is ORG_PARENT but no input pointed at it.
    // Each layer rejects independently → final result is `none`. The user
    // sees the multi-org picker / OrgRequiredCard, not the unrelated tenant.
    const r = resolveActiveOrg({
      urlOrgId: ORG_OTHER_TENANT,
      sessionOrgId: ORG_OTHER_TENANT,
      profileOrgId: ORG_OTHER_TENANT,
      membershipOrgIds: [ORG_PARENT],
    });
    expect(r.orgId).toBeNull();
    expect(r.source.kind).toBe('none');
  });

  it('cross-tenant safety: URL with another tenant id falls through to profile when profile is a real membership', () => {
    const r = resolveActiveOrg({
      urlOrgId: ORG_OTHER_TENANT,
      sessionOrgId: null,
      profileOrgId: ORG_PARENT,
      membershipOrgIds: [ORG_PARENT],
    });
    expect(r.orgId).toBe(ORG_PARENT);
    expect(r.source.kind).toBe('implicit_primary');
  });
});

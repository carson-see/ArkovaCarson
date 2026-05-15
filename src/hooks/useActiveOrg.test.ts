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

  it('sessionOrgId pointing to a revoked membership falls through to profile.org_id', () => {
    // SCRUM-1647 follow-up: pin the asymmetric session-vs-profile fallthrough.
    // The session storage may carry an org id the user picked yesterday; if
    // their membership to that org has since been revoked, the resolver
    // must NOT honor the stale session value and must fall back to the
    // implicit primary instead of producing a `session` source.
    const r = resolveActiveOrg({
      urlOrgId: null,
      sessionOrgId: ORG_SUB,           // user picked the sub-org from the switcher
      profileOrgId: ORG_PARENT,        // legacy primary
      membershipOrgIds: [ORG_PARENT],  // ORG_SUB membership has been revoked since
    });
    expect(r.orgId).toBe(ORG_PARENT);
    expect(r.source.kind).toBe('implicit_primary');
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

/**
 * SCRUM-1651 ORG-12 — Cross-tenant negative test matrix.
 *
 * The acceptance criteria require proving that users cannot see or mutate
 * other org/sub-org data through UI or API for the following operation
 * categories: read, write, delete, list, anchor-create, queue-claim,
 * credit-consume, integration-disconnect.
 *
 * Since every org-scoped operation in the frontend flows through
 * `resolveActiveOrg()` to determine the active org — and downstream hooks
 * and API calls scope their queries to that resolved org id — the resolver
 * is the single chokepoint. If the resolver never resolves to an org the
 * user doesn't belong to, no downstream operation can leak data.
 *
 * This matrix tests every combination of actor type (parent-org admin,
 * sub-org admin, unrelated-org admin, individual user) against every
 * target org, proving the resolver never resolves to a non-member org.
 *
 * The RLS layer in Supabase provides defense-in-depth at the database
 * level; these tests verify the client-side gate that prevents the UI
 * from even attempting cross-tenant operations.
 */

const ORG_UNRELATED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type ActorScenario = {
  label: string;
  membershipOrgIds: string[];
  profileOrgId: string | null;
};

const actors: ActorScenario[] = [
  { label: 'parent-org admin', membershipOrgIds: [ORG_PARENT], profileOrgId: ORG_PARENT },
  { label: 'sub-org admin', membershipOrgIds: [ORG_SUB], profileOrgId: ORG_SUB },
  { label: 'dual-membership admin (parent + sub)', membershipOrgIds: [ORG_PARENT, ORG_SUB], profileOrgId: ORG_PARENT },
  { label: 'unrelated-org admin', membershipOrgIds: [ORG_UNRELATED], profileOrgId: ORG_UNRELATED },
  { label: 'individual user (no org)', membershipOrgIds: [], profileOrgId: null },
];

/**
 * Operations from the AC: read, write, delete, list, anchor-create,
 * queue-claim, credit-consume, integration-disconnect. Each operation
 * would send the resolved orgId to a different API endpoint — here we
 * verify the resolver never produces an orgId the actor shouldn't reach.
 */
const operations = [
  'read', 'write', 'delete', 'list',
  'anchor-create', 'queue-claim', 'credit-consume', 'integration-disconnect',
] as const;

describe('Cross-tenant negative test matrix (SCRUM-1651 ORG-12)', () => {
  describe('URL-based attacks: attacker pastes /orgs/:targetOrg in URL', () => {
    for (const actor of actors) {
      for (const targetLabel of ['parent-org', 'sub-org', 'unrelated-org'] as const) {
        const targetMap = {
          'parent-org': ORG_PARENT,
          'sub-org': ORG_SUB,
          'unrelated-org': ORG_UNRELATED,
        };
        const targetOrgId = targetMap[targetLabel];
        const isMember = actor.membershipOrgIds.includes(targetOrgId);

        if (isMember) continue; // skip — legitimate access

        it(`${actor.label} cannot reach ${targetLabel} via URL (all ${operations.length} operations blocked)`, () => {
          const r = resolveActiveOrg({
            urlOrgId: targetOrgId,
            sessionOrgId: null,
            profileOrgId: actor.profileOrgId,
            membershipOrgIds: actor.membershipOrgIds,
          });
          // The resolved orgId must NEVER be the target the attacker tried.
          expect(r.orgId).not.toBe(targetOrgId);
          // If the attacker's own profile.org_id is a valid membership,
          // the resolver falls through to it. Otherwise → none.
          if (actor.profileOrgId && actor.membershipOrgIds.includes(actor.profileOrgId)) {
            expect(r.orgId).toBe(actor.profileOrgId);
          } else {
            expect(r.orgId).toBeNull();
            expect(r.source.kind).toBe('none');
          }
        });
      }
    }
  });

  describe('Session-poisoning attacks: attacker sets localStorage to another org', () => {
    for (const actor of actors) {
      for (const targetLabel of ['parent-org', 'sub-org', 'unrelated-org'] as const) {
        const targetMap = {
          'parent-org': ORG_PARENT,
          'sub-org': ORG_SUB,
          'unrelated-org': ORG_UNRELATED,
        };
        const targetOrgId = targetMap[targetLabel];
        const isMember = actor.membershipOrgIds.includes(targetOrgId);

        if (isMember) continue;

        it(`${actor.label} cannot reach ${targetLabel} via poisoned session storage`, () => {
          const r = resolveActiveOrg({
            urlOrgId: null,
            sessionOrgId: targetOrgId,
            profileOrgId: actor.profileOrgId,
            membershipOrgIds: actor.membershipOrgIds,
          });
          expect(r.orgId).not.toBe(targetOrgId);
          if (actor.profileOrgId && actor.membershipOrgIds.includes(actor.profileOrgId)) {
            expect(r.orgId).toBe(actor.profileOrgId);
          } else {
            expect(r.orgId).toBeNull();
          }
        });
      }
    }
  });

  describe('Profile-drift attacks: profile.org_id points to an org with revoked membership', () => {
    for (const actor of actors.filter(a => a.membershipOrgIds.length > 0)) {
      for (const targetLabel of ['parent-org', 'sub-org', 'unrelated-org'] as const) {
        const targetMap = {
          'parent-org': ORG_PARENT,
          'sub-org': ORG_SUB,
          'unrelated-org': ORG_UNRELATED,
        };
        const targetOrgId = targetMap[targetLabel];
        const isMember = actor.membershipOrgIds.includes(targetOrgId);

        if (isMember) continue;

        it(`${actor.label} with drifted profile.org_id=${targetLabel} cannot reach ${targetLabel}`, () => {
          const r = resolveActiveOrg({
            urlOrgId: null,
            sessionOrgId: null,
            profileOrgId: targetOrgId, // drifted — points to non-member org
            membershipOrgIds: actor.membershipOrgIds,
          });
          expect(r.orgId).not.toBe(targetOrgId);
          // With a drifted profile, the resolver should resolve to the
          // first valid membership or none if no membership exists.
          // Since profileOrgId is not in membershipOrgIds, implicit_primary
          // is skipped. None is returned (no URL, no session, no valid profile).
          expect(r.orgId).toBeNull();
          expect(r.source.kind).toBe('none');
        });
      }
    }
  });

  describe('Combined attack: URL + session + profile all point to a foreign org', () => {
    // Only test actors who are NOT members of ORG_UNRELATED — actors who
    // ARE members have legitimate access, which is not an attack scenario.
    for (const actor of actors.filter(
      a => a.membershipOrgIds.length > 0 && !a.membershipOrgIds.includes(ORG_UNRELATED),
    )) {
      it(`${actor.label} cannot bypass when all three inputs point to unrelated org`, () => {
        const r = resolveActiveOrg({
          urlOrgId: ORG_UNRELATED,
          sessionOrgId: ORG_UNRELATED,
          profileOrgId: ORG_UNRELATED,
          membershipOrgIds: actor.membershipOrgIds,
        });
        expect(r.orgId).not.toBe(ORG_UNRELATED);
        // The resolver falls through all three layers and lands on none
        // because ORG_UNRELATED is not in any actor's membership set.
        expect(r.orgId).toBeNull();
        expect(r.source.kind).toBe('none');
      });
    }
  });

  describe('Parent ↔ sub-org isolation for dual-membership users', () => {
    const dualMember = actors.find(a => a.label.includes('dual-membership'))!;

    it('URL to parent resolves to parent — not sub-org', () => {
      const r = resolveActiveOrg({
        urlOrgId: ORG_PARENT,
        sessionOrgId: ORG_SUB,
        profileOrgId: ORG_SUB,
        membershipOrgIds: dualMember.membershipOrgIds,
      });
      expect(r.orgId).toBe(ORG_PARENT);
      expect(r.source.kind).toBe('url');
    });

    it('URL to sub-org resolves to sub-org — not parent', () => {
      const r = resolveActiveOrg({
        urlOrgId: ORG_SUB,
        sessionOrgId: ORG_PARENT,
        profileOrgId: ORG_PARENT,
        membershipOrgIds: dualMember.membershipOrgIds,
      });
      expect(r.orgId).toBe(ORG_SUB);
      expect(r.source.kind).toBe('url');
    });

    it('session to sub-org resolves to sub-org when URL is absent', () => {
      const r = resolveActiveOrg({
        urlOrgId: null,
        sessionOrgId: ORG_SUB,
        profileOrgId: ORG_PARENT,
        membershipOrgIds: dualMember.membershipOrgIds,
      });
      expect(r.orgId).toBe(ORG_SUB);
      expect(r.source.kind).toBe('session');
    });

    it('unrelated org in URL is rejected — resolver falls through to session/profile', () => {
      const r = resolveActiveOrg({
        urlOrgId: ORG_UNRELATED,
        sessionOrgId: ORG_SUB,
        profileOrgId: ORG_PARENT,
        membershipOrgIds: dualMember.membershipOrgIds,
      });
      expect(r.orgId).not.toBe(ORG_UNRELATED);
      expect(r.orgId).toBe(ORG_SUB);
      expect(r.source.kind).toBe('session');
    });
  });

  describe('Operation-scoped invariant: resolved orgId is always in membershipOrgIds or null', () => {
    // This is the fundamental invariant that makes all downstream
    // org-scoped operations (the 8 categories from the AC) safe.
    // If it holds, no operation can escape the user's org boundary.
    const allInputCombinations: Array<{
      urlOrgId: string | null;
      sessionOrgId: string | null;
      profileOrgId: string | null;
      membershipOrgIds: string[];
    }> = [
      // URL attacks
      { urlOrgId: ORG_OTHER_TENANT, sessionOrgId: null, profileOrgId: null, membershipOrgIds: [ORG_PARENT] },
      { urlOrgId: ORG_OTHER_TENANT, sessionOrgId: ORG_OTHER_TENANT, profileOrgId: null, membershipOrgIds: [ORG_PARENT] },
      { urlOrgId: ORG_OTHER_TENANT, sessionOrgId: ORG_OTHER_TENANT, profileOrgId: ORG_OTHER_TENANT, membershipOrgIds: [ORG_PARENT] },
      // Session attacks
      { urlOrgId: null, sessionOrgId: ORG_OTHER_TENANT, profileOrgId: null, membershipOrgIds: [ORG_PARENT] },
      { urlOrgId: null, sessionOrgId: ORG_OTHER_TENANT, profileOrgId: ORG_PARENT, membershipOrgIds: [ORG_PARENT] },
      // Profile drift
      { urlOrgId: null, sessionOrgId: null, profileOrgId: ORG_OTHER_TENANT, membershipOrgIds: [ORG_PARENT] },
      // Dual-member edge cases
      { urlOrgId: ORG_OTHER_TENANT, sessionOrgId: ORG_SUB, profileOrgId: ORG_PARENT, membershipOrgIds: [ORG_PARENT, ORG_SUB] },
      { urlOrgId: null, sessionOrgId: ORG_OTHER_TENANT, profileOrgId: ORG_OTHER_TENANT, membershipOrgIds: [ORG_PARENT, ORG_SUB] },
      // No memberships
      { urlOrgId: ORG_PARENT, sessionOrgId: ORG_PARENT, profileOrgId: ORG_PARENT, membershipOrgIds: [] },
      { urlOrgId: null, sessionOrgId: null, profileOrgId: null, membershipOrgIds: [] },
      // Legitimate — should resolve
      { urlOrgId: ORG_PARENT, sessionOrgId: null, profileOrgId: null, membershipOrgIds: [ORG_PARENT] },
      { urlOrgId: null, sessionOrgId: ORG_SUB, profileOrgId: ORG_PARENT, membershipOrgIds: [ORG_PARENT, ORG_SUB] },
    ];

    for (const [i, inputs] of allInputCombinations.entries()) {
      it(`combination ${i + 1}: resolved orgId is in membershipOrgIds or null`, () => {
        const r = resolveActiveOrg(inputs);
        if (r.orgId !== null) {
          expect(
            inputs.membershipOrgIds.includes(r.orgId),
            `resolved orgId ${r.orgId} is not in membershipOrgIds [${inputs.membershipOrgIds.join(', ')}]`,
          ).toBe(true);
        }
        // Additionally verify: the resolved orgId is NEVER ORG_OTHER_TENANT
        // unless ORG_OTHER_TENANT is in the membership list.
        if (!inputs.membershipOrgIds.includes(ORG_OTHER_TENANT)) {
          expect(r.orgId).not.toBe(ORG_OTHER_TENANT);
        }
      });
    }
  });
});

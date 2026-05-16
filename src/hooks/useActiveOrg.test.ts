/**
 * SCRUM-1651 ORG-HIER-01 — Active org resolver tests.
 *
 * Tests the pure resolver directly. The React hook is a thin wrapper that
 * adapts useProfile + useUserOrgs + useParams; the resolver is where the
 * launch-critical security invariant lives, so the unit-level test pins
 * every branch of resolution + every membership-membership boundary.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { resolveActiveOrg } from './useActiveOrg';

const mockOrgsState = { orgs: [] as { orgId: string }[], loading: false };
const mockProfileState = { profile: null as { org_id: string | null } | null, loading: false };

vi.mock('./useUserOrgs', () => ({
  useUserOrgs: () => ({ ...mockOrgsState, error: null, refreshOrgs: async () => {} }),
}));
vi.mock('./useProfile', () => ({
  useProfile: () => mockProfileState,
}));
vi.mock('react-router-dom', () => ({
  useParams: () => ({}),
}));

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
      membershipOrgIds: [],
    });
    expect(r.orgId).toBeNull();
    expect(r.source.kind).toBe('none');
  });

  it('sessionOrgId pointing to a revoked membership falls through to profile.org_id', () => {
    const r = resolveActiveOrg({
      urlOrgId: null,
      sessionOrgId: ORG_SUB,
      profileOrgId: ORG_PARENT,
      membershipOrgIds: [ORG_PARENT],
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

// SCRUM-1651 ORG-12 — resolveActiveOrg is the client-side chokepoint;
// RLS provides defense-in-depth at the DB layer.

const ORG_UNRELATED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const TARGET_MAP = {
  'parent-org': ORG_PARENT,
  'sub-org': ORG_SUB,
  'unrelated-org': ORG_UNRELATED,
} as const;

type TargetLabel = keyof typeof TARGET_MAP;

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


type AttackVector = 'url' | 'session' | 'profile';

function buildAttackInput(
  vector: AttackVector,
  targetOrgId: string,
  actor: ActorScenario,
): Parameters<typeof resolveActiveOrg>[0] {
  return {
    urlOrgId: vector === 'url' ? targetOrgId : null,
    sessionOrgId: vector === 'session' ? targetOrgId : null,
    profileOrgId: vector === 'profile' ? targetOrgId : actor.profileOrgId,
    membershipOrgIds: actor.membershipOrgIds,
  };
}

function runSingleVectorMatrix(opts: {
  vector: AttackVector;
  describeLabel: string;
  testLabel: (actor: ActorScenario, target: TargetLabel) => string;
  filterActors?: (a: ActorScenario) => boolean;
}) {
  const filtered = opts.filterActors ? actors.filter(opts.filterActors) : actors;
  describe(opts.describeLabel, () => {
    for (const actor of filtered) {
      for (const targetLabel of Object.keys(TARGET_MAP) as TargetLabel[]) {
        const targetOrgId = TARGET_MAP[targetLabel];
        if (actor.membershipOrgIds.includes(targetOrgId)) continue;

        it(opts.testLabel(actor, targetLabel), () => {
          const r = resolveActiveOrg(buildAttackInput(opts.vector, targetOrgId, actor));
          expect(r.orgId).not.toBe(targetOrgId);
          if (opts.vector === 'profile') {
            expect(r.orgId).toBeNull();
            expect(r.source.kind).toBe('none');
          } else if (actor.profileOrgId && actor.membershipOrgIds.includes(actor.profileOrgId)) {
            expect(r.orgId).toBe(actor.profileOrgId);
          } else {
            expect(r.orgId).toBeNull();
            expect(r.source.kind).toBe('none');
          }
        });
      }
    }
  });
}

describe('Cross-tenant negative test matrix (SCRUM-1651 ORG-12)', () => {
  runSingleVectorMatrix({
    vector: 'url',
    describeLabel: 'URL-based attacks: attacker pastes /orgs/:targetOrg in URL',
    testLabel: (a, t) => `${a.label} cannot reach ${t} via URL`,
  });

  runSingleVectorMatrix({
    vector: 'session',
    describeLabel: 'Session-poisoning attacks: attacker sets localStorage to another org',
    testLabel: (a, t) => `${a.label} cannot reach ${t} via poisoned session storage`,
  });

  runSingleVectorMatrix({
    vector: 'profile',
    describeLabel: 'Profile-drift attacks: profile.org_id points to an org with revoked membership',
    testLabel: (a, t) => `${a.label} with drifted profile.org_id=${t} cannot reach ${t}`,
    filterActors: a => a.membershipOrgIds.length > 0,
  });

  describe('Combined attack: URL + session + profile all point to a foreign org', () => {
    for (const actor of actors.filter(
      a => !a.membershipOrgIds.includes(ORG_UNRELATED),
    )) {
      it(`${actor.label} cannot bypass when all three inputs point to unrelated org`, () => {
        const r = resolveActiveOrg({
          urlOrgId: ORG_UNRELATED,
          sessionOrgId: ORG_UNRELATED,
          profileOrgId: ORG_UNRELATED,
          membershipOrgIds: actor.membershipOrgIds,
        });
        expect(r.orgId).not.toBe(ORG_UNRELATED);
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
    const attackCombinations: Array<Parameters<typeof resolveActiveOrg>[0] & { label: string }> = [
      { label: 'URL attack only', urlOrgId: ORG_OTHER_TENANT, sessionOrgId: null, profileOrgId: null, membershipOrgIds: [ORG_PARENT] },
      { label: 'URL + session attack', urlOrgId: ORG_OTHER_TENANT, sessionOrgId: ORG_OTHER_TENANT, profileOrgId: null, membershipOrgIds: [ORG_PARENT] },
      { label: 'all three inputs foreign', urlOrgId: ORG_OTHER_TENANT, sessionOrgId: ORG_OTHER_TENANT, profileOrgId: ORG_OTHER_TENANT, membershipOrgIds: [ORG_PARENT] },
      { label: 'session attack only', urlOrgId: null, sessionOrgId: ORG_OTHER_TENANT, profileOrgId: null, membershipOrgIds: [ORG_PARENT] },
      { label: 'session attack with valid profile', urlOrgId: null, sessionOrgId: ORG_OTHER_TENANT, profileOrgId: ORG_PARENT, membershipOrgIds: [ORG_PARENT] },
      { label: 'profile drift only', urlOrgId: null, sessionOrgId: null, profileOrgId: ORG_OTHER_TENANT, membershipOrgIds: [ORG_PARENT] },
      { label: 'dual-member URL attack with valid session', urlOrgId: ORG_OTHER_TENANT, sessionOrgId: ORG_SUB, profileOrgId: ORG_PARENT, membershipOrgIds: [ORG_PARENT, ORG_SUB] },
      { label: 'dual-member session + profile drift', urlOrgId: null, sessionOrgId: ORG_OTHER_TENANT, profileOrgId: ORG_OTHER_TENANT, membershipOrgIds: [ORG_PARENT, ORG_SUB] },
      { label: 'no memberships — all inputs poisoned', urlOrgId: ORG_PARENT, sessionOrgId: ORG_PARENT, profileOrgId: ORG_PARENT, membershipOrgIds: [] },
      { label: 'no memberships — all inputs empty', urlOrgId: null, sessionOrgId: null, profileOrgId: null, membershipOrgIds: [] },
    ];

    for (const combo of attackCombinations) {
      it(`${combo.label}: resolved orgId is in membershipOrgIds or null`, () => {
        const r = resolveActiveOrg(combo);
        if (r.orgId !== null) {
          expect(
            combo.membershipOrgIds.includes(r.orgId),
            `resolved orgId ${r.orgId} is not in membershipOrgIds [${combo.membershipOrgIds.join(', ')}]`,
          ).toBe(true);
        } else {
          expect(r.source.kind).toBe('none');
        }
      });
    }

    it('legitimate: URL to member org resolves (not null)', () => {
      const r = resolveActiveOrg({
        urlOrgId: ORG_PARENT,
        sessionOrgId: null,
        profileOrgId: null,
        membershipOrgIds: [ORG_PARENT],
      });
      expect(r.orgId).toBe(ORG_PARENT);
      expect(r.source.kind).toBe('url');
    });

    it('legitimate: session to member org resolves (not null)', () => {
      const r = resolveActiveOrg({
        urlOrgId: null,
        sessionOrgId: ORG_SUB,
        profileOrgId: ORG_PARENT,
        membershipOrgIds: [ORG_PARENT, ORG_SUB],
      });
      expect(r.orgId).toBe(ORG_SUB);
      expect(r.source.kind).toBe('session');
    });

    it('empty-string urlOrgId is treated as absent (JS truthiness)', () => {
      const r = resolveActiveOrg({
        urlOrgId: '',
        sessionOrgId: null,
        profileOrgId: ORG_PARENT,
        membershipOrgIds: [ORG_PARENT],
      });
      expect(r.orgId).toBe(ORG_PARENT);
      expect(r.source.kind).toBe('implicit_primary');
    });

    it('empty-string sessionOrgId is treated as absent (JS truthiness)', () => {
      const r = resolveActiveOrg({
        urlOrgId: null,
        sessionOrgId: '',
        profileOrgId: ORG_PARENT,
        membershipOrgIds: [ORG_PARENT],
      });
      expect(r.orgId).toBe(ORG_PARENT);
      expect(r.source.kind).toBe('implicit_primary');
    });
  });
});

describe('useActiveOrg hook — referential stability (CodeRabbit #689)', () => {
  beforeEach(() => {
    mockOrgsState.orgs = [];
    mockOrgsState.loading = false;
    mockProfileState.profile = null;
    mockProfileState.loading = false;
    try { window.localStorage.removeItem('arkova.activeOrg.v1'); } catch { /* noop */ }
  });

  it('returns a stable result object when org array reference changes but IDs are the same', async () => {
    const { useActiveOrg } = await import('./useActiveOrg');

    mockProfileState.profile = { org_id: ORG_PARENT };
    mockProfileState.loading = false;
    mockOrgsState.orgs = [{ orgId: ORG_PARENT }, { orgId: ORG_SUB }];
    mockOrgsState.loading = false;

    const { result, rerender } = renderHook(() => useActiveOrg());
    const first = result.current;

    expect(first.orgId).toBe(ORG_PARENT);
    expect(first.source.kind).toBe('implicit_primary');

    // Simulate background refetch — new array reference, same org IDs
    mockOrgsState.orgs = [{ orgId: ORG_PARENT }, { orgId: ORG_SUB }];
    rerender();

    expect(result.current).toBe(first);
  });

  it('invalidates when org IDs actually change', async () => {
    const { useActiveOrg } = await import('./useActiveOrg');

    mockProfileState.profile = { org_id: ORG_PARENT };
    mockProfileState.loading = false;
    mockOrgsState.orgs = [{ orgId: ORG_PARENT }];
    mockOrgsState.loading = false;

    const { result, rerender } = renderHook(() => useActiveOrg());
    const first = result.current;

    expect(first.hasMultipleMemberships).toBe(false);

    // A real membership change — new org added
    mockOrgsState.orgs = [{ orgId: ORG_PARENT }, { orgId: ORG_SUB }];
    rerender();

    expect(result.current.hasMultipleMemberships).toBe(true);
    expect(result.current).not.toBe(first);
  });
});

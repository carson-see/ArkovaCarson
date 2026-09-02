/**
 * Wiring tests for the sub-org tenancy soak driver.
 *
 * The SQL semantics are already proven against real PostgreSQL by the
 * 0429/0430/0431 migration proofs. What is worth pinning here is the driver's
 * own contract, because a driver that cannot fail is not evidence: every named
 * property must be asserted, and a broken property must fail the cycle rather
 * than being counted as a pass.
 */

import { describe, it, expect, vi } from 'vitest';
import { parseArgs, runCycle, type Rpc } from './suborg-tenancy-driver.js';

/** Service-role responses for a fully healthy cycle. */
function healthyService() {
  // The driver checks the audit row is attributed to the ACTUAL caller it
  // passed, so the fake has to echo that id rather than a literal.
  let lastCaller = '';
  return {
    call: vi.fn(async (fn: string, args: Record<string, unknown>) => {
      if (args.p_caller_user_id) lastCaller = String(args.p_caller_user_id);
      if (fn === 'allocate_credits_to_sub_org') {
        // The stranger probe passes a caller that is not the seeded admin.
        const note = String(args.p_note ?? '');
        if (note === 'soak' && args.p_amount === 5) return { error: 'parent_admin_required' };
        return { success: true };
      }
      if (fn === 'suspend_suborg') return { success: true };
      return {};
    }),
    sql: vi.fn(async (table: string, query: string) => {
      if (table === 'org_credits') {
        const [parent, child] = query.match(/in\.\(([^)]+)\)/)![1].split(',');
        return [{ org_id: parent, balance: 60 }, { org_id: child, balance: 40 }];
      }
      if (table === 'organizations') {
        return query.includes('credit_enforcement_enabled')
          ? [{ credit_enforcement_enabled: true }]
          : [{ sub_org_listing_parent_optin: false, sub_org_listing_child_optin: false }];
      }
      if (table === 'audit_events') return [{ actor_id: lastCaller }];
      if (table === 'anchors') return [{ id: 'a1' }];
      return [];
    }),
    write: vi.fn(async () => {}),
  } as unknown as Rpc;
}

/** Anonymous responses: hidden until both consents, then visible. */
function anonWithConsentSequence(profileCounts: number[], childParent: string | null = null) {
  let i = 0;
  return {
    call: vi.fn(async (fn: string) => {
      if (fn === 'get_org_subtree') return { nodes: [{ parent_org_id: childParent }] };
      return { sub_organizations: new Array(profileCounts[i++] ?? 0).fill({}) };
    }),
    sql: vi.fn(async () => []),
    write: vi.fn(async () => {}),
  } as unknown as Rpc;
}

describe('suborg tenancy driver', () => {
  it('passes a healthy cycle with every property asserted', async () => {
    const svc = healthyService();
    // profile: hidden, hidden after one consent, visible after both
    const { checks } = await runCycle(svc, anonWithConsentSequence([0, 0, 1]));

    expect(Object.values(checks).every(Boolean)).toBe(true);
    // The properties this PR exists to guarantee must all be present.
    for (const key of [
      'f1_profile_hides_unconsented_child',
      'f1_child_root_hides_its_parent',
      'f1_one_consent_is_not_enough',
      'f1_both_consents_publish',
      'f1_reparent_revokes_both_consents',
      'f3_parent_admin_can_fund',
      'f3_balances_conserved',
      'f3_non_admin_refused',
      'f2_per_org_enforcement_settable',
      'f6_reclaim_returns_balance',
      'f6_suspend_succeeds',
      'bug3874_suspension_audit_row_written',
      'f6_records_survive_offboarding',
    ]) {
      expect(checks, `missing property ${key}`).toHaveProperty(key);
    }
  });

  it('FAILS the cycle when the child root leaks its parent', async () => {
    // The exact regression code review caught. A driver that shrugged at this
    // would have soaked the bug for 48h and called it evidence.
    const svc = healthyService();
    await expect(runCycle(svc, anonWithConsentSequence([0, 0, 1], 'leaked-parent-id')))
      .rejects.toThrow(/f1_child_root_hides_its_parent/);
  });

  it('FAILS the cycle when an unconsented child is published', async () => {
    const svc = healthyService();
    await expect(runCycle(svc, anonWithConsentSequence([1, 1, 1])))
      .rejects.toThrow(/f1_profile_hides_unconsented_child/);
  });

  it('FAILS the cycle when the suspension audit row is missing', async () => {
    // SCRUM-3874's exact signature: suspend succeeds, audit row silently gone.
    const svc = healthyService();
    (svc.sql as ReturnType<typeof vi.fn>).mockImplementation(async (table: string, query: string) => {
      if (table === 'audit_events') return [];
      if (table === 'org_credits') {
        const [parent, child] = query.match(/in\.\(([^)]+)\)/)![1].split(',');
        return [{ org_id: parent, balance: 60 }, { org_id: child, balance: 40 }];
      }
      if (table === 'organizations') {
        return query.includes('credit_enforcement_enabled')
          ? [{ credit_enforcement_enabled: true }]
          : [{ sub_org_listing_parent_optin: false, sub_org_listing_child_optin: false }];
      }
      if (table === 'anchors') return [{ id: 'a1' }];
      return [];
    });
    await expect(runCycle(svc, anonWithConsentSequence([0, 0, 1])))
      .rejects.toThrow(/bug3874_suspension_audit_row_written/);
  });

  it('refuses to produce soak evidence without an admission file', () => {
    const { args, blockers } = parseArgs([
      '--mode', 'live', '--supabase-url', 'https://x.supabase.co',
      '--service-role-key', 'k', '--anon-key', 'a',
    ]);
    expect(args.mode).toBe('live');
    expect(blockers).toContain('live mode requires --admission-json');
  });
});

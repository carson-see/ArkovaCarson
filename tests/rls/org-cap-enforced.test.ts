/**
 * SCRUM-4474 — `org_credits.cap_enforced` must actually bite.
 *
 * Behavioural proof against a live Supabase instance for migration 0440.
 * These are the assertions the 0440 review (F1/F2/F5) found missing: the
 * existing suites exercise `ensureAnchorQuotaAvailable` against hand-built
 * rows, so nothing covered the two paths that WRITE those rows.
 *
 *   1. F1 — a new top-level org (the AFTER INSERT trigger
 *      `trg_seed_free_tier_org_credits`) is seeded with an ENFORCED cap:
 *      anchor_quota = 10 AND cap_enforced = true. Before the fix the row took
 *      the column DEFAULT false, i.e. every new signup could anchor without
 *      limit — the exact thing 0327 exists to prevent.
 *   2. F1 — a SUB-org (parent_org_id NOT NULL) is still NOT seeded; the
 *      SCRUM-1170 parent-allocation model is unchanged.
 *   3. F2 — the deliberately-kept 4-arg `admin_set_org_anchor_quota` writes
 *      cap_enforced = (is_test AND anchor_quota IS NOT NULL), so it cannot
 *      record an inert cap during the paused-deploy window.
 *   4. F2 — the same RPC with is_test = false leaves cap_enforced = false, so
 *      it cannot start capping a live billable partner (Login Defense holds a
 *      recorded-but-inert anchor_quota = 15) that nobody decided to cap.
 *   5. F5 — the DB itself refuses `cap_enforced = true AND anchor_quota IS
 *      NULL` via CHECK org_credits_cap_enforced_needs_quota, even on a direct
 *      service_role UPDATE that bypasses every RPC.
 *   6. The SECURITY DEFINER posture holds: neither anon nor authenticated may
 *      EXECUTE admin_set_org_cap.
 *
 * Prerequisites:
 *   - Supabase running locally (supabase start)
 *   - Database reset with seed data (supabase db reset)
 *   - Migration 0440 applied
 *
 * Pattern mirrored from tests/rls/connector-artifact.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createServiceClient,
  createAnonClient,
  type TypedClient,
} from '../../src/tests/rls/helpers';

/**
 * The run id lands in the final field of a UUID literal, which Postgres parses
 * as hex. `Date.now().toString(36)` is base36, so it emits letters past `f`
 * ("mtov7fd3") and every insert died on `22P02 invalid input syntax for type
 * uuid` before it could reach the behaviour under test. Base 16 keeps it a
 * legal node field; the 4 random hex digits keep two runs that share a
 * millisecond from colliding on the same org ids.
 */
const RUN_ID = (
  Date.now().toString(16) +
  Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')
).slice(-12);

const PARENT_ORG_ID = `cafe0000-0000-4000-8000-${RUN_ID}`;
const CHILD_ORG_ID = `cafe0001-0000-4000-8000-${RUN_ID}`;
const RPC_TEST_ORG_ID = `cafe0002-0000-4000-8000-${RUN_ID}`;
const RPC_BILLABLE_ORG_ID = `cafe0003-0000-4000-8000-${RUN_ID}`;

const ALL_ORG_IDS = [PARENT_ORG_ID, CHILD_ORG_ID, RPC_TEST_ORG_ID, RPC_BILLABLE_ORG_ID];

/** The free-tier default stamped by seed_free_tier_org_credits() (0327). */
const FREE_TIER_QUOTA = 10;

describe('SCRUM-4474 — cap_enforced is written, not merely recorded', () => {
  let svc: TypedClient;
  let anon: TypedClient;

  beforeAll(async () => {
    svc = createServiceClient();
    anon = createAnonClient();
    // Clean any residue from a previous run of this spec.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).from('org_credits').delete().in('org_id', ALL_ORG_IDS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).from('organizations').delete().in('id', ALL_ORG_IDS);
  }, 60_000);

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).from('org_credits').delete().in('org_id', ALL_ORG_IDS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (svc as any).from('organizations').delete().in('id', ALL_ORG_IDS);
  }, 60_000);

  it('F1: a new top-level signup is seeded with an ENFORCED cap, not an inert one', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: orgErr } = await (svc as any).from('organizations').insert({
      id: PARENT_ORG_ID,
      legal_name: `rls-4474-parent-${RUN_ID}`,
      display_name: `rls-4474-parent-${RUN_ID}`,
    });
    expect(orgErr).toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row, error } = await (svc as any)
      .from('org_credits')
      .select('anchor_quota, is_test, cap_enforced')
      .eq('org_id', PARENT_ORG_ID)
      .maybeSingle();

    expect(error).toBeNull();
    expect(row).not.toBeNull();
    expect(row.anchor_quota).toBe(FREE_TIER_QUOTA);
    expect(row.is_test).toBe(true);
    // The assertion that reds on 0440 as originally written: the seed function
    // did not name cap_enforced, so the row took the column DEFAULT false and
    // the free-tier cap never bit for any org created after the migration.
    expect(row.cap_enforced).toBe(true);
  });

  it('F1: a sub-org is still not seeded (SCRUM-1170 parent allocation unchanged)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: orgErr } = await (svc as any).from('organizations').insert({
      id: CHILD_ORG_ID,
      legal_name: `rls-4474-child-${RUN_ID}`,
      display_name: `rls-4474-child-${RUN_ID}`,
      parent_org_id: PARENT_ORG_ID,
    });
    expect(orgErr).toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: row, error } = await (svc as any)
      .from('org_credits')
      .select('org_id')
      .eq('org_id', CHILD_ORG_ID)
      .maybeSingle();

    expect(error).toBeNull();
    expect(row).toBeNull();
  });

  it('F2: the kept 4-arg RPC writes an ENFORCED cap for a test org', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: orgErr } = await (svc as any).from('organizations').insert({
      id: RPC_TEST_ORG_ID,
      legal_name: `rls-4474-rpc-test-${RUN_ID}`,
      display_name: `rls-4474-rpc-test-${RUN_ID}`,
    });
    expect(orgErr).toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (svc as any).rpc('admin_set_org_anchor_quota', {
      p_org_id: RPC_TEST_ORG_ID,
      p_anchor_quota: 2000,
      p_is_test: true,
      p_actor: null,
    });

    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row.anchor_quota).toBe(2000);
    expect(row.is_test).toBe(true);
    // Reds on 0440 as originally written: the body wrote is_test +
    // anchor_quota and never cap_enforced, so the deprecated endpoint silently
    // became a way to record a cap that does not bite.
    expect(row.cap_enforced).toBe(true);
  });

  it('F2: the kept 4-arg RPC does NOT enforce a cap on a billable org', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: orgErr } = await (svc as any).from('organizations').insert({
      id: RPC_BILLABLE_ORG_ID,
      legal_name: `rls-4474-rpc-billable-${RUN_ID}`,
      display_name: `rls-4474-rpc-billable-${RUN_ID}`,
    });
    expect(orgErr).toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (svc as any).rpc('admin_set_org_anchor_quota', {
      p_org_id: RPC_BILLABLE_ORG_ID,
      p_anchor_quota: 15,
      p_is_test: false,
      p_actor: null,
    });

    expect(error).toBeNull();
    const row = Array.isArray(data) ? data[0] : data;
    expect(row.anchor_quota).toBe(15);
    // The recorded-but-inert state is preserved deliberately. Login Defense
    // holds exactly this shape in prod; enforcing it here would cap a live
    // partner at 15 with nobody deciding to.
    expect(row.cap_enforced).toBe(false);
  });

  it('F5: the DB refuses an enforced cap with no number, even on a direct UPDATE', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (svc as any)
      .from('org_credits')
      .update({ cap_enforced: true, anchor_quota: null })
      .eq('org_id', PARENT_ORG_ID);

    expect(error).not.toBeNull();
    expect(`${error?.message} ${error?.details ?? ''}`).toMatch(
      /org_credits_cap_enforced_needs_quota|check constraint/i,
    );
  });

  it('admin_set_org_cap is not executable by anon', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (anon as any).rpc('admin_set_org_cap', {
      p_org_id: PARENT_ORG_ID,
      p_anchor_quota: 1,
      p_cap_enforced: true,
      p_is_test: true,
      p_actor: null,
    });
    expect(error).not.toBeNull();
  });
});

/**
 * SCRUM-3864 (epic SCRUM-3863) — two-party sub-org public-listing consent.
 *
 * Behavioural proof for the `protect_org_tenancy_fields()` trigger and the
 * `get_public_org_profile` / `get_org_subtree` consent filters added by
 * migration 0429, run as a CI-tracked vitest suite against a live Supabase
 * instance rather than the one-off `docs/staging/hakichain-suborgs-2026-09/verify-0429.sql`
 * script (which was run by hand against a throwaway cluster and is not wired
 * into CI). This suite exists because `sub_org_listing_parent_optin` /
 * `sub_org_listing_child_optin` had no automated regression coverage before
 * this session — the migration shipped without one.
 *
 * SEEDED-USER CAVEAT: Carson (`DEMO_CREDENTIALS.adminEmail`) is a PLATFORM
 * admin (`profiles.is_platform_admin = true`, `supabase/seed.sql`), so
 * `protect_org_tenancy_fields()`'s entire column-guard block is a no-op for
 * him (`coalesce(is_current_user_platform_admin(), false)` short-circuits
 * it) — using him as either persona would make every negative-path
 * assertion below pass for the wrong reason. This suite instead uses
 * `demo-admin@arkova.local` (an ordinary `ORG_ADMIN`, `is_platform_admin =
 * false`) as the PARENT admin and `demo-user@arkova.local` (an
 * `INDIVIDUAL` with no home org) as the CHILD admin, added to two freshly
 * created test orgs via `org_members` so their existing seeded JWTs carry
 * exactly the authority under test — neither is a platform admin.
 *
 * Pattern mirrored from tests/rls/org-cap-enforced.test.ts (dynamic orgs keyed
 * by a per-run id) and docs/staging/hakichain-suborgs-2026-09/verify-0429.sql
 * (which assertion each case proves).
 *
 * Prerequisites: local Supabase running + seeded (`supabase start` /
 * `supabase db reset`), migration 0429 applied.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createServiceClient,
  createAnonClient,
  withBetaAdmin,
  withIndividualUser,
  cleanupClient,
  type TypedClient,
} from '../../src/tests/rls/helpers';

// See tests/rls/org-cap-enforced.test.ts for why this must be base-16, not
// base-36: the run id lands in a UUID literal's final hex field.
const RUN_ID = (
  Date.now().toString(16) +
  Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
).slice(-12);

const PARENT_ORG_ID = `dade0000-0000-4000-8000-${RUN_ID}`;
const CHILD_ORG_ID = `dade0001-0000-4000-8000-${RUN_ID}`;
const OTHER_PARENT_ORG_ID = `dade0002-0000-4000-8000-${RUN_ID}`;
const ALL_ORG_IDS = [PARENT_ORG_ID, CHILD_ORG_ID, OTHER_PARENT_ORG_ID];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

describe('SCRUM-3864 — sub-org listing consent (migration 0429 trigger + RPC filters)', () => {
  let svc: TypedClient;
  let anon: TypedClient;
  let parentAdmin: TypedClient; // demo-admin: ORG_ADMIN of PARENT_ORG_ID, also an org_members owner of CHILD_ORG_ID (mirrors buildAffiliateMembershipRows)
  let childAdmin: TypedClient; // demo-user: org_members admin of CHILD_ORG_ID ONLY

  const DEMO_ADMIN_ID = '55555555-0000-4000-8000-000000000001';
  const DEMO_USER_ID = '55555555-0000-4000-8000-000000000002';

  beforeAll(async () => {
    svc = createServiceClient();
    anon = createAnonClient();
    parentAdmin = await withBetaAdmin();
    childAdmin = await withIndividualUser();

    await (svc as AnyClient).from('org_members')
      .delete()
      .in('org_id', ALL_ORG_IDS);
    await (svc as AnyClient).from('organizations').delete().in('id', ALL_ORG_IDS);

    const { error: parentErr } = await (svc as AnyClient).from('organizations').insert({
      id: PARENT_ORG_ID,
      legal_name: `rls-3864-parent-${RUN_ID}`,
      display_name: `rls-3864-parent-${RUN_ID}`,
    });
    expect(parentErr).toBeNull();

    const { error: otherParentErr } = await (svc as AnyClient).from('organizations').insert({
      id: OTHER_PARENT_ORG_ID,
      legal_name: `rls-3864-other-parent-${RUN_ID}`,
      display_name: `rls-3864-other-parent-${RUN_ID}`,
    });
    expect(otherParentErr).toBeNull();

    const { error: childErr } = await (svc as AnyClient).from('organizations').insert({
      id: CHILD_ORG_ID,
      legal_name: `rls-3864-child-${RUN_ID}`,
      display_name: `rls-3864-child-${RUN_ID}`,
      parent_org_id: PARENT_ORG_ID,
      parent_approval_status: 'APPROVED',
    });
    expect(childErr).toBeNull();

    // demo-admin: owner of the parent AND (mirroring buildAffiliateMembershipRows)
    // an owner of the child too — the exact shape that makes the trigger's
    // second-clause guard against a parent admin signing the child's own half
    // load-bearing rather than moot.
    const { error: memErr } = await (svc as AnyClient).from('org_members').insert([
      { user_id: DEMO_ADMIN_ID, org_id: PARENT_ORG_ID, role: 'owner' },
      { user_id: DEMO_ADMIN_ID, org_id: CHILD_ORG_ID, role: 'owner' },
      { user_id: DEMO_USER_ID, org_id: CHILD_ORG_ID, role: 'admin' },
    ]);
    expect(memErr).toBeNull();
  }, 60_000);

  afterAll(async () => {
    await (svc as AnyClient).from('org_members').delete().in('org_id', ALL_ORG_IDS);
    await (svc as AnyClient).from('organizations').delete().in('id', ALL_ORG_IDS);
    await cleanupClient(parentAdmin);
    await cleanupClient(childAdmin);
  }, 60_000);

  it('default: neither RPC lists the child before either consent is given', async () => {
    const { data: profileData, error: profileErr } = await (anon as AnyClient)
      .rpc('get_public_org_profile', { p_org_id: PARENT_ORG_ID });
    expect(profileErr).toBeNull();
    const profile = Array.isArray(profileData) ? profileData[0]?.get_public_org_profile ?? profileData[0] : profileData;
    expect(profile.sub_organizations).toEqual([]);

    const { data: treeData, error: treeErr } = await (anon as AnyClient)
      .rpc('get_org_subtree', { p_root_id: PARENT_ORG_ID });
    expect(treeErr).toBeNull();
    const tree = Array.isArray(treeData) ? treeData[0]?.get_org_subtree ?? treeData[0] : treeData;
    expect(tree.nodes).toHaveLength(1); // root only
  });

  it('the parent admin may set the parent half of the consent', async () => {
    const { data, error } = await (parentAdmin as AnyClient)
      .from('organizations')
      .update({ sub_org_listing_parent_optin: true })
      .eq('id', CHILD_ORG_ID)
      .select('id, sub_org_listing_parent_optin');

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data[0].sub_org_listing_parent_optin).toBe(true);
  });

  it('one consent alone still keeps the affiliation off both public surfaces', async () => {
    const { data: profileData } = await (anon as AnyClient)
      .rpc('get_public_org_profile', { p_org_id: PARENT_ORG_ID });
    const profile = Array.isArray(profileData) ? profileData[0]?.get_public_org_profile ?? profileData[0] : profileData;
    expect(profile.sub_organizations).toEqual([]);
  });

  it('the parent admin CANNOT sign the child half — trigger refuses even though they are also an org_members owner of the child', async () => {
    const { error } = await (parentAdmin as AnyClient)
      .from('organizations')
      .update({ sub_org_listing_child_optin: true })
      .eq('id', CHILD_ORG_ID);

    expect(error).not.toBeNull();
    expect(error.code).toBe('42501');
  });

  it('the child admin (not an admin of the parent) CAN sign the child half', async () => {
    const { data, error } = await (childAdmin as AnyClient)
      .from('organizations')
      .update({ sub_org_listing_child_optin: true })
      .eq('id', CHILD_ORG_ID)
      .select('id, sub_org_listing_child_optin');

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data[0].sub_org_listing_child_optin).toBe(true);
  });

  it('the child admin CANNOT forge the parent half', async () => {
    const { error } = await (childAdmin as AnyClient)
      .from('organizations')
      .update({ sub_org_listing_parent_optin: false })
      .eq('id', CHILD_ORG_ID);

    expect(error).not.toBeNull();
    expect(error.code).toBe('42501');
  });

  it('both consents true: the child is published on get_public_org_profile AND get_org_subtree', async () => {
    const { data: profileData } = await (anon as AnyClient)
      .rpc('get_public_org_profile', { p_org_id: PARENT_ORG_ID });
    const profile = Array.isArray(profileData) ? profileData[0]?.get_public_org_profile ?? profileData[0] : profileData;
    expect(profile.sub_organizations).toHaveLength(1);
    expect(profile.sub_organizations[0].org_id).toBe(CHILD_ORG_ID);

    const { data: treeData } = await (anon as AnyClient)
      .rpc('get_org_subtree', { p_root_id: PARENT_ORG_ID });
    const tree = Array.isArray(treeData) ? treeData[0]?.get_org_subtree ?? treeData[0] : treeData;
    expect(tree.nodes).toHaveLength(2);
    const childNode = tree.nodes.find((n: { org_id: string }) => n.org_id === CHILD_ORG_ID);
    expect(childNode).toBeDefined();
    expect(childNode.parent_org_id).toBe(PARENT_ORG_ID);
  });

  it('neither admin may self-serve credit_enforcement_enabled', async () => {
    const asParent = await (parentAdmin as AnyClient)
      .from('organizations')
      .update({ credit_enforcement_enabled: true })
      .eq('id', CHILD_ORG_ID);
    expect(asParent.error).not.toBeNull();
    expect(asParent.error.code).toBe('42501');

    const asChild = await (childAdmin as AnyClient)
      .from('organizations')
      .update({ credit_enforcement_enabled: true })
      .eq('id', CHILD_ORG_ID);
    expect(asChild.error).not.toBeNull();
    expect(asChild.error.code).toBe('42501');
  });

  it('re-parenting resets both consent flags, even for a trusted (service_role) caller', async () => {
    const { error } = await (svc as AnyClient)
      .from('organizations')
      .update({ parent_org_id: OTHER_PARENT_ORG_ID })
      .eq('id', CHILD_ORG_ID);
    expect(error).toBeNull();

    const { data: row } = await (svc as AnyClient)
      .from('organizations')
      .select('sub_org_listing_parent_optin, sub_org_listing_child_optin')
      .eq('id', CHILD_ORG_ID)
      .single();

    expect(row.sub_org_listing_parent_optin).toBe(false);
    expect(row.sub_org_listing_child_optin).toBe(false);

    // And the now-unaffiliated org no longer shows up under its OLD parent.
    const { data: profileData } = await (anon as AnyClient)
      .rpc('get_public_org_profile', { p_org_id: PARENT_ORG_ID });
    const profile = Array.isArray(profileData) ? profileData[0]?.get_public_org_profile ?? profileData[0] : profileData;
    expect(profile.sub_organizations).toEqual([]);
  });

  it('anon may not write either consent column directly', async () => {
    const { error } = await (anon as AnyClient)
      .from('organizations')
      .update({ sub_org_listing_child_optin: true })
      .eq('id', CHILD_ORG_ID);
    // RLS blocks the row entirely for anon (no matching UPDATE policy) —
    // PostgREST reports this as a zero-row success, not an error, so the
    // meaningful assertion is that the value on the row is unchanged.
    void error;
    const { data: row } = await (svc as AnyClient)
      .from('organizations')
      .select('sub_org_listing_child_optin')
      .eq('id', CHILD_ORG_ID)
      .single();
    expect(row.sub_org_listing_child_optin).toBe(false);
  });
});

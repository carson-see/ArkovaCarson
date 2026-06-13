/**
 * Credential-Source Provider RLS Tests — SCRUM-1611 CSI-04A.
 *
 * After migration 0329, the `member_integrations` table accepts
 * `provider IN ('docusign', 'credly', 'accredible', 'udemy')`. Other values
 * are rejected. RLS policies established by migration 0320 (member reads own
 * rows; org admin reads all org rows; deny writes) remain in force for the
 * new providers.
 *
 * Tests verify:
 *   1. Widened CHECK accepts the 3 credential-source providers
 *   2. Widened CHECK still rejects unknown providers (defence-in-depth)
 *   3. Member can SELECT own credly row
 *   4. Org admin can SELECT all credly rows in own org
 *   5. Cross-org isolation: admin in org A cannot SELECT credly rows in org B
 *   6. Authenticated users cannot INSERT credly row (service_role only)
 *   7. kek_version defaults to 1 on insert with no explicit value
 *
 * Prerequisites:
 *   - Supabase running locally (supabase start)
 *   - Database reset with seed data (supabase db reset)
 *   - Migration 0329 applied
 *
 * Pattern mirrored from tests/rls/docusign-integrations.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  withUser,
  createServiceClient,
  withIndividualUser,
  DEMO_CREDENTIALS,
  ORG_IDS,
  type TypedClient,
} from '../../src/tests/rls/helpers';

const ARKOVA_ORG_ID = ORG_IDS.arkova;
const BETA_ORG_ID = ORG_IDS.betaCorp;

const ROW_TAG_PREFIX = 'rls-test-csi-04a-';

describe('SCRUM-1611 — member_integrations widened for credential-source providers (CSI-04A)', () => {
  let serviceClient: TypedClient;
  let adminClient: TypedClient;
  let betaAdminClient: TypedClient;
  let userClient: TypedClient;
  let arkovaAdminUserId: string;
  let betaAdminUserId: string;
  let memberUserId: string;

  beforeAll(async () => {
    serviceClient = createServiceClient();
    adminClient = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
    betaAdminClient = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
    userClient = await withIndividualUser();

    const { data: arkovaAdminProfile } = await adminClient.auth.getUser();
    arkovaAdminUserId = arkovaAdminProfile.user?.id ?? '';

    const { data: betaAdminProfile } = await betaAdminClient.auth.getUser();
    betaAdminUserId = betaAdminProfile.user?.id ?? '';

    const { data: memberProfile } = await userClient.auth.getUser();
    memberUserId = memberProfile.user?.id ?? '';
  });

  afterAll(async () => {
    // Cleanup every row seeded by this file in one pass.
    await serviceClient
      .from('member_integrations')
      .delete()
      .like('account_id', `${ROW_TAG_PREFIX}%`);

    await adminClient.auth.signOut();
    await betaAdminClient.auth.signOut();
    await userClient.auth.signOut();
  });

  describe('CHECK constraint widening', () => {
    it('accepts provider="credly" via service_role insert', async () => {
      const { error } = await serviceClient.from('member_integrations').insert({
        user_id: arkovaAdminUserId,
        org_id: ARKOVA_ORG_ID,
        provider: 'credly',
        account_id: `${ROW_TAG_PREFIX}credly-arkova`,
        account_label: 'RLS Test Credly Arkova',
      });
      expect(error).toBeNull();
    });

    it('accepts provider="accredible" via service_role insert', async () => {
      const { error } = await serviceClient.from('member_integrations').insert({
        user_id: arkovaAdminUserId,
        org_id: ARKOVA_ORG_ID,
        provider: 'accredible',
        account_id: `${ROW_TAG_PREFIX}accredible-arkova`,
        account_label: 'RLS Test Accredible Arkova',
      });
      expect(error).toBeNull();
    });

    it('accepts provider="udemy" via service_role insert', async () => {
      const { error } = await serviceClient.from('member_integrations').insert({
        user_id: arkovaAdminUserId,
        org_id: ARKOVA_ORG_ID,
        provider: 'udemy',
        account_id: `${ROW_TAG_PREFIX}udemy-arkova`,
        account_label: 'RLS Test Udemy Arkova',
      });
      expect(error).toBeNull();
    });

    it('still rejects unknown providers (defence-in-depth)', async () => {
      const { error } = await serviceClient.from('member_integrations').insert({
        user_id: arkovaAdminUserId,
        org_id: ARKOVA_ORG_ID,
        provider: 'linkedin', // not in the enum
        account_id: `${ROW_TAG_PREFIX}rejected`,
      });
      expect(error).not.toBeNull();
      // PostgREST surfaces CHECK violations with code 23514
      expect(error?.code).toBe('23514');
    });

    it('still accepts the original docusign provider (back-compat)', async () => {
      const { error } = await serviceClient.from('member_integrations').insert({
        user_id: arkovaAdminUserId,
        org_id: ARKOVA_ORG_ID,
        provider: 'docusign',
        account_id: `${ROW_TAG_PREFIX}docusign-backcompat`,
      });
      expect(error).toBeNull();
      // Cleanup this one inline; not in afterAll tag list.
      await serviceClient
        .from('member_integrations')
        .delete()
        .eq('account_id', `${ROW_TAG_PREFIX}docusign-backcompat`);
    });
  });

  describe('kek_version default', () => {
    it('defaults to 1 when not explicitly set on insert', async () => {
      const { data, error } = await serviceClient
        .from('member_integrations')
        .select('kek_version')
        .eq('account_id', `${ROW_TAG_PREFIX}credly-arkova`)
        .limit(1);
      expect(error).toBeNull();
      expect(data?.[0]?.kek_version).toBe(1);
    });
  });

  describe('RLS policies extend to new providers', () => {
    beforeAll(async () => {
      // Seed a beta-org credly row to test cross-org isolation
      await serviceClient.from('member_integrations').insert({
        user_id: betaAdminUserId,
        org_id: BETA_ORG_ID,
        provider: 'credly',
        account_id: `${ROW_TAG_PREFIX}credly-beta`,
        account_label: 'RLS Test Credly Beta',
      });

      await serviceClient.from('member_integrations').insert({
        user_id: memberUserId,
        org_id: ARKOVA_ORG_ID,
        provider: 'credly',
        account_id: `${ROW_TAG_PREFIX}credly-member-own`,
        account_label: 'RLS Test Credly Individual',
      });
    });

    it('member can SELECT own credly row', async () => {
      const { data, error } = await userClient
        .from('member_integrations')
        .select('*')
        .eq('account_id', `${ROW_TAG_PREFIX}credly-member-own`);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
      expect(data?.[0]?.user_id).toBe(memberUserId);
    });

    it('ORG_ADMIN can SELECT credly rows in own org', async () => {
      const { data, error } = await adminClient
        .from('member_integrations')
        .select('*')
        .eq('org_id', ARKOVA_ORG_ID)
        .eq('provider', 'credly');
      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
      expect((data as Array<{ org_id: string }>).every((r) => r.org_id === ARKOVA_ORG_ID)).toBe(true);
    });

    it('ORG_ADMIN cannot SELECT credly rows in another org (cross-tenant blocked)', async () => {
      const { data, error } = await adminClient
        .from('member_integrations')
        .select('*')
        .eq('org_id', BETA_ORG_ID)
        .eq('provider', 'credly');
      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it('Individual user cannot INSERT credly row (deny-all write for authenticated)', async () => {
      const { error } = await userClient
        .from('member_integrations')
        .insert({
          user_id: arkovaAdminUserId,
          org_id: ARKOVA_ORG_ID,
          provider: 'credly',
          account_id: `${ROW_TAG_PREFIX}should-fail`,
        });
      expect(error).not.toBeNull();
      // RLS denial — could be 42501, PGRST301, or PostgREST policy-violation code.
      expect(['42501', 'PGRST301', '23505']).toContain(error?.code ?? '');
    });
  });
});

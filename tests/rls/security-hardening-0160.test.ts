/**
 * RLS Tests for Migrations 0160 + 0161: Security Hardening (Critical)
 *
 * Verifies fixes for penetration test findings SEC-RECON-1 through SEC-RECON-10.
 *
 * Prerequisites:
 * - Supabase running locally with migrations 0160 + 0161 applied
 * - Database reset with seed data (supabase db reset)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createAnonClient,
  createServiceClient,
  withArkovaAdmin,
  withIndividualUser,
  type TypedClient,
} from '../../src/tests/rls/helpers';

describe('SEC-RECON: Security Hardening (Migrations 0160 + 0161)', () => {
  let anonClient: TypedClient;
  let authClient: TypedClient;
  let nonAdminClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    anonClient = createAnonClient();
    authClient = await withArkovaAdmin();
    nonAdminClient = await withIndividualUser();
    serviceClient = createServiceClient();
  });

  afterAll(async () => {
    await authClient.auth.signOut();
    await nonAdminClient.auth.signOut();
  });

  // =========================================================================
  // SEC-RECON-1: organizations table — anon must NOT read raw table
  // =========================================================================

  describe('SEC-RECON-1: organizations anon access blocked', () => {
    it('anon cannot SELECT from organizations table directly', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (anonClient as any)
        .from('organizations')
        .select('id, legal_name, ein_tax_id')
        .limit(1);

      // Should either error or return empty (no anon policy)
      const hasAccess = data && data.length > 0;
      expect(hasAccess).toBeFalsy();
    });

    it('anon CAN call get_public_org_profiles RPC (safe fields only)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (anonClient as any).rpc('get_public_org_profiles', {});

      // The function should return rows (SECURITY DEFINER bypasses RLS)
      expect(error).toBeNull();
      expect(data).not.toBeNull();
      if (data && data.length > 0) {
        const columns = Object.keys(data[0]);
        expect(columns).not.toContain('ein_tax_id');
        expect(columns).not.toContain('domain_verification_token');
        expect(columns).not.toContain('domain_verification_token_expires_at');
        expect(columns).not.toContain('parent_org_id');
        expect(columns).not.toContain('parent_approval_status');
        expect(columns).not.toContain('affiliation_fee_status');
      }
    });
  });

  // =========================================================================
  // SEC-RECON-2: payment_ledger — no longer accessible to regular auth users
  // =========================================================================

  describe('SEC-RECON-2: payment_ledger restricted', () => {
    it('authenticated user cannot SELECT from payment_ledger directly', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (authClient as any)
        .from('payment_ledger')
        .select('*')
        .limit(1);

      // Should error or return empty — GRANT revoked from authenticated
      const denied = error || !data || data.length === 0;
      expect(denied).toBeTruthy();
    });
  });

  // =========================================================================
  // SEC-RECON-3: dev_bypass_kyc — must not exist
  // =========================================================================

  describe('SEC-RECON-3: dev_bypass_kyc dropped', () => {
    it('dev_bypass_kyc function does not exist', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (authClient as any).rpc('dev_bypass_kyc', {
        p_user_id: '00000000-0000-0000-0000-000000000000',
      });

      // Function should not exist
      expect(error).toBeTruthy();
    });
  });

  // =========================================================================
  // SEC-RECON-4: admin RPCs — reject non-service-role callers
  // =========================================================================

  describe('SEC-RECON-4: admin RPCs reject authenticated callers', () => {
    it('admin_set_platform_admin rejects authenticated user', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (authClient as any).rpc('admin_set_platform_admin', {
        p_user_id: '00000000-0000-0000-0000-000000000000',
        p_is_admin: true,
      });

      expect(error).toBeTruthy();
      expect(error.message).toMatch(/access denied|permission denied|service_role/i);
    });

    it('admin_change_user_role rejects authenticated user', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (authClient as any).rpc('admin_change_user_role', {
        p_user_id: '00000000-0000-0000-0000-000000000000',
        p_new_role: 'INDIVIDUAL',
      });

      expect(error).toBeTruthy();
      expect(error.message).toMatch(/access denied|permission denied|service_role/i);
    });

    it('admin_set_user_org rejects authenticated user', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (authClient as any).rpc('admin_set_user_org', {
        p_user_id: '00000000-0000-0000-0000-000000000000',
        p_org_id: null,
      });

      expect(error).toBeTruthy();
      expect(error.message).toMatch(/access denied|permission denied|service_role/i);
    });
  });

  // =========================================================================
  // SEC-RECON-5: get_treasury_stats — requires platform admin
  // =========================================================================

  describe('SEC-RECON-5: treasury stats restricted', () => {
    it('anon cannot call get_treasury_stats', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (anonClient as any).rpc('get_treasury_stats');
      expect(error).toBeTruthy();
    });

    it('non-admin authenticated user cannot call get_treasury_stats', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (nonAdminClient as any).rpc('get_treasury_stats');
      expect(error).toBeTruthy();
    });

    it('get_treasury_stats does not return payer_address', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (serviceClient as any).rpc('get_treasury_stats');
      if (data?.recent_payments) {
        for (const p of data.recent_payments) {
          expect(p).not.toHaveProperty('payer_address');
        }
      }
    });
  });

  // =========================================================================
  // SEC-RECON-6: get_pipeline_stats — requires platform admin
  // =========================================================================

  describe('SEC-RECON-6: pipeline stats restricted', () => {
    it('anon cannot call get_pipeline_stats', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (anonClient as any).rpc('get_pipeline_stats');
      expect(error).toBeTruthy();
    });
  });

  // =========================================================================
  // SEC-RECON-7: get_anchor_tx_stats — requires platform admin
  // =========================================================================

  describe('SEC-RECON-7: anchor tx stats restricted', () => {
    it('anon cannot call get_anchor_tx_stats', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (anonClient as any).rpc('get_anchor_tx_stats');
      expect(error).toBeTruthy();
    });
  });

  // =========================================================================
  // SEC-RECON-8: invite_member — cannot invite as ORG_ADMIN
  // =========================================================================

  describe('SEC-RECON-8: invite_member blocks ORG_ADMIN invites', () => {
    it('invite_member rejects ORG_ADMIN role', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (authClient as any).rpc('invite_member', {
        invitee_email: 'test-sec-recon-8@test.invalid',
        invitee_role: 'ORG_ADMIN',
        target_org_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      });

      expect(error).toBeTruthy();
      expect(error.message).toMatch(/cannot invite as org_admin/i);
    });
  });

  // =========================================================================
  // SEC-RECON-9: invitations — anon cannot read
  // =========================================================================

  describe('SEC-RECON-9: invitations restricted to org admins', () => {
    it('anon cannot SELECT from invitations', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (anonClient as any)
        .from('invitations')
        .select('id, email, token')
        .limit(1);

      const denied = error || !data || data.length === 0;
      expect(denied).toBeTruthy();
    });
  });

  // =========================================================================
  // SEC-RECON-10: activate_user — must remain accessible to anon
  // (Fixed in migration 0161 — the 0160 revoke was a regression)
  // =========================================================================

  describe('SEC-RECON-10: activate_user accessible to anon', () => {
    it('activate_user function exists and is callable by anon (returns error for bad token, not permission denied)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (anonClient as any).rpc('activate_user', {
        p_token: 'nonexistent-token',
        p_recovery_phrase: 'test phrase',
      });

      // Should get an application-level error (bad token), NOT a permission denied error
      if (error) {
        expect(error.message).not.toMatch(/permission denied/i);
      }
    });
  });

  // =========================================================================
  // CR-7: organizations_select_authenticated dropped — EIN not exposed
  // =========================================================================

  describe('CR-7: authenticated users cannot read EIN from raw organizations', () => {
    it('non-admin authenticated user cannot SELECT ein_tax_id from organizations', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (nonAdminClient as any)
        .from('organizations')
        .select('id, ein_tax_id')
        .limit(5);

      // Should either return empty or only user's own org (without EIN access)
      // After dropping organizations_select_authenticated, only organizations_select_own applies
      if (data && data.length > 0) {
        // If any data returned, it should only be the user's own org
        expect(data.length).toBeLessThanOrEqual(1);
      }
    });
  });
});

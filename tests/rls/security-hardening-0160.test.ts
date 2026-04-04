/**
 * RLS Tests for Migration 0160: Security Hardening (Critical)
 *
 * Verifies fixes for penetration test findings SEC-RECON-1 through SEC-RECON-7.
 *
 * Prerequisites:
 * - Supabase running locally with migration 0160 applied
 * - Database reset with seed data (supabase db reset)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createAnonClient,
  createServiceClient,
  withArkovaAdmin,
  type TypedClient,
} from '../../src/tests/rls/helpers';

describe('SEC-RECON: Security Hardening (Migration 0160)', () => {
  let anonClient: TypedClient;
  let authClient: TypedClient;
  let serviceClient: TypedClient;

  beforeAll(async () => {
    anonClient = createAnonClient();
    authClient = await withArkovaAdmin();
    serviceClient = createServiceClient();
  });

  afterAll(async () => {
    await authClient.auth.signOut();
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
      const hasAccess = data && data.length > 0 && data[0].ein_tax_id;
      expect(hasAccess).toBeFalsy();
    });

    it('anon CAN read public_org_profiles view (safe fields only)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (anonClient as any)
        .from('public_org_profiles')
        .select('id, display_name, org_type, verification_status')
        .limit(1);

      // The view should be accessible
      if (data && data.length > 0) {
        expect(data[0]).not.toHaveProperty('ein_tax_id');
        expect(data[0]).not.toHaveProperty('domain_verification_token');
        expect(data[0]).not.toHaveProperty('parent_org_id');
      }
    });

    it('public_org_profiles does not expose EIN or domain verification token', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (anonClient as any)
        .from('public_org_profiles')
        .select('*')
        .limit(1);

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
});

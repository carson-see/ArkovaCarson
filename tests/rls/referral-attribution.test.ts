/**
 * SCRUM-5024 — referral codes and attribution, against a LIVE database.
 *
 * Every property asserted here is enforced by SQL — an RLS policy, a GRANT, a
 * CHECK constraint, a partial unique index, or a SECURITY DEFINER body. Per
 * `tests/rls/agents.md`, a mocked suite cannot own any of them: a mock that
 * stands in for "the database refuses" certifies the premise instead of
 * testing it. The worker suite (`services/worker/src/api/v1/referrals.test.ts`)
 * owns the caller's handling of the result; the two are complementary.
 *
 * The disclosure boundary is the reason this file exists. `organization_referrals`
 * has no SELECT policy matching `referred_org_id`, so a referred organization
 * must see ZERO rows about itself. That is a deliberate asymmetry and the kind
 * of thing a future "let's add the obvious policy" change would quietly undo.
 *
 * Prerequisites:
 *   - Supabase running locally (`supabase start`)
 *   - Database reset with seed data (`supabase db reset`)
 *   - Migration 0455 applied
 *
 * Run: `npx vitest run --config vitest.config.rls.ts tests/rls/referral-attribution.test.ts`
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createServiceClient,
  createAnonClient,
  withUser,
  cleanupClient,
  DEMO_CREDENTIALS,
  ORG_IDS,
  type TypedClient,
} from '../../src/tests/rls/helpers';

/** The DB CHECK this suite exists to hold:
 *    referral_codes_code_format
 *      CHECK (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$')  */
const DB_CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/** Hex-safe run id — the suffix lands in a UUID literal, which Postgres parses
 *  as hex, so base36 letters past `f` would not parse. */
const RUN = Date.now().toString(16).slice(-8);
const REFERRED_ORG = `cccccccc-0000-4000-8000-0000${RUN.slice(0, 8)}`;

// `arkova` is the referrer (Carson is its ORG_ADMIN and a platform admin);
// `betaCorp` is the unrelated tenant used for cross-tenant assertions.
const REFERRER_ORG = ORG_IDS.arkova;
const OTHER_ORG = ORG_IDS.betaCorp;

let service: TypedClient;
let referrerCode: string;

describe('SCRUM-5024 referral codes and attribution (live DB)', () => {
  beforeAll(async () => {
    service = createServiceClient();

    // A throwaway organization to stand in for "the referred org". Created by
    // service_role so no policy is involved in the fixture itself.
    const { error: orgError } = await service.from('organizations').insert({
      id: REFERRED_ORG,
      legal_name: `Referral Fixture ${RUN} Inc.`,
      display_name: `Referral Fixture ${RUN}`,
    });
    // Load-bearing: a silently missing fixture would make several assertions
    // below pass vacuously.
    if (orgError) throw new Error(`fixture org insert failed: ${orgError.message}`);
  });

  afterAll(async () => {
    await service.from('organization_referrals').delete().eq('referred_org_id', REFERRED_ORG);
    await service.from('referral_codes').delete().eq('org_id', REFERRED_ORG);
    await service.from('organizations').delete().eq('id', REFERRED_ORG);
  });

  describe('minting', () => {
    it('1. ensure_org_referral_code mints a code matching the format CHECK, and is idempotent', async () => {
      const { data: first, error: firstError } = await service.rpc('ensure_org_referral_code', {
        p_org_id: REFERRER_ORG,
      });
      expect(firstError).toBeNull();
      expect(String(first)).toMatch(DB_CODE_RE);
      referrerCode = String(first);

      const { data: second, error: secondError } = await service.rpc('ensure_org_referral_code', {
        p_org_id: REFERRER_ORG,
      });
      expect(secondError).toBeNull();
      // Idempotent by adoption, not by rotation: the same string comes back.
      expect(second).toBe(referrerCode);
    });

    it('2. one active code per organization — a second ACTIVE row is refused by the partial unique index', async () => {
      const { error } = await service.from('referral_codes').insert({
        org_id: REFERRER_ORG,
        code: 'ZZZZ9999',
        active: true,
      });
      expect(error).not.toBeNull();
      expect(error?.code).toBe('23505');
    });

    it('3. the format CHECK refuses the visually ambiguous characters, even via service_role', async () => {
      for (const bad of ['IIIIIIII', 'LLLLLLLL', 'OOOOOOOO', '00000000', '11111111', 'ABCD234']) {
        const { error } = await service.from('referral_codes').insert({
          org_id: REFERRED_ORG,
          code: bad,
          active: true,
        });
        expect(error?.code, `expected a CHECK violation for ${bad}`).toBe('23514');
      }
    });

    it('4. generate_referral_code is NOT executable by anon or authenticated', async () => {
      const anon = createAnonClient();
      const { error: anonError } = await anon.rpc('generate_referral_code');
      expect(anonError?.code).toBe('42501');

      const member = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
      const { error: authError } = await member.rpc('generate_referral_code');
      expect(authError?.code).toBe('42501');
      await cleanupClient(member);
    });

    it('5. a non-admin of the target org cannot mint for it', async () => {
      const outsider = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
      const { error } = await outsider.rpc('ensure_org_referral_code', { p_org_id: REFERRER_ORG });
      // insufficient_privilege raised by the function body.
      expect(error).not.toBeNull();
      expect(error?.message ?? '').toMatch(/not authorized/i);
      await cleanupClient(outsider);
    });
  });

  describe('recording an attribution', () => {
    it('6. a lower-case, padded code still applies — the RPC upper-cases and trims', async () => {
      const { data, error } = await service.rpc('record_org_referral', {
        p_org_id: REFERRED_ORG,
        p_code: `  ${referrerCode.toLowerCase()}  `,
        p_source: 'signup',
      });
      expect(error).toBeNull();
      expect(data).toMatchObject({ applied: true, reason: 'recorded' });
    });

    it('7. replay is idempotent — the second attempt is already_attributed, not a second row', async () => {
      const { data } = await service.rpc('record_org_referral', {
        p_org_id: REFERRED_ORG,
        p_code: referrerCode,
        p_source: 'api',
      });
      expect(data).toMatchObject({ applied: false, reason: 'already_attributed' });

      const { count } = await service
        .from('organization_referrals')
        .select('*', { count: 'exact', head: true })
        .eq('referred_org_id', REFERRED_ORG);
      expect(count).toBe(1);
    });

    it('8. an unknown code writes an audit row and creates NO attribution edge', async () => {
      const before = await service
        .from('audit_events')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'organization.referral_code_invalid')
        .eq('org_id', OTHER_ORG);

      const { data } = await service.rpc('record_org_referral', {
        p_org_id: OTHER_ORG,
        p_code: 'QQQQ7777',
        p_source: 'signup',
      });
      expect(data).toMatchObject({ applied: false, reason: 'unknown_code' });

      const after = await service
        .from('audit_events')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'organization.referral_code_invalid')
        .eq('org_id', OTHER_ORG);
      expect((after.count ?? 0) - (before.count ?? 0)).toBe(1);

      const { count: edges } = await service
        .from('organization_referrals')
        .select('*', { count: 'exact', head: true })
        .eq('referred_org_id', OTHER_ORG);
      expect(edges).toBe(0);
    });

    it('9. self-referral is refused before any write', async () => {
      const { data } = await service.rpc('record_org_referral', {
        p_org_id: REFERRER_ORG,
        p_code: referrerCode,
        p_source: 'signup',
      });
      expect(data).toMatchObject({ applied: false, reason: 'self_referral' });

      const { count } = await service
        .from('organization_referrals')
        .select('*', { count: 'exact', head: true })
        .eq('referred_org_id', REFERRER_ORG);
      expect(count).toBe(0);
    });

    it('9b. an empty code is no_code and writes no audit row', async () => {
      const before = await service
        .from('audit_events')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'organization.referral_code_invalid');

      const { data } = await service.rpc('record_org_referral', {
        p_org_id: OTHER_ORG,
        p_code: '   ',
        p_source: 'signup',
      });
      expect(data).toMatchObject({ applied: false, reason: 'no_code' });

      const after = await service
        .from('audit_events')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'organization.referral_code_invalid');
      // The common case must not generate one audit row per unreferred signup.
      expect(after.count).toBe(before.count);
    });

    it('9c. the organization.referred audit row is filed against the REFERRER, never the referred org', async () => {
      const { count: onReferrer } = await service
        .from('audit_events')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'organization.referred')
        .eq('org_id', REFERRER_ORG);
      expect(onReferrer ?? 0).toBeGreaterThan(0);

      const { count: onReferred } = await service
        .from('audit_events')
        .select('*', { count: 'exact', head: true })
        .eq('event_type', 'organization.referred')
        .eq('org_id', REFERRED_ORG);
      // The referred org's own audit export must not disclose the attribution.
      expect(onReferred).toBe(0);
    });
  });

  describe('disclosure boundary', () => {
    it('10. the REFERRER sees its own referral rows', async () => {
      const admin = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
      const { data, error } = await admin
        .from('organization_referrals')
        .select('referred_org_id')
        .eq('referrer_org_id', REFERRER_ORG);
      expect(error).toBeNull();
      expect((data ?? []).map((r) => r.referred_org_id)).toContain(REFERRED_ORG);
      await cleanupClient(admin);

      const { data: rpcRows, error: rpcError } = await (await withUser(
        DEMO_CREDENTIALS.adminEmail,
        'ORG_ADMIN',
      )).rpc('get_org_referrals', { p_org_id: REFERRER_ORG });
      expect(rpcError).toBeNull();
      expect((rpcRows ?? []).length).toBeGreaterThan(0);
      // Projection boundary: exactly four fields, nothing about tier, credits,
      // domain or EIN.
      expect(Object.keys((rpcRows ?? [])[0]).sort()).toEqual([
        'display_name',
        'organization_public_id',
        'referred_at',
        'verification_status',
      ]);
    });

    it('11. the REFERRED organization sees nothing about itself', async () => {
      // A member of the referred org, created for this assertion: the whole
      // point is that membership of `referred_org_id` grants no visibility.
      const { data: created, error: createError } = await service.auth.admin.createUser({
        email: `referred-member-${RUN}@arkova.local`,
        password: `Referred-${RUN}-Aa1!`,
        email_confirm: true,
      });
      if (createError || !created?.user) throw new Error('fixture user creation failed');
      const memberId = created.user.id;

      try {
        await service.from('profiles').update({ org_id: REFERRED_ORG }).eq('id', memberId);
        await service.from('org_members').insert({
          org_id: REFERRED_ORG,
          user_id: memberId,
          role: 'owner',
        });

        const { createClient } = await import('@supabase/supabase-js');
        const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
        const anonKey = process.env.SUPABASE_ANON_KEY ?? '';
        const client = createClient(url, anonKey);
        const { error: signInError } = await client.auth.signInWithPassword({
          email: `referred-member-${RUN}@arkova.local`,
          password: `Referred-${RUN}-Aa1!`,
        });
        expect(signInError).toBeNull();

        const { data, error } = await client
          .from('organization_referrals')
          .select('referred_org_id, referrer_org_id');
        // RLS filters rather than errors: zero rows is the refusal.
        expect(error).toBeNull();
        expect(data ?? []).toEqual([]);

        // And the RPC refuses outright for an org they are not the referrer of.
        const { error: rpcError } = await client.rpc('get_org_referrals', {
          p_org_id: REFERRER_ORG,
        });
        expect(rpcError).not.toBeNull();
      } finally {
        await service.from('org_members').delete().eq('user_id', memberId);
        await service.auth.admin.deleteUser(memberId);
      }
    });

    it('12. an unrelated tenant sees zero rows, and anon sees nothing at all', async () => {
      const other = await withUser(DEMO_CREDENTIALS.betaAdminEmail, 'ORG_ADMIN');
      const { data: otherRows } = await other.from('organization_referrals').select('referred_org_id');
      expect((otherRows ?? []).map((r) => r.referred_org_id)).not.toContain(REFERRED_ORG);
      const { data: otherCodes } = await other.from('referral_codes').select('code');
      expect((otherCodes ?? []).map((c) => c.code)).not.toContain(referrerCode);
      await cleanupClient(other);

      const anon = createAnonClient();
      const { data: anonReferrals, error: anonReferralsError } = await anon
        .from('organization_referrals')
        .select('referred_org_id');
      expect(anonReferralsError !== null || (anonReferrals ?? []).length === 0).toBe(true);
      const { data: anonCodes, error: anonCodesError } = await anon.from('referral_codes').select('code');
      expect(anonCodesError !== null || (anonCodes ?? []).length === 0).toBe(true);
    });

    it('13. a platform admin can read both tables', async () => {
      // Carson is `is_platform_admin` in seed.sql; the platform-admin policy is
      // the second USING branch on each table.
      const admin = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');
      const { error: codesError } = await admin.from('referral_codes').select('code').limit(1);
      const { error: refsError } = await admin
        .from('organization_referrals')
        .select('referred_org_id')
        .limit(1);
      expect(codesError).toBeNull();
      expect(refsError).toBeNull();
      await cleanupClient(admin);
    });
  });

  describe('write surface', () => {
    it('14. authenticated cannot INSERT, UPDATE or DELETE either table — there is no write policy', async () => {
      const admin = await withUser(DEMO_CREDENTIALS.adminEmail, 'ORG_ADMIN');

      const { error: insertCode } = await admin
        .from('referral_codes')
        .insert({ org_id: REFERRER_ORG, code: 'WWWW8888', active: true });
      expect(insertCode).not.toBeNull();

      const { error: updateCode } = await admin
        .from('referral_codes')
        .update({ active: false, revoked_at: new Date().toISOString() })
        .eq('org_id', REFERRER_ORG);
      // A missing UPDATE policy filters to zero rows OR raises 42501; both are
      // a refusal, but a successful revoke is not.
      const { data: stillActive } = await admin
        .from('referral_codes')
        .select('active')
        .eq('org_id', REFERRER_ORG)
        .eq('active', true);
      expect(updateCode !== null || (stillActive ?? []).length === 1).toBe(true);

      const { error: insertRef } = await admin.from('organization_referrals').insert({
        referred_org_id: OTHER_ORG,
        referrer_org_id: REFERRER_ORG,
        referral_code_used: referrerCode,
        source: 'signup',
      });
      expect(insertRef).not.toBeNull();

      await admin.from('organization_referrals').delete().eq('referred_org_id', REFERRED_ORG);
      const { count } = await service
        .from('organization_referrals')
        .select('*', { count: 'exact', head: true })
        .eq('referred_org_id', REFERRED_ORG);
      expect(count).toBe(1);

      await cleanupClient(admin);
    });

    it('15. the no-self CHECK and the source CHECK hold against a direct service_role write', async () => {
      const { error: selfError } = await service.from('organization_referrals').insert({
        referred_org_id: OTHER_ORG,
        referrer_org_id: OTHER_ORG,
        referral_code_used: referrerCode,
        source: 'signup',
      });
      expect(selfError?.code).toBe('23514');

      const { error: sourceError } = await service.from('organization_referrals').insert({
        referred_org_id: OTHER_ORG,
        referrer_org_id: REFERRER_ORG,
        referral_code_used: referrerCode,
        // Not in CHECK (source IN ('signup','admin_provisioning','api'))
        source: 'partner_portal',
      });
      expect(sourceError?.code).toBe('23514');
    });

    it('16. the revoked-consistency CHECK refuses an inactive row with no revoked_at', async () => {
      const { error } = await service.from('referral_codes').insert({
        org_id: REFERRED_ORG,
        code: 'YYYY5555',
        active: false,
      });
      expect(error?.code).toBe('23514');
    });
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0470_uat17_verified_domain_and_atomic_member_add.sql'),
  'utf8',
);

describe('UAT-17 verified-domain and member-add migration', () => {
  it('requires one verified exact-domain claimant and a confirmed mailbox', () => {
    expect(sql).toMatch(/domain_verified IS TRUE/i);
    expect(sql).toMatch(/v_match_count <> 1/i);
    expect(sql).toMatch(/email_confirmed_at IS NOT NULL/i);
    expect(sql).toMatch(/SELECT count\(\*\),[\s\S]+array_agg\(id ORDER BY id\)[\s\S]+INTO v_match_count, v_org_id, v_org_name/i);
  });

  it('keeps the privileged add RPC service-only and atomic', () => {
    expect(sql).toMatch(/get_caller_role\(\) IS DISTINCT FROM 'service_role'/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.add_existing_org_member[\s\S]+FROM PUBLIC, anon, authenticated/i);
    expect(sql).toMatch(/ON CONFLICT ON CONSTRAINT org_members_unique_membership DO NOTHING/i);
    expect(sql).toMatch(/v_inserted := coalesce\(v_inserted, false\)/i);
    expect(sql).toMatch(/v_existing_role IS DISTINCT FROM v_member_role/i);
    expect(sql).toMatch(/RAISE EXCEPTION 'membership_role_conflict'/i);
    expect(sql).toMatch(/INSERT INTO audit_events/i);
  });

  it('fails closed for inactive authority, unavailable orgs and ambiguous emails', () => {
    expect(sql).toMatch(/p\.status = 'ACTIVE'/i);
    expect(sql).toMatch(/o\.suspended IS FALSE/i);
    expect(sql).toMatch(/ambiguous_user/i);
  });
});

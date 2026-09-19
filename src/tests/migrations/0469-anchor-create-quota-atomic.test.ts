import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0469_uat12_atomic_anchor_create_quota.sql'),
  'utf8',
);

describe('0469 UAT-12 atomic canonical create quota', () => {
  it('keeps the existing RPC signature and service-only boundary', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.create_anchor_submission\(/i);
    expect(migration).toMatch(/auth\.role\(\)\) IS DISTINCT FROM 'service_role'/i);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.create_anchor_submission[\s\S]*FROM PUBLIC, anon, authenticated/i);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_anchor_submission[\s\S]*TO service_role/i);
  });

  it('rejects NULL action, fingerprint, and tag arrays before any write', () => {
    expect(migration).toMatch(/p_action IS NULL OR p_action NOT IN \('queue', 'instant'\)/i);
    expect(migration).toMatch(/p_fingerprint IS NULL OR p_fingerprint !~ '\^\[0-9a-f\]\{64\}\$'/i);
    expect(migration).toMatch(/p_user_tags IS NULL OR p_org_tags IS NULL/i);
    expect(migration).toMatch(/RETURN jsonb_build_object\('success', false, 'error', 'invalid_request'\)/i);
  });

  it('derives current tier limits and reserves the org counter after identity insertion', () => {
    expect(migration).toMatch(/WHEN 'FREE' THEN 100::bigint/i);
    expect(migration).toMatch(/WHEN 'PAID' THEN 10000::bigint/i);
    expect(migration).toMatch(/WHEN 'ENTERPRISE' THEN 1000000::bigint/i);
    expect(migration.indexOf('INSERT INTO public.anchors')).toBeLessThan(migration.indexOf('INSERT INTO public.org_daily_usage'));
    expect(migration).toMatch(/ON CONFLICT \(org_id, usage_date, quota_kind\) DO UPDATE[\s\S]*WHERE public\.org_daily_usage\.count < v_limit/i);
  });

  it('rolls denied and duplicate creates back before returning bounded errors', () => {
    expect(migration).toMatch(/RAISE EXCEPTION 'org_anchor_quota_exceeded' USING ERRCODE = 'P1201'/i);
    expect(migration).toMatch(/WHEN unique_violation THEN[\s\S]*'error', 'duplicate'/i);
    expect(migration).toMatch(/WHEN SQLSTATE 'P1201' THEN[\s\S]*'error', 'quota_exceeded'[\s\S]*'limit', v_limit[\s\S]*'current'/i);
  });

  it('documents personal scope and the preserved global fingerprint identity', () => {
    expect(migration).toMatch(/globally unique per \(user_id, fingerprint\)/i);
    expect(migration).toMatch(/Personal submissions have no org_daily_usage row/i);
  });
});

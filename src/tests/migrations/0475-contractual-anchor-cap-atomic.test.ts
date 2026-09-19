import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0475_atomic_contractual_anchor_cap.sql'),
  'utf8',
);

describe('0475 atomic contractual anchor cap', () => {
  it('is a compensating definition based on the immutable canonical 0474 file', () => {
    expect(migration).toMatch(/0474 migration file, SHA256[\s\S]*00a15bd4a90e3003a93d0b3645b73d4aafa7cdd9bafc5561c61d07a92e6e64bb/i);
    expect(migration).toMatch(/Production still had the older 0461-era RPC/i);
    expect(migration).not.toMatch(/production pg_get_functiondef MD5 4b73e7b8252fec8da79994f651df147e/i);
    expect(migration).toMatch(/Rollback: restore the complete create_anchor_submission definition from 0474/i);
  });

  it('locks the contract authority before counting active anchors', () => {
    const lock = migration.indexOf('FOR UPDATE;');
    const count = migration.indexOf('SELECT count(*) INTO v_contract_used');
    const insert = migration.indexOf('INSERT INTO public.anchors');
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(count);
    expect(count).toBeLessThan(insert);
    expect(migration).toMatch(/c\.org_id = p_org_id[\s\S]*FOR UPDATE/i);
    expect(migration).toMatch(/a\.org_id = p_org_id AND a\.deleted_at IS NULL/i);
    expect(migration).toMatch(/SELECT 1[\s\S]*LIMIT v_contract_limit[\s\S]*bounded_active_anchors/i);
    expect(migration).not.toMatch(/SELECT count\(\*\) INTO v_contract_used\s+FROM public\.anchors/i);
    expect(migration).toMatch(/SET lock_timeout TO '5s'/i);
  });

  it('keeps contractual and tier-daily denials distinct', () => {
    expect(migration).toMatch(/v_contract_enforced IS TRUE AND v_contract_limit IS NOT NULL/i);
    expect(migration).toMatch(/'error', 'contractual_quota_exceeded'[\s\S]*'limit', v_contract_limit[\s\S]*'current', v_contract_used/i);
    expect(migration).toMatch(/INSERT INTO public\.org_daily_usage[\s\S]*public\.org_daily_usage\.count < v_limit/i);
    expect(migration).toMatch(/'error', 'quota_exceeded'[\s\S]*'limit', v_limit/i);
  });

  it('preserves service-only authority', () => {
    expect(migration).toMatch(/auth\.role\(\)\) IS DISTINCT FROM 'service_role'/i);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.create_anchor_submission[\s\S]*FROM PUBLIC, anon, authenticated/i);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_anchor_submission[\s\S]*TO service_role/i);
  });
});

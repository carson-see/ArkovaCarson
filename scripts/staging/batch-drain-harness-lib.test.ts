import { describe, expect, it } from 'vitest';

import { resolveRigTarget, runOrgId, PROD_PROJECT_REF } from './batch-drain-harness-lib';

describe('resolveRigTarget — prod is hard-blocked, only real staging refs pass', () => {
  const CLEAN = 'https://ujtlwnoqfhtitcmsnrpq.supabase.co';

  it('requires STAGING_SUPABASE_URL', () => {
    expect(() => resolveRigTarget(undefined)).toThrow(/STAGING_SUPABASE_URL is required/);
    expect(() => resolveRigTarget('   ')).toThrow(/STAGING_SUPABASE_URL is required/);
  });

  it('HARD-BLOCKS the prod project ref anywhere in the URL', () => {
    expect(() => resolveRigTarget(`https://${PROD_PROJECT_REF}.supabase.co`)).toThrow(/prod project ref/);
    // even if smuggled into a path or query
    expect(() => resolveRigTarget(`https://ujtlwnoqfhtitcmsnrpq.supabase.co/${PROD_PROJECT_REF}`)).toThrow(/prod project ref/);
  });

  it('rejects non-absolute URLs', () => {
    expect(() => resolveRigTarget('ujtlwnoqfhtitcmsnrpq.supabase.co')).toThrow(/absolute URL/);
  });

  it('rejects an attacker-controlled host that merely prefixes a valid ref label', () => {
    // full-host match closes the `<ref>.attacker.tld` hole
    expect(() => resolveRigTarget('https://ujtlwnoqfhtitcmsnrpq.attacker.tld')).toThrow(/must be <ref>\.supabase\.co/);
  });

  it('rejects a host whose leftmost label is not a 20-lowercase-letter ref', () => {
    expect(() => resolveRigTarget('https://short.supabase.co')).toThrow(/valid Supabase ref/);
    expect(() => resolveRigTarget('https://ujtlwnoqfht1tcmsnrpq.supabase.co')).toThrow(/valid Supabase ref/); // digit
    expect(() => resolveRigTarget('https://ujtlwnoqfhtitcmsnrpqx.supabase.co')).toThrow(/valid Supabase ref/); // 21 chars
  });

  it('accepts a clean isolated staging ref', () => {
    const t = resolveRigTarget(CLEAN);
    expect(t.ref).toBe('ujtlwnoqfhtitcmsnrpq');
    expect(t.url).toBe(CLEAN);
  });

  it('honors ALLOWED_STAGING_PROJECT_REFS as a positive allow-list', () => {
    // ref present → ok
    expect(resolveRigTarget(CLEAN, 'ujtlwnoqfhtitcmsnrpq,abcdefghijklmnopqrst').ref).toBe('ujtlwnoqfhtitcmsnrpq');
    // ref absent → refused
    expect(() => resolveRigTarget(CLEAN, 'abcdefghijklmnopqrst')).toThrow(/not in ALLOWED_STAGING_PROJECT_REFS/);
  });

  it('rejects an allow-list that itself contains the prod ref or a malformed entry', () => {
    expect(() => resolveRigTarget(CLEAN, PROD_PROJECT_REF)).toThrow(/invalid/);
    expect(() => resolveRigTarget(CLEAN, 'notavalidref')).toThrow(/invalid/);
  });
});

describe('runOrgId — stable, v4-shaped synthetic org per run', () => {
  it('is deterministic for a given run id', () => {
    expect(runOrgId('r1')).toBe(runOrgId('r1'));
    expect(runOrgId('r1')).not.toBe(runOrgId('r2'));
  });

  it('is shaped like a v4 UUID', () => {
    expect(runOrgId('anything')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('requires a run id', () => {
    expect(() => runOrgId('')).toThrow(/runId is required/);
  });
});

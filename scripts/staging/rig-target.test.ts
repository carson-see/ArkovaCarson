import { describe, expect, it } from 'vitest';

import { resolveRigTarget, PROD_PROJECT_REF } from './rig-target';

describe('resolveRigTarget — prod is hard-blocked, only real staging refs pass', () => {
  const CLEAN = 'https://ujtlwnoqfhtitcmsnrpq.supabase.co';

  it('requires STAGING_SUPABASE_URL', () => {
    expect(() => resolveRigTarget(undefined)).toThrow(/STAGING_SUPABASE_URL is required/);
    expect(() => resolveRigTarget('   ')).toThrow(/STAGING_SUPABASE_URL is required/);
  });

  it('HARD-BLOCKS the prod project ref anywhere in the URL', () => {
    expect(() => resolveRigTarget(`https://${PROD_PROJECT_REF}.supabase.co`)).toThrow(/prod project ref/);
    expect(() => resolveRigTarget(`https://ujtlwnoqfhtitcmsnrpq.supabase.co/${PROD_PROJECT_REF}`)).toThrow(/prod project ref/);
  });

  it('rejects non-absolute URLs', () => {
    expect(() => resolveRigTarget('ujtlwnoqfhtitcmsnrpq.supabase.co')).toThrow(/absolute URL/);
  });

  it('rejects an attacker host that merely prefixes a valid ref label', () => {
    expect(() => resolveRigTarget('https://ujtlwnoqfhtitcmsnrpq.attacker.tld')).toThrow(/must be <ref>\.supabase\.co/);
  });

  it('rejects a host whose leftmost label is not a 20-lowercase-letter ref', () => {
    expect(() => resolveRigTarget('https://short.supabase.co')).toThrow(/valid Supabase ref/);
    expect(() => resolveRigTarget('https://ujtlwnoqfht1tcmsnrpq.supabase.co')).toThrow(/valid Supabase ref/); // digit
    // NOTE: an uppercase host is NOT tested here — URL.hostname lowercases the
    // host per DNS case-insensitivity, so `UJTL….supabase.co` normalizes to a
    // valid ref rather than throwing. That is correct behavior.
  });

  it('accepts a clean 20-lowercase-letter staging ref', () => {
    expect(resolveRigTarget(CLEAN)).toEqual({ url: CLEAN, ref: 'ujtlwnoqfhtitcmsnrpq' });
  });

  it('enforces the ALLOWED_STAGING_PROJECT_REFS allow-list when set', () => {
    // ref not in the list → refused
    expect(() => resolveRigTarget(CLEAN, 'abcdefghijklmnopqrst')).toThrow(/not in ALLOWED_STAGING_PROJECT_REFS/);
    // ref in the list → accepted
    expect(resolveRigTarget(CLEAN, 'ujtlwnoqfhtitcmsnrpq,abcdefghijklmnopqrst').ref).toBe('ujtlwnoqfhtitcmsnrpq');
    // a prod ref in the allow-list is itself rejected
    expect(() => resolveRigTarget(CLEAN, PROD_PROJECT_REF)).toThrow(/invalid/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { resolveSupabaseCredentials } from './audit-secured-chain-integrity.js';

describe('audit-secured-chain-integrity credential resolution', () => {
  it('uses explicit staging Supabase credentials before any secret lookup', () => {
    const readSecret = vi.fn();

    const credentials = resolveSupabaseCredentials(
      {
        STAGING_SUPABASE_URL: 'https://staging.example.supabase.co',
        STAGING_SUPABASE_SERVICE_ROLE_KEY: 'staging-service-role',
        SUPABASE_URL: 'https://generic.example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'generic-service-role',
      },
      readSecret,
    );

    expect(credentials).toEqual({
      url: 'https://staging.example.supabase.co',
      key: 'staging-service-role',
      source: 'staging-env',
    });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('uses generic Supabase credentials when staging credentials are absent', () => {
    const readSecret = vi.fn();

    const credentials = resolveSupabaseCredentials(
      {
        SUPABASE_URL: 'https://generic.example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'generic-service-role',
      },
      readSecret,
    );

    expect(credentials).toEqual({
      url: 'https://generic.example.supabase.co',
      key: 'generic-service-role',
      source: 'generic-env',
    });
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('fails closed when only one staging credential is supplied', () => {
    expect(() =>
      resolveSupabaseCredentials(
        { STAGING_SUPABASE_URL: 'https://staging.example.supabase.co' },
        vi.fn(),
      ),
    ).toThrow(/Both STAGING_SUPABASE_URL and STAGING_SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('falls back to prod Secret Manager names when no env credentials are supplied', () => {
    const readSecret = vi.fn((secret: string) => `value-for-${secret}`);

    const credentials = resolveSupabaseCredentials({}, readSecret);

    expect(credentials).toEqual({
      url: 'value-for-supabase-url',
      key: 'value-for-supabase-service-role-key',
      source: 'prod-secret-manager',
    });
    expect(readSecret).toHaveBeenNthCalledWith(1, 'supabase-url');
    expect(readSecret).toHaveBeenNthCalledWith(2, 'supabase-service-role-key');
  });
});

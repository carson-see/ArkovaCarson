/**
 * Tests for platform-admin role resolution (SCRUM-2939).
 *
 * The authority for platform-admin status is the `profiles.is_platform_admin`
 * DB flag — the SAME source the worker (`utils/platformAdmin.ts`) and RLS
 * policies enforce. The legacy email whitelist is deliberately gone: a
 * client-only email list that diverges from the DB flag is a role-model
 * split, not a security boundary.
 */

import { describe, it, expect } from 'vitest';
import { isPlatformAdmin } from './platform';

describe('isPlatformAdmin', () => {
  it('returns true when the profile flag is true', () => {
    expect(isPlatformAdmin({ is_platform_admin: true })).toBe(true);
  });

  it('returns false when the profile flag is false', () => {
    expect(isPlatformAdmin({ is_platform_admin: false })).toBe(false);
  });

  it('returns false (fail-secure) when the flag is null', () => {
    expect(isPlatformAdmin({ is_platform_admin: null })).toBe(false);
  });

  it('returns false (fail-secure) when the flag is undefined', () => {
    expect(isPlatformAdmin({})).toBe(false);
  });

  it('returns false when the profile is null', () => {
    expect(isPlatformAdmin(null)).toBe(false);
  });

  it('returns false when the profile is undefined', () => {
    expect(isPlatformAdmin(undefined)).toBe(false);
  });

  it('does NOT grant access based on email (whitelist removed)', () => {
    // A profile whose email once appeared on the legacy whitelist but whose
    // DB flag is false must be denied — the DB flag is the only authority.
    expect(
      isPlatformAdmin({ email: 'carson@arkova.ai', is_platform_admin: false } as never)
    ).toBe(false);
  });
});

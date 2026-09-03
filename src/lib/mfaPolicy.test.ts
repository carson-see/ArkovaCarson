/**
 * mfaPolicy tests — SCRUM-3167 MFA enforcement policy.
 *
 * Phase 1 is role-based only (CTO ruling A4-3: org-level
 * `hipaa_mfa_required` enforcement is DROPPED from phase 1). These tests
 * pin: the baked default enforcement date, the three-tier date-resolution
 * precedence (dev/E2E override -> env var -> baked default), the strict UTC
 * date validation (A4-9), inclusive boundary semantics, grace-day rounding,
 * and the pure role predicate.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MFA_ADMIN_ENFORCE_FROM_DEFAULT,
  resolveMfaEnforceFrom,
  isMfaEnforcementActive,
  getMfaGraceDaysRemaining,
  isMfaRequiredRole,
} from './mfaPolicy';

const OVERRIDE_KEY = 'arkova_mfa_enforce_from_override';

// This test environment's global `localStorage` is a non-functional stub
// (Node's built-in Storage global, inert without `--localstorage-file`) —
// same reason `useTheme.test.ts` documents localStorage as "unavailable in
// test environments." Replace it with a real in-memory implementation on
// `window.localStorage`, mirroring `GettingStartedChecklist.test.tsx`'s
// established pattern. `globalThis.localStorage === window.localStorage`
// here, and `mfaPolicy.ts` reads the bare `localStorage` global at call
// time (never cached), so redefining `window.localStorage` is sufficient.
const store: Record<string, string> = {};
const localStorageMock = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => {
    store[key] = value;
  },
  removeItem: (key: string) => {
    delete store[key];
  },
  clear: () => {
    Object.keys(store).forEach((k) => delete store[k]);
  },
  get length() {
    return Object.keys(store).length;
  },
  key: (i: number) => Object.keys(store)[i] ?? null,
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorageMock.clear();
});

describe('MFA_ADMIN_ENFORCE_FROM_DEFAULT', () => {
  it('is baked to 2026-09-21T00:00:00Z', () => {
    expect(MFA_ADMIN_ENFORCE_FROM_DEFAULT).toBe('2026-09-21T00:00:00Z');
  });
});

describe('resolveMfaEnforceFrom — precedence', () => {
  it('falls back to the baked default when nothing else is set', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ALLOW_DATE_OVERRIDE', undefined);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', undefined);
    expect(resolveMfaEnforceFrom()).toBe(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
  });

  it('uses VITE_MFA_ENFORCE_FROM when set and valid, outside dev/override', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ALLOW_DATE_OVERRIDE', undefined);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', '2027-01-01T00:00:00Z');
    expect(resolveMfaEnforceFrom()).toBe('2027-01-01T00:00:00Z');
  });

  it('an invalid VITE_MFA_ENFORCE_FROM falls through to the baked default', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ALLOW_DATE_OVERRIDE', undefined);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', 'not-a-date');
    expect(resolveMfaEnforceFrom()).toBe(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
  });

  it('honours the localStorage override in DEV even without the allow-override flag', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_MFA_ALLOW_DATE_OVERRIDE', undefined);
    localStorage.setItem(OVERRIDE_KEY, '2020-01-01T00:00:00Z');
    expect(resolveMfaEnforceFrom()).toBe('2020-01-01T00:00:00Z');
  });

  it('honours the localStorage override in a PROD build when VITE_MFA_ALLOW_DATE_OVERRIDE=true (soak/E2E escape hatch, CTO ruling A4-1)', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ALLOW_DATE_OVERRIDE', 'true');
    localStorage.setItem(OVERRIDE_KEY, '2020-01-01T00:00:00Z');
    expect(resolveMfaEnforceFrom()).toBe('2020-01-01T00:00:00Z');
  });

  it('NEVER honours the localStorage override outside DEV without the allow-override flag — the prod-safety case', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ALLOW_DATE_OVERRIDE', undefined);
    localStorage.setItem(OVERRIDE_KEY, '2020-01-01T00:00:00Z');
    expect(resolveMfaEnforceFrom()).toBe(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
  });

  it('ignores a non-"true" VITE_MFA_ALLOW_DATE_OVERRIDE value (fail closed to exact string match)', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ALLOW_DATE_OVERRIDE', 'TRUE');
    localStorage.setItem(OVERRIDE_KEY, '2020-01-01T00:00:00Z');
    expect(resolveMfaEnforceFrom()).toBe(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
  });

  it('an invalid override string falls through to VITE_MFA_ENFORCE_FROM, not straight to the default', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', '2027-06-01T00:00:00Z');
    localStorage.setItem(OVERRIDE_KEY, 'garbage');
    expect(resolveMfaEnforceFrom()).toBe('2027-06-01T00:00:00Z');
  });

  it('an empty-string override is ignored (falls through)', () => {
    vi.stubEnv('DEV', true);
    localStorage.setItem(OVERRIDE_KEY, '');
    expect(resolveMfaEnforceFrom()).toBe(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
  });

  it('a non-UTC (missing Z) override string is rejected by the strict UTC regex', () => {
    vi.stubEnv('DEV', true);
    localStorage.setItem(OVERRIDE_KEY, '2020-01-01T00:00:00');
    expect(resolveMfaEnforceFrom()).toBe(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
  });

  it('a UTC override string with fractional seconds is accepted', () => {
    vi.stubEnv('DEV', true);
    localStorage.setItem(OVERRIDE_KEY, '2020-01-01T00:00:00.500Z');
    expect(resolveMfaEnforceFrom()).toBe('2020-01-01T00:00:00.500Z');
  });

  it('localStorage access is wrapped in try/catch — a throwing getItem never crashes resolution', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', '2027-06-01T00:00:00Z');
    vi.spyOn(localStorageMock, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked (private browsing)');
    });
    expect(() => resolveMfaEnforceFrom()).not.toThrow();
    expect(resolveMfaEnforceFrom()).toBe('2027-06-01T00:00:00Z');
  });

  it('does not read localStorage at all when override is not allowed (no unnecessary storage access)', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ALLOW_DATE_OVERRIDE', undefined);
    const getItemSpy = vi.spyOn(localStorageMock, 'getItem');
    resolveMfaEnforceFrom();
    expect(getItemSpy).not.toHaveBeenCalled();
  });
});

describe('isMfaEnforcementActive — inclusive UTC boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is false strictly before the enforcement date', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', undefined);
    const before = Date.parse('2026-09-20T23:59:59.999Z');
    expect(isMfaEnforcementActive(before)).toBe(false);
  });

  it('is true AT exactly the enforcement instant (inclusive boundary)', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', undefined);
    const at = Date.parse('2026-09-21T00:00:00.000Z');
    expect(isMfaEnforcementActive(at)).toBe(true);
  });

  it('is true strictly after the enforcement date', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', undefined);
    const after = Date.parse('2026-09-21T00:00:00.001Z');
    expect(isMfaEnforcementActive(after)).toBe(true);
  });

  it('defaults `now` to Date.now() when omitted', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', '2000-01-01T00:00:00Z');
    expect(isMfaEnforcementActive()).toBe(true);
  });
});

describe('getMfaGraceDaysRemaining — ceil days, min 0', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 0 at and after the enforcement instant', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', undefined);
    const at = Date.parse(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
    expect(getMfaGraceDaysRemaining(at)).toBe(0);
    expect(getMfaGraceDaysRemaining(at + 1)).toBe(0);
    expect(getMfaGraceDaysRemaining(at + 86_400_000)).toBe(0);
  });

  it('rounds a partial day UP (ceil) — half a day remaining still reads as 1 day', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', undefined);
    const at = Date.parse(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
    const halfDayBefore = at - 12 * 60 * 60 * 1000;
    expect(getMfaGraceDaysRemaining(halfDayBefore)).toBe(1);
  });

  it('returns exactly 1 for one full day remaining', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', undefined);
    const at = Date.parse(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
    const oneDayBefore = at - 24 * 60 * 60 * 1000;
    expect(getMfaGraceDaysRemaining(oneDayBefore)).toBe(1);
  });

  it('rounds up 25 hours remaining to 2 days', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', undefined);
    const at = Date.parse(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
    const twentyFiveHoursBefore = at - 25 * 60 * 60 * 1000;
    expect(getMfaGraceDaysRemaining(twentyFiveHoursBefore)).toBe(2);
  });
});

describe('isMfaEnforcementActive / getMfaGraceDaysRemaining — pre-resolved enforceFrom param (item 18/EA4)', () => {
  it('isMfaEnforcementActive uses the explicitly passed enforceFrom instead of re-resolving from env/localStorage', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', '2099-01-01T00:00:00Z'); // would say "not active" if re-resolved
    const at = Date.parse('2026-09-21T00:00:00Z');
    expect(isMfaEnforcementActive(at, '2026-09-21T00:00:00Z')).toBe(true);
  });

  it('getMfaGraceDaysRemaining uses the explicitly passed enforceFrom instead of re-resolving', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', '2099-01-01T00:00:00Z'); // would give a huge count if re-resolved
    const enforceFrom = '2026-09-21T00:00:00Z';
    const oneDayBefore = Date.parse(enforceFrom) - 24 * 60 * 60 * 1000;
    expect(getMfaGraceDaysRemaining(oneDayBefore, enforceFrom)).toBe(1);
  });

  it('both functions still resolve the date themselves when enforceFrom is omitted (backward compatible)', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_MFA_ENFORCE_FROM', undefined);
    const at = Date.parse(MFA_ADMIN_ENFORCE_FROM_DEFAULT);
    expect(isMfaEnforcementActive(at)).toBe(true);
    expect(getMfaGraceDaysRemaining(at)).toBe(0);
  });
});

describe('isMfaRequiredRole', () => {
  it('is true for ORG_ADMIN', () => {
    expect(isMfaRequiredRole({ role: 'ORG_ADMIN', is_platform_admin: false })).toBe(true);
  });

  it('is true for a platform admin regardless of org role', () => {
    expect(isMfaRequiredRole({ role: 'ORG_MEMBER', is_platform_admin: true })).toBe(true);
    expect(isMfaRequiredRole({ role: null, is_platform_admin: true })).toBe(true);
  });

  it('is false for ORG_MEMBER', () => {
    expect(isMfaRequiredRole({ role: 'ORG_MEMBER', is_platform_admin: false })).toBe(false);
  });

  it('is false for INDIVIDUAL', () => {
    expect(isMfaRequiredRole({ role: 'INDIVIDUAL', is_platform_admin: false })).toBe(false);
  });

  it('is false for null/undefined profile (fail open)', () => {
    expect(isMfaRequiredRole(null)).toBe(false);
    expect(isMfaRequiredRole(undefined)).toBe(false);
  });

  it('is false for a profile with role not yet assigned (real shape: role is null, is_platform_admin is a real non-nullable boolean column, not null)', () => {
    expect(isMfaRequiredRole({ role: null, is_platform_admin: false })).toBe(false);
  });
});

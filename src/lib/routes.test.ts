/**
 * Tests for route utility functions
 *
 * @see UAT3-04 — verifyUrl uses production base URL
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { verifyPath, verifyUrl, getAppBaseUrl, memberDetailPath, issuerRegistryPath, publicProfilePath, recordDetailPath } from './routes';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('route path helpers', () => {
  it('verifyPath builds correct path', () => {
    expect(verifyPath('ARK-2026-001')).toBe('/verify/ARK-2026-001');
  });

  it('recordDetailPath builds correct path', () => {
    expect(recordDetailPath('abc-123')).toBe('/records/abc-123');
  });

  it('memberDetailPath builds correct path', () => {
    expect(memberDetailPath('mem-456')).toBe('/organization/member/mem-456');
  });

  it('issuerRegistryPath builds correct path', () => {
    expect(issuerRegistryPath('org-789')).toBe('/issuer/org-789');
  });

  it('publicProfilePath builds correct path', () => {
    expect(publicProfilePath('prof-123')).toBe('/profile/prof-123');
  });
});

describe('getAppBaseUrl', () => {
  it('returns production URL when VITE_APP_URL is not set', () => {
    vi.stubEnv('VITE_APP_URL', '');
    const url = getAppBaseUrl();
    expect(url).toBe('https://app.arkova.ai');
  });

  it('returns configured URL when VITE_APP_URL is set', () => {
    vi.stubEnv('VITE_APP_URL', 'https://preview.arkova.ai');
    expect(getAppBaseUrl()).toBe('https://preview.arkova.ai');
  });

  it('strips trailing slash from VITE_APP_URL', () => {
    vi.stubEnv('VITE_APP_URL', 'https://app.arkova.ai/');
    expect(getAppBaseUrl()).toBe('https://app.arkova.ai');
  });
});

describe('verifyUrl', () => {
  it('builds full verification URL with configured domain', () => {
    vi.stubEnv('VITE_APP_URL', 'https://app.arkova.ai');
    const url = verifyUrl('ARK-2026-001');
    expect(url).toBe('https://app.arkova.ai/verify/ARK-2026-001');
  });

  it('never contains localhost', () => {
    vi.stubEnv('VITE_APP_URL', '');
    const url = verifyUrl('TEST-123');
    expect(url).not.toContain('localhost');
  });

  it('does not produce double slashes with trailing-slash base URL', () => {
    vi.stubEnv('VITE_APP_URL', 'https://app.arkova.ai/');
    const url = verifyUrl('ARK-2026-001');
    expect(url).toBe('https://app.arkova.ai/verify/ARK-2026-001');
    expect(url).not.toContain('//verify');
  });
});

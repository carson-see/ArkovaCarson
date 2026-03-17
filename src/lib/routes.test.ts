/**
 * Tests for route utility functions
 *
 * @see UAT3-04 — verifyUrl uses production base URL
 */

import { describe, it, expect } from 'vitest';
import { verifyPath, verifyUrl, getAppBaseUrl, memberDetailPath, issuerRegistryPath, recordDetailPath } from './routes';

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
});

describe('getAppBaseUrl', () => {
  it('returns production URL when VITE_APP_URL is not set', () => {
    const url = getAppBaseUrl();
    // Falls back to production domain
    expect(url).toBe('https://app.arkova.ai');
  });
});

describe('verifyUrl', () => {
  it('builds full verification URL with production domain', () => {
    const url = verifyUrl('ARK-2026-001');
    expect(url).toBe('https://app.arkova.ai/verify/ARK-2026-001');
  });

  it('never contains localhost', () => {
    const url = verifyUrl('TEST-123');
    expect(url).not.toContain('localhost');
  });
});

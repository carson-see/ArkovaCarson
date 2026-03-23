/**
 * Platform Admin Utility Tests (DB-AUDIT SEC-3)
 *
 * Tests that isPlatformAdmin checks is_platform_admin DB flag
 * with fallback to hardcoded email list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db — factory cannot reference outer variables (hoisted)
vi.mock('./db.js', () => ({
  db: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: null, error: null }),
        })),
      })),
    })),
  },
}));

// Import after mock setup
import { db } from './db.js';
import { isPlatformAdmin } from './platformAdmin.js';

function setupMock(data: Record<string, unknown> | null) {
  const mockSingle = vi.fn().mockResolvedValue({ data, error: null });
  const mockEq = vi.fn(() => ({ single: mockSingle }));
  const mockSelect = vi.fn(() => ({ eq: mockEq }));
  vi.mocked(db.from).mockReturnValue({ select: mockSelect } as never);
}

describe('isPlatformAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when is_platform_admin flag is true', async () => {
    setupMock({ email: 'carson@arkova.ai', is_platform_admin: true });
    expect(await isPlatformAdmin('user-1')).toBe(true);
  });

  it('returns false when is_platform_admin flag is false', async () => {
    setupMock({ email: 'regular@example.com', is_platform_admin: false });
    expect(await isPlatformAdmin('user-2')).toBe(false);
  });

  it('falls back to email whitelist when flag is null (pre-migration)', async () => {
    setupMock({ email: 'carson@arkova.ai', is_platform_admin: null });
    expect(await isPlatformAdmin('user-1')).toBe(true);
  });

  it('falls back to email whitelist when flag is undefined (pre-migration)', async () => {
    setupMock({ email: 'sarah@arkova.ai', is_platform_admin: undefined });
    expect(await isPlatformAdmin('user-2')).toBe(true);
  });

  it('returns false for non-admin email when flag is null', async () => {
    setupMock({ email: 'attacker@evil.com', is_platform_admin: null });
    expect(await isPlatformAdmin('user-3')).toBe(false);
  });

  it('returns false when profile not found', async () => {
    setupMock(null);
    expect(await isPlatformAdmin('missing')).toBe(false);
  });

  it('returns false when email is null', async () => {
    setupMock({ email: null, is_platform_admin: false });
    expect(await isPlatformAdmin('user-4')).toBe(false);
  });

  it('queries profiles table with is_platform_admin column', async () => {
    setupMock({ email: 'test@test.com', is_platform_admin: false });
    await isPlatformAdmin('user-id-123');
    expect(db.from).toHaveBeenCalledWith('profiles');
  });
});

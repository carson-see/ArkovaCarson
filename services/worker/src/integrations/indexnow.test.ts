/**
 * IndexNow Integration Tests (GEO-10)
 *
 * Tests the IndexNow protocol integration for Bing/Copilot.
 * Mocks logger to avoid pino dependency in unit tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the logger module before importing indexnow
vi.mock('../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Set env before import
process.env.INDEXNOW_KEY = 'test-indexnow-key-123';
process.env.FRONTEND_URL = 'https://app.arkova.io';

// Import after mocks are set up
const { submitToIndexNow, buildCredentialUrls, buildIssuerUrl } = await import('./indexnow.js');

describe('IndexNow Integration', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  describe('submitToIndexNow', () => {
    it('sends POST to both IndexNow endpoints', async () => {
      await submitToIndexNow(['https://app.arkova.io/verify/abc123']);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.indexnow.org/indexnow',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        'https://www.bing.com/indexnow',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('includes correct body structure', async () => {
      await submitToIndexNow(['https://app.arkova.io/verify/abc123']);

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.host).toBe('app.arkova.io');
      expect(body.key).toBe('test-indexnow-key-123');
      expect(body.keyLocation).toBe('https://app.arkova.io/test-indexnow-key-123.txt');
      expect(body.urlList).toEqual(['https://app.arkova.io/verify/abc123']);
    });

    it('skips when no URLs provided', async () => {
      await submitToIndexNow([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('truncates to 10000 URLs max', async () => {
      const urls = Array.from({ length: 15000 }, (_, i) => `https://app.arkova.io/verify/${i}`);
      await submitToIndexNow(urls);

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.urlList).toHaveLength(10000);
    });

    it('handles fetch failures gracefully (non-critical)', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      await expect(submitToIndexNow(['https://app.arkova.io/verify/abc'])).resolves.toBeUndefined();
    });

    it('handles non-OK responses gracefully', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 429 });
      await expect(submitToIndexNow(['https://app.arkova.io/verify/abc'])).resolves.toBeUndefined();
    });
  });

  describe('buildCredentialUrls', () => {
    it('builds verification URLs from public IDs', () => {
      const urls = buildCredentialUrls(['abc123', 'def456']);
      expect(urls).toEqual([
        'https://app.arkova.io/verify/abc123',
        'https://app.arkova.io/verify/def456',
      ]);
    });

    it('returns empty array for empty input', () => {
      expect(buildCredentialUrls([])).toEqual([]);
    });
  });

  describe('buildIssuerUrl', () => {
    it('builds issuer profile URL', () => {
      expect(buildIssuerUrl('org-xyz')).toBe('https://app.arkova.io/issuer/org-xyz');
    });
  });
});

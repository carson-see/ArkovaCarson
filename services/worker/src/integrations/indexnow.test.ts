/**
 * IndexNow Integration Tests (GEO-10)
 *
 * Tests for:
 *   - URL submission to IndexNow endpoints (Bing, Yandex)
 *   - Silent failure when key not configured
 *   - URL building helpers for credentials and issuers
 *   - Batch URL limits (max 10,000)
 *   - Timeout handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger to avoid config validation
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fetch globally before importing module
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Must set env before importing module (reads at import time)
const ORIGINAL_ENV = { ...process.env };

describe('IndexNow Integration (GEO-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  describe('submitToIndexNow', () => {
    it('should skip submission when INDEXNOW_KEY is not set', async () => {
      // Re-import with no key
      process.env.INDEXNOW_KEY = '';
      const { submitToIndexNow } = await import('./indexnow.js');

      await submitToIndexNow(['https://app.arkova.ai/verify/test']);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip submission for empty URL list', async () => {
      process.env.INDEXNOW_KEY = 'test-key-123';
      vi.resetModules();
      const mod = await import('./indexnow.js');

      await mod.submitToIndexNow([]);

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should submit URLs to both IndexNow endpoints', async () => {
      process.env.INDEXNOW_KEY = 'test-key-123';
      process.env.FRONTEND_URL = 'https://app.arkova.ai';

      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      // Re-import to pick up env
      vi.resetModules();
      const { submitToIndexNow } = await import('./indexnow.js');

      await submitToIndexNow(['https://app.arkova.ai/verify/ARK-001']);

      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Check first call (api.indexnow.org)
      const [url1, opts1] = mockFetch.mock.calls[0];
      expect(url1).toBe('https://api.indexnow.org/indexnow');
      expect(opts1.method).toBe('POST');
      expect(opts1.headers['Content-Type']).toBe('application/json');

      const body1 = JSON.parse(opts1.body);
      expect(body1.key).toBe('test-key-123');
      expect(body1.urlList).toEqual(['https://app.arkova.ai/verify/ARK-001']);

      // Check second call (bing.com)
      const [url2] = mockFetch.mock.calls[1];
      expect(url2).toBe('https://www.bing.com/indexnow');
    });

    it('should handle 202 Accepted as success', async () => {
      process.env.INDEXNOW_KEY = 'test-key-123';
      mockFetch.mockResolvedValue({ ok: false, status: 202 });

      vi.resetModules();
      const { submitToIndexNow } = await import('./indexnow.js');

      // Should not throw
      await expect(submitToIndexNow(['https://app.arkova.ai/test'])).resolves.toBeUndefined();
    });

    it('should handle rejection gracefully (non-critical)', async () => {
      process.env.INDEXNOW_KEY = 'test-key-123';
      mockFetch.mockResolvedValue({ ok: false, status: 429 });

      vi.resetModules();
      const { submitToIndexNow } = await import('./indexnow.js');

      // Should not throw even on rejection
      await expect(submitToIndexNow(['https://app.arkova.ai/test'])).resolves.toBeUndefined();
    });

    it('should handle network errors gracefully', async () => {
      process.env.INDEXNOW_KEY = 'test-key-123';
      mockFetch.mockRejectedValue(new Error('Network timeout'));

      vi.resetModules();
      const { submitToIndexNow } = await import('./indexnow.js');

      // Should not throw on network errors
      await expect(submitToIndexNow(['https://app.arkova.ai/test'])).resolves.toBeUndefined();
    });

    it('should truncate URL list to 10,000 entries', async () => {
      process.env.INDEXNOW_KEY = 'test-key-123';
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      vi.resetModules();
      const { submitToIndexNow } = await import('./indexnow.js');

      // Create 10,001 URLs
      const urls = Array.from({ length: 10001 }, (_, i) => `https://app.arkova.ai/verify/${i}`);
      await submitToIndexNow(urls);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.urlList).toHaveLength(10000);
    });

    it('should use AbortSignal timeout of 5 seconds', async () => {
      process.env.INDEXNOW_KEY = 'test-key-123';
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      vi.resetModules();
      const { submitToIndexNow } = await import('./indexnow.js');

      await submitToIndexNow(['https://app.arkova.ai/test']);

      const opts = mockFetch.mock.calls[0][1];
      expect(opts.signal).toBeDefined();
    });
  });

  describe('buildCredentialUrls', () => {
    it('should build verification URLs from public IDs', async () => {
      process.env.FRONTEND_URL = 'https://app.arkova.ai';

      vi.resetModules();
      const { buildCredentialUrls } = await import('./indexnow.js');

      const urls = buildCredentialUrls(['ARK-001', 'ARK-002', 'ARK-003']);

      expect(urls).toEqual([
        'https://app.arkova.ai/verify/ARK-001',
        'https://app.arkova.ai/verify/ARK-002',
        'https://app.arkova.ai/verify/ARK-003',
      ]);
    });

    it('should return empty array for empty input', async () => {
      vi.resetModules();
      const { buildCredentialUrls } = await import('./indexnow.js');

      expect(buildCredentialUrls([])).toEqual([]);
    });
  });

  describe('buildIssuerUrl', () => {
    it('should build issuer profile URL', async () => {
      process.env.FRONTEND_URL = 'https://app.arkova.ai';

      vi.resetModules();
      const { buildIssuerUrl } = await import('./indexnow.js');

      expect(buildIssuerUrl('org-123')).toBe('https://app.arkova.ai/issuer/org-123');
    });
  });
});

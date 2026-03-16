/**
 * Tests for SSRF protection in webhook delivery (INJ-02)
 *
 * Verifies that private/internal URLs are blocked before fetch().
 */

import { describe, it, expect, vi } from 'vitest';

// ---- Hoisted mocks (delivery.ts transitively imports config/db) ----
const { mockLogger, mockDbFrom, mockRpc } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockRpc: vi.fn(),
  mockDbFrom: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({ logger: mockLogger }));
vi.mock('../utils/db.js', () => ({ db: { from: mockDbFrom, rpc: mockRpc } }));

import { isPrivateUrl } from './delivery.js';

describe('isPrivateUrl (INJ-02 SSRF protection)', () => {
  describe('blocks RFC 1918 private ranges', () => {
    it('blocks 10.x.x.x', () => {
      expect(isPrivateUrl('http://10.0.0.1:8080/webhook')).toBe(true);
      expect(isPrivateUrl('http://10.255.255.255/hook')).toBe(true);
    });

    it('blocks 172.16-31.x.x', () => {
      expect(isPrivateUrl('http://172.16.0.1/webhook')).toBe(true);
      expect(isPrivateUrl('http://172.31.255.255/hook')).toBe(true);
    });

    it('blocks 192.168.x.x', () => {
      expect(isPrivateUrl('http://192.168.1.1/webhook')).toBe(true);
      expect(isPrivateUrl('http://192.168.0.100:3000')).toBe(true);
    });
  });

  describe('blocks loopback', () => {
    it('blocks 127.0.0.1', () => {
      expect(isPrivateUrl('http://127.0.0.1:8080')).toBe(true);
    });

    it('blocks localhost hostname', () => {
      expect(isPrivateUrl('http://localhost:3000/webhook')).toBe(true);
      expect(isPrivateUrl('https://localhost/hook')).toBe(true);
    });
  });

  describe('blocks cloud metadata endpoints', () => {
    it('blocks AWS/Azure metadata IP (169.254.169.254)', () => {
      expect(isPrivateUrl('http://169.254.169.254/latest/meta-data/')).toBe(true);
      expect(isPrivateUrl('http://169.254.169.254/latest/meta-data/iam/security-credentials/')).toBe(true);
    });

    it('blocks GCP metadata hostname', () => {
      expect(isPrivateUrl('http://metadata.google.internal/computeMetadata/v1/')).toBe(true);
    });

    it('blocks link-local range', () => {
      expect(isPrivateUrl('http://169.254.1.1/hook')).toBe(true);
    });
  });

  describe('blocks non-HTTP schemes', () => {
    it('blocks file:// scheme', () => {
      expect(isPrivateUrl('file:///etc/passwd')).toBe(true);
    });

    it('blocks ftp:// scheme', () => {
      expect(isPrivateUrl('ftp://internal.server/data')).toBe(true);
    });
  });

  describe('blocks malformed URLs', () => {
    it('blocks empty string', () => {
      expect(isPrivateUrl('')).toBe(true);
    });

    it('blocks non-URL string', () => {
      expect(isPrivateUrl('not-a-url')).toBe(true);
    });
  });

  describe('allows legitimate public URLs', () => {
    it('allows standard HTTPS webhook URLs', () => {
      expect(isPrivateUrl('https://hooks.slack.com/services/T00/B00/xxx')).toBe(false);
      expect(isPrivateUrl('https://api.example.com/webhooks/arkova')).toBe(false);
    });

    it('allows HTTP public URLs', () => {
      expect(isPrivateUrl('http://webhook.example.com/callback')).toBe(false);
    });

    it('allows public IP addresses', () => {
      expect(isPrivateUrl('https://203.0.113.50:443/webhook')).toBe(false);
      expect(isPrivateUrl('https://8.8.8.8/hook')).toBe(false);
    });
  });

  describe('blocks 0.0.0.0 and CGNAT ranges', () => {
    it('blocks 0.0.0.0', () => {
      expect(isPrivateUrl('http://0.0.0.0:8080')).toBe(true);
    });

    it('blocks CGNAT range (100.64.0.0/10)', () => {
      expect(isPrivateUrl('http://100.64.0.1/hook')).toBe(true);
      expect(isPrivateUrl('http://100.127.255.255/hook')).toBe(true);
    });
  });
});

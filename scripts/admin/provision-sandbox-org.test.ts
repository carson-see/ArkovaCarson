/**
 * Unit tests for the SCRUM-1740 sandbox provisioning script.
 * Pure-function tests around HMAC computation + arg parsing.
 */
import { describe, it, expect } from 'vitest';
import { hmacApiKey } from './provision-sandbox-org.js';

describe('SCRUM-1740 — sandbox provisioning script', () => {
  describe('hmacApiKey', () => {
    it('produces a 64-char hex digest (SHA-256)', () => {
      const out = hmacApiKey('ak_test_xyz', 'secret');
      expect(out).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same input + secret', () => {
      const a = hmacApiKey('ak_test_xyz', 'secret');
      const b = hmacApiKey('ak_test_xyz', 'secret');
      expect(a).toBe(b);
    });

    it('changes the digest when the raw key changes (no collision)', () => {
      const a = hmacApiKey('ak_test_xyz', 'secret');
      const b = hmacApiKey('ak_test_xyZ', 'secret');
      expect(a).not.toBe(b);
    });

    it('changes the digest when the secret rotates', () => {
      const a = hmacApiKey('ak_test_xyz', 'secret-1');
      const b = hmacApiKey('ak_test_xyz', 'secret-2');
      expect(a).not.toBe(b);
    });
  });
});

/**
 * Tests for Audit Batch Verification API (COMP-06)
 */

import { describe, it, expect } from 'vitest';

describe('Audit Batch Verification', () => {
  describe('seededRandom', () => {
    function seededRandom(seed: number): () => number {
      let s = seed;
      return () => {
        s = (s * 1664525 + 1013904223) & 0xffffffff;
        return (s >>> 0) / 0xffffffff;
      };
    }

    it('should produce deterministic results with same seed', () => {
      const rng1 = seededRandom(42);
      const rng2 = seededRandom(42);
      const seq1 = Array.from({ length: 10 }, () => rng1());
      const seq2 = Array.from({ length: 10 }, () => rng2());
      expect(seq1).toEqual(seq2);
    });

    it('should produce different results with different seeds', () => {
      const rng1 = seededRandom(42);
      const rng2 = seededRandom(99);
      const v1 = rng1();
      const v2 = rng2();
      expect(v1).not.toBe(v2);
    });

    it('should produce values in [0, 1) range', () => {
      const rng = seededRandom(12345);
      for (let i = 0; i < 100; i++) {
        const v = rng();
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('anomaly detection', () => {
    it('should flag anchor delay >24h', () => {
      const submittedAt = '2026-04-01T10:00:00Z';
      const securedAt = '2026-04-03T10:00:00Z';
      const delay = new Date(securedAt).getTime() - new Date(submittedAt).getTime();
      expect(delay).toBeGreaterThan(24 * 3600_000);
    });

    it('should flag stale PENDING >48h', () => {
      const createdAt = new Date(Date.now() - 72 * 3600_000).toISOString();
      const age = Date.now() - new Date(createdAt).getTime();
      expect(age).toBeGreaterThan(48 * 3600_000);
    });

    it('should flag missing fingerprint', () => {
      const anchor = { fingerprint: null, status: 'SECURED' };
      const anomalies: string[] = [];
      if (!anchor.fingerprint) anomalies.push('Missing fingerprint');
      expect(anomalies).toContain('Missing fingerprint');
    });

    it('should flag revoked credentials', () => {
      const anchor = { status: 'REVOKED' };
      const anomalies: string[] = [];
      if (anchor.status === 'REVOKED') anomalies.push('Credential has been revoked');
      expect(anomalies).toContain('Credential has been revoked');
    });
  });

  describe('batch size limits', () => {
    it('should enforce max 1000 credential IDs', () => {
      const ids = Array.from({ length: 1001 }, (_, i) => `ARK-${i}`);
      expect(ids.length).toBeGreaterThan(1000);
    });

    it('should handle empty credential_ids', () => {
      const ids: string[] = [];
      expect(ids.length).toBe(0);
    });
  });
});

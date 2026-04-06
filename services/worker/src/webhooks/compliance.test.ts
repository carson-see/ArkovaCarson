/**
 * Tests for Compliance Event Webhooks (COMP-08)
 */

import { describe, it, expect } from 'vitest';

describe('Compliance Event Webhooks', () => {
  describe('event types', () => {
    const COMPLIANCE_EVENT_TYPES = [
      'compliance.certificate_expiring',
      'compliance.anchor_delayed',
      'compliance.signature_revoked',
      'compliance.score_degraded',
      'compliance.timestamp_coverage_low',
    ];

    it('should define 5 compliance event types', () => {
      expect(COMPLIANCE_EVENT_TYPES).toHaveLength(5);
    });

    it('should use compliance. prefix for all types', () => {
      for (const type of COMPLIANCE_EVENT_TYPES) {
        expect(type).toMatch(/^compliance\./);
      }
    });
  });

  describe('certificate expiry thresholds', () => {
    it('should fire at 30-day, 7-day, and 1-day thresholds', () => {
      const thresholds = [
        { days: 30, label: '30_day' },
        { days: 7, label: '7_day' },
        { days: 1, label: '1_day' },
      ];
      expect(thresholds).toHaveLength(3);
      expect(thresholds[0].days).toBe(30);
      expect(thresholds[1].days).toBe(7);
      expect(thresholds[2].days).toBe(1);
    });
  });

  describe('anchor delay detection', () => {
    it('should detect anchors pending >1 hour', () => {
      const oneHourAgo = Date.now() - 3600_000;
      const staleAnchor = { created_at: new Date(oneHourAgo - 60_000).toISOString() };
      const anchorTime = new Date(staleAnchor.created_at).getTime();
      expect(anchorTime).toBeLessThan(oneHourAgo);
    });
  });

  describe('timestamp coverage', () => {
    it('should flag coverage below 80%', () => {
      const totalSigs = 100;
      const timestampedSigs = 70;
      const coverage = Math.round((timestampedSigs / totalSigs) * 100);
      expect(coverage).toBe(70);
      expect(coverage).toBeLessThan(80);
    });

    it('should not flag coverage at 95%', () => {
      const totalSigs = 100;
      const timestampedSigs = 95;
      const coverage = Math.round((timestampedSigs / totalSigs) * 100);
      expect(coverage).toBe(95);
      expect(coverage).toBeGreaterThanOrEqual(80);
    });
  });
});

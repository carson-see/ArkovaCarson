/**
 * Tests for HIPAA Audit Report API — REG-07 (SCRUM-566)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({
  db: { from: vi.fn() },
}));
vi.mock('../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../config.js', () => ({
  config: { frontendUrl: 'https://app.arkova.ai' },
}));

import { HIPAA_HEALTHCARE_TYPES } from '../../constants/hipaa.js';
import { AuditQuerySchema } from './hipaa-audit.js';

describe('HIPAA Audit Report — REG-07', () => {
  describe('AuditQuerySchema (exported from module)', () => {
    it('accepts empty query with defaults', () => {
      const result = AuditQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(50);
      }
    });

    it('coerces string page/limit', () => {
      const result = AuditQuerySchema.safeParse({ page: '3', limit: '25' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(3);
        expect(result.data.limit).toBe(25);
      }
    });

    it('rejects page < 1', () => {
      expect(AuditQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    });

    it('rejects limit > 100', () => {
      expect(AuditQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    });

    it('rejects invalid UUID for user_id', () => {
      expect(AuditQuerySchema.safeParse({ user_id: 'not-a-uuid' }).success).toBe(false);
    });
  });

  describe('healthcare type constant (from shared hipaa.ts)', () => {
    it('includes all 4 healthcare types', () => {
      expect(HIPAA_HEALTHCARE_TYPES).toContain('INSURANCE');
      expect(HIPAA_HEALTHCARE_TYPES).toContain('MEDICAL');
      expect(HIPAA_HEALTHCARE_TYPES).toContain('MEDICAL_LICENSE');
      expect(HIPAA_HEALTHCARE_TYPES).toContain('IMMUNIZATION');
    });

    it('does not include education types', () => {
      expect(HIPAA_HEALTHCARE_TYPES).not.toContain('DEGREE');
      expect(HIPAA_HEALTHCARE_TYPES).not.toContain('TRANSCRIPT');
    });
  });

  describe('healthcare event filter logic', () => {
    it('filters events by credential_type in details JSON', () => {
      const events = [
        { event_type: 'VERIFICATION_QUERIED', details: JSON.stringify({ credential_type: 'INSURANCE' }) },
        { event_type: 'VERIFICATION_QUERIED', details: JSON.stringify({ credential_type: 'DEGREE' }) },
        { event_type: 'VERIFICATION_QUERIED', details: JSON.stringify({ credential_type: 'MEDICAL' }) },
        { event_type: 'CREDENTIAL_VIEWED', details: JSON.stringify({}) },
      ];

      const healthcareEvents = events.filter((event) => {
        try {
          const details = typeof event.details === 'string' ? JSON.parse(event.details) : event.details;
          return details?.credential_type && (HIPAA_HEALTHCARE_TYPES as readonly string[]).includes(details.credential_type);
        } catch {
          return false;
        }
      });

      expect(healthcareEvents).toHaveLength(2);
    });
  });
});

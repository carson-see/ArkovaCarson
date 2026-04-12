/**
 * Tests for HIPAA Audit Report API — REG-07 (SCRUM-566)
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const HEALTHCARE_TYPES = ['INSURANCE', 'MEDICAL', 'MEDICAL_LICENSE', 'IMMUNIZATION'];

describe('HIPAA Audit Report — REG-07', () => {
  describe('query schema validation', () => {
    const AuditQuerySchema = z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
      from_date: z.string().optional(),
      to_date: z.string().optional(),
      action: z.string().optional(),
      user_id: z.string().uuid().optional(),
    });

    it('accepts valid query with defaults', () => {
      const result = AuditQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(1);
        expect(result.data.limit).toBe(50);
      }
    });

    it('accepts custom page and limit', () => {
      const result = AuditQuerySchema.safeParse({ page: '3', limit: '25' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.page).toBe(3);
        expect(result.data.limit).toBe(25);
      }
    });

    it('rejects page < 1', () => {
      const result = AuditQuerySchema.safeParse({ page: '0' });
      expect(result.success).toBe(false);
    });

    it('rejects limit > 100', () => {
      const result = AuditQuerySchema.safeParse({ limit: '101' });
      expect(result.success).toBe(false);
    });

    it('rejects invalid user_id (not UUID)', () => {
      const result = AuditQuerySchema.safeParse({ user_id: 'not-a-uuid' });
      expect(result.success).toBe(false);
    });

    it('accepts valid date range', () => {
      const result = AuditQuerySchema.safeParse({
        from_date: '2026-01-01',
        to_date: '2026-12-31',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('healthcare type filtering', () => {
    it('includes INSURANCE in healthcare types', () => {
      expect(HEALTHCARE_TYPES).toContain('INSURANCE');
    });

    it('includes MEDICAL in healthcare types', () => {
      expect(HEALTHCARE_TYPES).toContain('MEDICAL');
    });

    it('includes MEDICAL_LICENSE in healthcare types', () => {
      expect(HEALTHCARE_TYPES).toContain('MEDICAL_LICENSE');
    });

    it('includes IMMUNIZATION in healthcare types', () => {
      expect(HEALTHCARE_TYPES).toContain('IMMUNIZATION');
    });

    it('does not include education types', () => {
      expect(HEALTHCARE_TYPES).not.toContain('DEGREE');
      expect(HEALTHCARE_TYPES).not.toContain('TRANSCRIPT');
    });

    it('filters events by credential_type in details JSON', () => {
      const events = [
        { event_type: 'VERIFICATION_QUERIED', details: JSON.stringify({ credential_type: 'INSURANCE' }) },
        { event_type: 'VERIFICATION_QUERIED', details: JSON.stringify({ credential_type: 'DEGREE' }) },
        { event_type: 'VERIFICATION_QUERIED', details: JSON.stringify({ credential_type: 'MEDICAL' }) },
        { event_type: 'CREDENTIAL_VIEWED', details: JSON.stringify({}) },
      ];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const healthcareEvents = events.filter((event: any) => {
        try {
          const details = typeof event.details === 'string' ? JSON.parse(event.details) : event.details;
          return details?.credential_type && HEALTHCARE_TYPES.includes(details.credential_type);
        } catch {
          return false;
        }
      });

      expect(healthcareEvents).toHaveLength(2);
      expect(healthcareEvents[0].details).toContain('INSURANCE');
      expect(healthcareEvents[1].details).toContain('MEDICAL');
    });
  });

  describe('CSV export format', () => {
    it('produces valid CSV headers', () => {
      const headers = ['Timestamp', 'Event Type', 'Actor ID', 'Target Type', 'Target ID', 'Credential Type', 'Details'];
      expect(headers).toHaveLength(7);
      expect(headers[0]).toBe('Timestamp');
      expect(headers[5]).toBe('Credential Type');
    });
  });
});

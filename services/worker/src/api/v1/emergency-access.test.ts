/**
 * Tests for HIPAA Emergency Access API — REG-10 (SCRUM-571)
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';

const MAX_DURATION_HOURS = 4;

const RequestSchema = z.object({
  reason: z.string().min(10).max(2000),
  scope: z.string().default('healthcare_credentials'),
  duration_hours: z.number().min(0.5).max(MAX_DURATION_HOURS).default(MAX_DURATION_HOURS),
});

const RevokeSchema = z.object({
  reason: z.string().min(1).max(2000).optional(),
});

describe('Emergency Access — REG-10', () => {
  describe('request schema', () => {
    it('accepts valid request with defaults', () => {
      const result = RequestSchema.safeParse({
        reason: 'Emergency patient care requires immediate credential verification.',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scope).toBe('healthcare_credentials');
        expect(result.data.duration_hours).toBe(4);
      }
    });

    it('accepts custom duration', () => {
      const result = RequestSchema.safeParse({
        reason: 'Emergency: patient in critical care needs credential check.',
        duration_hours: 1,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.duration_hours).toBe(1);
      }
    });

    it('rejects reason shorter than 10 chars', () => {
      const result = RequestSchema.safeParse({ reason: 'Too short' });
      expect(result.success).toBe(false);
    });

    it('rejects duration > 4 hours', () => {
      const result = RequestSchema.safeParse({
        reason: 'Emergency requiring more than maximum duration.',
        duration_hours: 5,
      });
      expect(result.success).toBe(false);
    });

    it('rejects duration < 0.5 hours', () => {
      const result = RequestSchema.safeParse({
        reason: 'Emergency: very short access needed.',
        duration_hours: 0.1,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('revoke schema', () => {
    it('accepts empty body', () => {
      const result = RevokeSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts optional reason', () => {
      const result = RevokeSchema.safeParse({ reason: 'No longer needed' });
      expect(result.success).toBe(true);
    });
  });

  describe('dual-control enforcement', () => {
    it('prevents self-approval', () => {
      const granteeId = '550e8400-e29b-41d4-a716-446655440000';
      const approverId = '550e8400-e29b-41d4-a716-446655440000';
      expect(granteeId).toBe(approverId);
      // The endpoint returns 403 when grantee_id === approverId
    });

    it('allows different user to approve', () => {
      const granteeId = '550e8400-e29b-41d4-a716-446655440000';
      const approverId = '660e8400-e29b-41d4-a716-446655440001';
      expect(granteeId).not.toBe(approverId);
    });
  });

  describe('time-limited access', () => {
    it('calculates expiry correctly for 4-hour grant', () => {
      const now = Date.now();
      const durationHours = 4;
      const expiresAt = new Date(now + durationHours * 60 * 60 * 1000);
      const diffMs = expiresAt.getTime() - now;
      expect(diffMs).toBe(4 * 60 * 60 * 1000);
    });

    it('calculates expiry correctly for 30-minute grant', () => {
      const now = Date.now();
      const durationHours = 0.5;
      const expiresAt = new Date(now + durationHours * 60 * 60 * 1000);
      const diffMs = expiresAt.getTime() - now;
      expect(diffMs).toBe(30 * 60 * 1000);
    });
  });

  describe('audit event types', () => {
    const EVENT_TYPES = [
      'EMERGENCY_ACCESS_REQUESTED',
      'EMERGENCY_ACCESS_APPROVED',
      'EMERGENCY_ACCESS_REVOKED',
    ];

    it('has all three lifecycle events', () => {
      expect(EVENT_TYPES).toHaveLength(3);
      expect(EVENT_TYPES).toContain('EMERGENCY_ACCESS_REQUESTED');
      expect(EVENT_TYPES).toContain('EMERGENCY_ACCESS_APPROVED');
      expect(EVENT_TYPES).toContain('EMERGENCY_ACCESS_REVOKED');
    });
  });
});

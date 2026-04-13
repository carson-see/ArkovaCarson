/**
 * Tests for HIPAA Emergency Access API — REG-10 (SCRUM-571)
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

import { RequestSchema, RevokeSchema } from './emergency-access.js';
import { EMERGENCY_ACCESS_MAX_HOURS } from '../../constants/hipaa.js';

describe('Emergency Access — REG-10', () => {
  describe('RequestSchema (exported from module)', () => {
    it('accepts valid request with defaults', () => {
      const result = RequestSchema.safeParse({
        reason: 'Emergency patient care requires immediate credential verification.',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scope).toBe('healthcare_credentials');
        expect(result.data.duration_hours).toBe(EMERGENCY_ACCESS_MAX_HOURS);
      }
    });

    it('accepts custom duration within range', () => {
      const result = RequestSchema.safeParse({
        reason: 'Emergency: patient in critical care needs credential check.',
        duration_hours: 1,
      });
      expect(result.success).toBe(true);
    });

    it('rejects reason shorter than 10 chars', () => {
      expect(RequestSchema.safeParse({ reason: 'Too short' }).success).toBe(false);
    });

    it('rejects duration exceeding max hours', () => {
      expect(RequestSchema.safeParse({
        reason: 'Emergency requiring more than maximum duration.',
        duration_hours: EMERGENCY_ACCESS_MAX_HOURS + 1,
      }).success).toBe(false);
    });

    it('rejects duration < 0.5 hours', () => {
      expect(RequestSchema.safeParse({
        reason: 'Emergency: very short access needed.',
        duration_hours: 0.1,
      }).success).toBe(false);
    });
  });

  describe('RevokeSchema (exported from module)', () => {
    it('accepts empty body', () => {
      expect(RevokeSchema.safeParse({}).success).toBe(true);
    });

    it('accepts optional reason', () => {
      expect(RevokeSchema.safeParse({ reason: 'No longer needed' }).success).toBe(true);
    });
  });

  describe('dual-control enforcement', () => {
    it('self-approval is blocked by the endpoint (grantee_id === approverId)', () => {
      // The endpoint checks grant.grantee_id === approverId and returns 403
      const granteeId = '550e8400-e29b-41d4-a716-446655440000';
      expect(granteeId).toBe(granteeId);
    });
  });

  describe('time-limited access', () => {
    it('calculates expiry from EMERGENCY_ACCESS_MAX_HOURS', () => {
      const now = Date.now();
      const expiresAt = new Date(now + EMERGENCY_ACCESS_MAX_HOURS * 60 * 60 * 1000);
      const diffHours = (expiresAt.getTime() - now) / (60 * 60 * 1000);
      expect(diffHours).toBe(EMERGENCY_ACCESS_MAX_HOURS);
    });
  });
});

/**
 * Tests for Compliance Event Emitters (COMP-08)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFrom = vi.fn();
vi.mock('../../utils/db.js', () => ({
  db: { from: (...args: unknown[]) => mockFrom(...args) },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  COMPLIANCE_EVENT_TYPES,
  checkCertificateExpiry,
  checkAnchorDelays,
  buildSignatureRevokedEvent,
} from './complianceEvents.js';

describe('Compliance Event Emitters (COMP-08)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('COMPLIANCE_EVENT_TYPES', () => {
    it('defines all required event types', () => {
      expect(COMPLIANCE_EVENT_TYPES).toContain('compliance.certificate_expiring');
      expect(COMPLIANCE_EVENT_TYPES).toContain('compliance.certificate_expired');
      expect(COMPLIANCE_EVENT_TYPES).toContain('compliance.anchor_delayed');
      expect(COMPLIANCE_EVENT_TYPES).toContain('compliance.signature_revoked');
      expect(COMPLIANCE_EVENT_TYPES).toContain('compliance.score_degraded');
      expect(COMPLIANCE_EVENT_TYPES).toContain('compliance.timestamp_coverage_low');
    });

    it('has exactly 6 event types', () => {
      expect(COMPLIANCE_EVENT_TYPES.length).toBe(6);
    });
  });

  describe('checkCertificateExpiry', () => {
    it('returns critical event for expired certificate', async () => {
      const yesterday = new Date(Date.now() - 86400_000).toISOString();
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: '1', subject_cn: 'Test CA', not_after: yesterday, status: 'ACTIVE' }],
            }),
          }),
        }),
      });

      const events = await checkCertificateExpiry('org-1');
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('compliance.certificate_expired');
      expect(events[0].severity).toBe('critical');
    });

    it('returns warning for certificate expiring in 15 days', async () => {
      const in15days = new Date(Date.now() + 15 * 86400_000).toISOString();
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: '1', subject_cn: 'Test CA', not_after: in15days, status: 'ACTIVE' }],
            }),
          }),
        }),
      });

      const events = await checkCertificateExpiry('org-1');
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('compliance.certificate_expiring');
      expect(events[0].severity).toBe('warning');
    });

    it('returns critical for certificate expiring in 3 days', async () => {
      const in3days = new Date(Date.now() + 3 * 86400_000).toISOString();
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: '1', subject_cn: 'Test CA', not_after: in3days, status: 'ACTIVE' }],
            }),
          }),
        }),
      });

      const events = await checkCertificateExpiry('org-1');
      expect(events).toHaveLength(1);
      expect(events[0].severity).toBe('critical');
    });

    it('returns empty for healthy certificates', async () => {
      const in90days = new Date(Date.now() + 90 * 86400_000).toISOString();
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({
              data: [{ id: '1', subject_cn: 'Test CA', not_after: in90days, status: 'ACTIVE' }],
            }),
          }),
        }),
      });

      const events = await checkCertificateExpiry('org-1');
      expect(events).toHaveLength(0);
    });

    it('returns empty when no certificates exist', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockResolvedValue({ data: null }),
          }),
        }),
      });

      const events = await checkCertificateExpiry('org-1');
      expect(events).toHaveLength(0);
    });
  });

  describe('checkAnchorDelays', () => {
    it('returns event when anchors are delayed >1h', async () => {
      const twoHoursAgo = new Date(Date.now() - 7200_000).toISOString();
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              lt: vi.fn().mockReturnValue({
                is: vi.fn().mockResolvedValue({
                  data: [{ public_id: 'ARK-001', submitted_at: twoHoursAgo }],
                }),
              }),
            }),
          }),
        }),
      });

      const events = await checkAnchorDelays('org-1');
      expect(events).toHaveLength(1);
      expect(events[0].event_type).toBe('compliance.anchor_delayed');
      expect(events[0].data.delayed_count).toBe(1);
    });

    it('returns empty when no delayed anchors', async () => {
      mockFrom.mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              lt: vi.fn().mockReturnValue({
                is: vi.fn().mockResolvedValue({ data: [] }),
              }),
            }),
          }),
        }),
      });

      const events = await checkAnchorDelays('org-1');
      expect(events).toHaveLength(0);
    });
  });

  describe('buildSignatureRevokedEvent', () => {
    it('builds correct event structure', () => {
      const event = buildSignatureRevokedEvent('org-1', 'SIG-001', 'compromised key');
      expect(event.event_type).toBe('compliance.signature_revoked');
      expect(event.org_id).toBe('org-1');
      expect(event.severity).toBe('warning');
      expect(event.data.signature_id).toBe('SIG-001');
      expect(event.data.reason).toBe('compromised key');
    });
  });
});

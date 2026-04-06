/**
 * Tests for Credential Provenance Timeline (COMP-02)
 *
 * GET /api/v1/verify/:publicId/provenance
 * Returns an ordered array of lifecycle events for a credential.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../utils/db.js', () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { buildProvenanceTimeline, type ProvenanceEvent, type AnchorProvenanceData } from './provenance.js';

describe('Provenance Timeline (COMP-02)', () => {
  const baseAnchor: AnchorProvenanceData = {
    public_id: 'ARK-2026-TEST-001',
    fingerprint: 'abc123',
    status: 'SECURED',
    created_at: '2026-03-01T10:00:00Z',
    updated_at: '2026-03-01T10:15:00Z',
    chain_tx_id: 'deadbeef01',
    chain_block_height: 850000,
    chain_timestamp: '2026-03-01T10:12:00Z',
    revoked_at: null,
  };

  describe('buildProvenanceTimeline', () => {
    it('returns events in chronological order', () => {
      const events = buildProvenanceTimeline(baseAnchor, []);

      const timestamps = events.map(e => new Date(e.timestamp).getTime());
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
      }
    });

    it('includes upload event from anchor created_at', () => {
      const events = buildProvenanceTimeline(baseAnchor, []);

      const upload = events.find(e => e.event_type === 'credential_uploaded');
      expect(upload).toBeDefined();
      expect(upload!.timestamp).toBe('2026-03-01T10:00:00Z');
    });

    it('includes fingerprint computed event', () => {
      const events = buildProvenanceTimeline(baseAnchor, []);

      const fp = events.find(e => e.event_type === 'fingerprint_computed');
      expect(fp).toBeDefined();
    });

    it('includes network confirmation event when chain data exists', () => {
      const events = buildProvenanceTimeline(baseAnchor, []);

      const confirmed = events.find(e => e.event_type === 'network_confirmed');
      expect(confirmed).toBeDefined();
      expect(confirmed!.timestamp).toBe('2026-03-01T10:12:00Z');
      expect(confirmed!.evidence_reference).toBe('deadbeef01');
    });

    it('omits network confirmation when chain data is missing', () => {
      const pending = { ...baseAnchor, status: 'PENDING', chain_tx_id: null, chain_block_height: null, chain_timestamp: null };
      const events = buildProvenanceTimeline(pending, []);

      expect(events.find(e => e.event_type === 'network_confirmed')).toBeUndefined();
    });

    it('includes revocation event when revoked_at is present', () => {
      const revoked = { ...baseAnchor, status: 'REVOKED', revoked_at: '2026-03-02T08:00:00Z' };
      const events = buildProvenanceTimeline(revoked, []);

      const revEvent = events.find(e => e.event_type === 'credential_revoked');
      expect(revEvent).toBeDefined();
      expect(revEvent!.timestamp).toBe('2026-03-02T08:00:00Z');
    });

    it('includes verification query events from audit log', () => {
      const auditEvents = [
        {
          event_type: 'VERIFICATION_QUERIED',
          created_at: '2026-03-05T14:00:00Z',
          actor_id: null as string | null,
        },
        {
          event_type: 'VERIFICATION_QUERIED',
          created_at: '2026-03-06T09:30:00Z',
          actor_id: null as string | null,
        },
      ];

      const events = buildProvenanceTimeline(baseAnchor, auditEvents);

      const queries = events.filter(e => e.event_type === 'verification_queried');
      expect(queries).toHaveLength(2);
    });

    it('calculates time deltas between consecutive events', () => {
      const events = buildProvenanceTimeline(baseAnchor, []);

      // At least some events should have time_delta_seconds
      const withDelta = events.filter(e => e.time_delta_seconds !== undefined);
      expect(withDelta.length).toBeGreaterThan(0);
    });

    it('flags anomaly when anchor delay exceeds 24 hours', () => {
      const slowAnchor = {
        ...baseAnchor,
        chain_timestamp: '2026-03-03T10:00:00Z', // 2 days after created_at
      };
      const events = buildProvenanceTimeline(slowAnchor, []);

      const confirmed = events.find(e => e.event_type === 'network_confirmed');
      expect(confirmed!.anomaly).toBe(true);
    });

    it('does not flag anomaly for normal anchor delay', () => {
      const events = buildProvenanceTimeline(baseAnchor, []);

      const confirmed = events.find(e => e.event_type === 'network_confirmed');
      expect(confirmed!.anomaly).toBeUndefined();
    });

    it('anonymizes actor IDs', () => {
      const auditEvents = [
        {
          event_type: 'VERIFICATION_QUERIED',
          created_at: '2026-03-05T14:00:00Z',
          actor_id: 'user-uuid-should-not-appear',
        },
      ];

      const events = buildProvenanceTimeline(baseAnchor, auditEvents);

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain('user-uuid-should-not-appear');
    });
  });
});

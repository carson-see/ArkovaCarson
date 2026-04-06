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

import { buildProvenanceTimeline, type AnchorProvenanceData } from './provenance.js';

describe('Provenance Timeline (COMP-02)', () => {
  const baseAnchor: AnchorProvenanceData = {
    public_id: 'ARK-2026-TEST-001',
    fingerprint: 'abc123def456789012345678',
    status: 'SECURED',
    created_at: '2026-03-01T10:00:00Z',
    updated_at: '2026-03-01T10:15:00Z',
    chain_tx_id: 'deadbeef01',
    chain_block_height: 850000,
    chain_timestamp: '2026-03-01T10:12:00Z',
    submitted_at: '2026-03-01T10:01:00Z',
    secured_at: '2026-03-01T10:12:00Z',
    tx_id: 'deadbeef01',
    batch_id: 'batch-001',
    revoked_at: null,
    revocation_reason: null,
  };

  describe('buildProvenanceTimeline', () => {
    it('returns events in chronological order', () => {
      const events = buildProvenanceTimeline(baseAnchor, []);

      const timestamps = events.map(e => new Date(e.timestamp).getTime());
      for (let i = 1; i < timestamps.length; i++) {
        expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
      }
    });

    it('includes credential created event', () => {
      const events = buildProvenanceTimeline(baseAnchor, []);

      const created = events.find(e => e.event_type === 'credential_created');
      expect(created).toBeDefined();
      expect(created!.timestamp).toBe('2026-03-01T10:00:00Z');
    });

    it('includes anchor submitted event when submitted_at exists', () => {
      const events = buildProvenanceTimeline(baseAnchor, []);

      const submitted = events.find(e => e.event_type === 'anchor_submitted');
      expect(submitted).toBeDefined();
      expect(submitted!.evidence_ref).toBe('batch-001');
    });

    it('includes network confirmation event when secured_at exists', () => {
      const events = buildProvenanceTimeline(baseAnchor, []);

      const confirmed = events.find(e => e.event_type === 'network_confirmed');
      expect(confirmed).toBeDefined();
      expect(confirmed!.timestamp).toBe('2026-03-01T10:12:00Z');
      expect(confirmed!.evidence_ref).toBe('deadbeef01');
    });

    it('omits network confirmation when no chain data', () => {
      const pending = { ...baseAnchor, status: 'PENDING', secured_at: null, chain_timestamp: null, tx_id: null, chain_tx_id: null };
      const events = buildProvenanceTimeline(pending, []);

      expect(events.find(e => e.event_type === 'network_confirmed')).toBeUndefined();
    });

    it('includes revocation event when revoked_at is present', () => {
      const revoked = { ...baseAnchor, status: 'REVOKED', revoked_at: '2026-03-02T08:00:00Z', revocation_reason: 'expired certificate' };
      const events = buildProvenanceTimeline(revoked, []);

      const revEvent = events.find(e => e.event_type === 'credential_revoked');
      expect(revEvent).toBeDefined();
      expect(revEvent!.timestamp).toBe('2026-03-02T08:00:00Z');
      expect(revEvent!.detail).toContain('expired certificate');
    });

    it('includes verification query events from audit log', () => {
      const auditEvents = [
        { event_type: 'VERIFICATION_QUERIED', created_at: '2026-03-05T14:00:00Z', actor_id: null as string | null },
        { event_type: 'VERIFICATION_QUERIED', created_at: '2026-03-06T09:30:00Z', actor_id: null as string | null },
      ];

      const events = buildProvenanceTimeline(baseAnchor, auditEvents);

      const queries = events.filter(e => e.event_type === 'verification_query');
      expect(queries).toHaveLength(2);
    });

    it('anonymizes actor IDs', () => {
      const auditEvents = [
        { event_type: 'VERIFICATION_QUERIED', created_at: '2026-03-05T14:00:00Z', actor_id: 'user-uuid-should-not-appear' },
      ];

      const events = buildProvenanceTimeline(baseAnchor, auditEvents);

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain('user-uuid-should-not-appear');
    });

    it('handles anchor with only chain_timestamp (no secured_at)', () => {
      const legacyAnchor = { ...baseAnchor, secured_at: null };
      const events = buildProvenanceTimeline(legacyAnchor, []);

      const confirmed = events.find(e => e.event_type === 'network_confirmed');
      expect(confirmed).toBeDefined();
      expect(confirmed!.timestamp).toBe('2026-03-01T10:12:00Z');
    });
  });
});

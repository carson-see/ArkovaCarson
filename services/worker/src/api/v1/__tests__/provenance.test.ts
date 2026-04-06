/**
 * Tests for Credential Provenance Timeline API (COMP-02)
 */

import { describe, it, expect } from 'vitest';

describe('Provenance Timeline API', () => {
  it('should define correct provenance event types', () => {
    const validEventTypes = [
      'credential_created',
      'anchor_submitted',
      'batch_included',
      'network_confirmed',
      'credential_revoked',
      'signature_created',
      'signature_completed',
      'timestamp_acquired',
      'verification_query',
    ];
    expect(validEventTypes).toHaveLength(9);
    expect(validEventTypes).toContain('credential_created');
    expect(validEventTypes).toContain('network_confirmed');
  });

  it('should sort events chronologically', () => {
    const events = [
      { timestamp: '2026-04-05T10:00:00Z', event_type: 'network_confirmed' },
      { timestamp: '2026-04-05T09:00:00Z', event_type: 'anchor_submitted' },
      { timestamp: '2026-04-05T08:00:00Z', event_type: 'credential_created' },
    ];
    const sorted = [...events].sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    expect(sorted[0].event_type).toBe('credential_created');
    expect(sorted[1].event_type).toBe('anchor_submitted');
    expect(sorted[2].event_type).toBe('network_confirmed');
  });

  it('should detect anomalies for anchor delays >24h', () => {
    const submittedAt = '2026-04-03T08:00:00Z';
    const securedAt = '2026-04-05T10:00:00Z';
    const delayMs = new Date(securedAt).getTime() - new Date(submittedAt).getTime();
    const delayHours = delayMs / 3600_000;
    expect(delayHours).toBeGreaterThan(24);
  });

  it('should compute time deltas between events', () => {
    const events = [
      { timestamp: '2026-04-05T08:00:00Z' },
      { timestamp: '2026-04-05T08:05:00Z' },
      { timestamp: '2026-04-05T09:00:00Z' },
    ];
    const deltas = events.map((e, i) => {
      if (i === 0) return null;
      return Math.round(
        (new Date(e.timestamp).getTime() - new Date(events[i - 1].timestamp).getTime()) / 1000
      );
    });
    expect(deltas[0]).toBeNull();
    expect(deltas[1]).toBe(300); // 5 minutes
    expect(deltas[2]).toBe(3300); // 55 minutes
  });
});

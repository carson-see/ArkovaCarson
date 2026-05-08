/**
 * Tests for the anchorExpirySweep cron (SCRUM-1736).
 *
 * Locks: SECURED anchors crossing expires_at are transitioned to EXPIRED,
 * an `anchor.expired` webhook event is dispatched per anchor with the
 * canonical SCRUM-1735 payload, and audit_events row is written.
 * Concurrent revocation must NOT double-fire — the compare-and-set
 * `WHERE status = 'SECURED'` guards against that race.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stub the logger module before the SUT imports it. Loading the real
// logger pulls in `src/config.ts`, which env-validates and bombs in
// unit-test environments without prod env vars.
vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

import {
  sweepExpiredAnchors,
  type AnchorExpirySweepDb,
} from './anchorExpirySweep.js';

interface FakeAnchor {
  id: string;
  public_id: string;
  org_id: string | null;
  org_public_id: string | null;
  status: string;
  chain_tx_id: string | null;
  chain_block_height: number | null;
  expires_at: string | null;
}

function makeDb(opts: {
  candidates: FakeAnchor[];
  casMisses?: Set<string>;
  webhookThrows?: Set<string>;
  auditFails?: Set<string>;
}): {
  db: AnchorExpirySweepDb;
  dispatched: Array<{ orgId: string; eventType: string; data: Record<string, unknown> }>;
  audits: Array<Record<string, unknown>>;
  updated: string[];
} {
  const dispatched: Array<{ orgId: string; eventType: string; data: Record<string, unknown> }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const updated: string[] = [];

  const db: AnchorExpirySweepDb = {
    selectExpiringSecured: vi.fn(async () => opts.candidates),
    casUpdateToExpired: vi.fn(async (anchorId: string) => {
      if (opts.casMisses?.has(anchorId)) return false;
      updated.push(anchorId);
      return true;
    }),
    insertAuditEvent: vi.fn(async (row: Record<string, unknown>) => {
      if (opts.auditFails?.has(String(row.target_id))) {
        throw new Error('audit insert failed');
      }
      audits.push(row);
    }),
    dispatchWebhookEvent: vi.fn(async (orgId: string, eventType: string, _eventId: string, data: Record<string, unknown>) => {
      const publicId = String(data.public_id);
      if (opts.webhookThrows?.has(publicId)) {
        throw new Error('dispatch failed');
      }
      dispatched.push({ orgId, eventType, data });
    }),
  };
  return { db, dispatched, audits, updated };
}

const FROZEN_NOW = '2026-05-08T12:00:00.000Z';

const EXPIRED_SECURED: FakeAnchor = {
  id: 'a1',
  public_id: 'ARK-2026-A1',
  org_id: 'org-uuid-1',
  org_public_id: 'pub_org_1',
  status: 'SECURED',
  chain_tx_id: 'tx-a1',
  chain_block_height: 850000,
  expires_at: '2026-05-07T00:00:00.000Z',
};

const NOT_YET_EXPIRED: FakeAnchor = {
  id: 'a2',
  public_id: 'ARK-2026-A2',
  org_id: 'org-uuid-1',
  org_public_id: 'pub_org_1',
  status: 'SECURED',
  chain_tx_id: 'tx-a2',
  chain_block_height: 850001,
  expires_at: '2027-05-07T00:00:00.000Z',
};

describe('sweepExpiredAnchors (SCRUM-1736)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FROZEN_NOW));
  });

  it('returns zeros and dispatches nothing when there are no candidates', async () => {
    const { db, dispatched, updated } = makeDb({ candidates: [] });
    const result = await sweepExpiredAnchors(db);
    expect(result).toEqual({ checked: 0, newly_expired: 0, webhooks_dispatched: 0, errors: [] });
    expect(updated).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  });

  it('transitions a SECURED+expired anchor to EXPIRED and dispatches anchor.expired', async () => {
    const { db, dispatched, audits, updated } = makeDb({ candidates: [EXPIRED_SECURED] });
    const result = await sweepExpiredAnchors(db);
    expect(result.checked).toBe(1);
    expect(result.newly_expired).toBe(1);
    expect(result.webhooks_dispatched).toBe(1);
    expect(result.errors).toEqual([]);
    expect(updated).toEqual(['a1']);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].orgId).toBe('org-uuid-1');
    expect(dispatched[0].eventType).toBe('anchor.expired');
    expect(audits).toHaveLength(1);
    expect(audits[0].event_type).toBe('anchor.expired');
    expect(audits[0].target_id).toBe('a1');
  });

  it('webhook payload conforms to SCRUM-1735 schema (public-only, both timestamps)', async () => {
    const { db, dispatched } = makeDb({ candidates: [EXPIRED_SECURED] });
    await sweepExpiredAnchors(db);
    const data = dispatched[0].data;
    expect(data).toEqual({
      public_id: 'ARK-2026-A1',
      chain_tx_id: 'tx-a1',
      chain_block_height: 850000,
      org_public_id: 'pub_org_1',
      status: 'EXPIRED',
      expires_at: '2026-05-07T00:00:00.000Z',
      expired_at: FROZEN_NOW,
    });
    // Banned fields must NOT appear in the payload (CLAUDE.md §6).
    expect(data).not.toHaveProperty('id');
    expect(data).not.toHaveProperty('anchor_id');
    expect(data).not.toHaveProperty('org_id');
    expect(data).not.toHaveProperty('user_id');
    expect(data).not.toHaveProperty('fingerprint');
  });

  it('skips webhook + audit when CAS update misses (anchor already revoked elsewhere)', async () => {
    const { db, dispatched, audits, updated } = makeDb({
      candidates: [EXPIRED_SECURED],
      casMisses: new Set(['a1']),
    });
    const result = await sweepExpiredAnchors(db);
    expect(result.checked).toBe(1);
    expect(result.newly_expired).toBe(0);
    expect(result.webhooks_dispatched).toBe(0);
    expect(result.errors).toEqual([]);
    expect(updated).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('records errors[] but keeps draining when one anchor dispatch fails', async () => {
    const a3: FakeAnchor = { ...EXPIRED_SECURED, id: 'a3', public_id: 'ARK-2026-A3' };
    const { db, dispatched, updated } = makeDb({
      candidates: [EXPIRED_SECURED, a3],
      webhookThrows: new Set(['ARK-2026-A1']),
    });
    const result = await sweepExpiredAnchors(db);
    expect(result.checked).toBe(2);
    expect(result.newly_expired).toBe(2);
    expect(result.webhooks_dispatched).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/ARK-2026-A1/);
    expect(updated).toEqual(['a1', 'a3']);
    expect(dispatched.map((d) => d.data.public_id)).toEqual(['ARK-2026-A3']);
  });

  it('does not transition anchors with null org_id (skips silently with audit-only)', async () => {
    const a4: FakeAnchor = { ...EXPIRED_SECURED, id: 'a4', public_id: 'ARK-2026-A4', org_id: null, org_public_id: null };
    const { db, dispatched, audits, updated } = makeDb({ candidates: [a4] });
    const result = await sweepExpiredAnchors(db);
    expect(result.checked).toBe(1);
    expect(result.newly_expired).toBe(1);
    expect(result.webhooks_dispatched).toBe(0);
    expect(updated).toEqual(['a4']);
    expect(dispatched).toHaveLength(0);
    expect(audits).toHaveLength(1);
  });

  it('omits org_public_id from payload when null', async () => {
    const noPublicOrg: FakeAnchor = { ...EXPIRED_SECURED, id: 'a5', public_id: 'ARK-2026-A5', org_public_id: null };
    const { db, dispatched } = makeDb({ candidates: [noPublicOrg] });
    await sweepExpiredAnchors(db);
    expect(dispatched[0].data).not.toHaveProperty('org_public_id');
  });

  it('continues when audit insert fails (logs error, does not abort)', async () => {
    const { db, dispatched, updated } = makeDb({
      candidates: [EXPIRED_SECURED],
      auditFails: new Set(['a1']),
    });
    const result = await sweepExpiredAnchors(db);
    expect(result.newly_expired).toBe(1);
    expect(result.webhooks_dispatched).toBe(1);
    expect(updated).toEqual(['a1']);
    expect(dispatched).toHaveLength(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.join(' ')).toMatch(/audit/i);
  });

  it('rejects anchors with malformed expires_at strings (CodeRabbit PR #734)', async () => {
    const malformed: FakeAnchor = { ...EXPIRED_SECURED, id: 'a-bad-ts', public_id: 'ARK-2026-BADTS', expires_at: 'not-a-real-date' };
    const { db, dispatched, updated } = makeDb({ candidates: [malformed] });
    const result = await sweepExpiredAnchors(db);
    expect(result.checked).toBe(1);
    expect(result.newly_expired).toBe(0);
    expect(result.webhooks_dispatched).toBe(0);
    expect(updated).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toMatch(/invalid, future, or null expires_at/i);
  });

  it('uses deterministic event_id "expired-${anchor.id}" so retries dedupe (CodeRabbit PR #734)', async () => {
    let capturedEventId: string | undefined;
    const db: AnchorExpirySweepDb = {
      selectExpiringSecured: vi.fn(async () => [EXPIRED_SECURED]),
      casUpdateToExpired: vi.fn(async () => true),
      insertAuditEvent: vi.fn(async () => undefined),
      dispatchWebhookEvent: vi.fn(async (_orgId, _eventType, eventId) => {
        capturedEventId = eventId;
      }),
    };
    await sweepExpiredAnchors(db);
    expect(capturedEventId).toBe(`expired-${EXPIRED_SECURED.id}`);
  });

  it('only considers anchors where expires_at is in the past (DB filter contract)', async () => {
    const { db } = makeDb({ candidates: [NOT_YET_EXPIRED] });
    const result = await sweepExpiredAnchors(db);
    expect(result.checked).toBe(1);
    expect(result.newly_expired).toBe(0);
    expect(result.webhooks_dispatched).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors.join(' ')).toMatch(/future/i);
  });
});

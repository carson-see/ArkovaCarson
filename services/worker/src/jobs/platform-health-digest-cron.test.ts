/**
 * Tests for the Platform Admin Daily Health Digest — production wiring.
 *
 * Covers the three areas called out for this job: recipients sourced by
 * admin designation (not hardcoded), content assembly against fixture DB
 * rows, and the flag-off no-op. The pure render/delivery engine is covered
 * in platform-health-digest.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

const mockConfig = { enablePlatformHealthDigest: true };
vi.mock('../config.js', () => ({ config: mockConfig }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/db.js', () => ({ db: { from: vi.fn() } }));
vi.mock('../email/sender.js', () => ({ sendEmail: vi.fn() }));

const {
  listPlatformAdmins,
  readAnchorStatusMetrics,
  readJobQueueMetrics,
  readBatchFlushMetrics,
  readConnectorHealthMetrics,
  readQuotaAnomalies,
  assemblePlatformHealthSnapshot,
  runPlatformHealthDigest,
  createPlatformHealthStore,
} = await import('./platform-health-digest-cron.js');

// Mirrors queue-digest-cron.test.ts's tiny fluent-chain mock.
function makeQuery(result: { data: unknown; error?: unknown }) {
  const calls: Array<[string, unknown, unknown]> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'is', 'not', 'order', 'lt', 'gte']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      calls.push([m, args[0], args[1]]);
      return chain;
    });
  }
  chain.limit = vi.fn(() => Promise.resolve({ data: result.data, error: result.error ?? null }));
  (chain as { _calls: unknown })._calls = calls;
  return chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipients — sourced by platform-admin designation, never hardcoded
// ─────────────────────────────────────────────────────────────────────────────

describe('listPlatformAdmins — recipients by role', () => {
  it('reads profiles.is_platform_admin = true (not a hardcoded address)', async () => {
    const query = makeQuery({ data: [{ email: 'ops1@arkova.ai' }, { email: 'ops2@arkova.ai' }] });
    const database = { from: vi.fn(() => query) };
    const admins = await listPlatformAdmins(database as never);
    expect(admins).toEqual([{ email: 'ops1@arkova.ai' }, { email: 'ops2@arkova.ai' }]);

    const calls = (query as unknown as { _calls: Array<[string, unknown, unknown]> })._calls;
    const eqCall = calls.find(([m, col]) => m === 'eq' && col === 'is_platform_admin');
    expect(eqCall).toBeDefined();
    expect(eqCall?.[2]).toBe(true);
    // Never a hardcoded carson@arkova.ai fallback in this path.
    expect(admins.some((a) => a.email === 'carson@arkova.ai')).toBe(false);
  });

  it('filters out rows with no email and skips soft-deleted profiles', async () => {
    const query = makeQuery({ data: [{ email: null }, { email: 'ops@arkova.ai' }] });
    const database = { from: vi.fn(() => query) };
    const admins = await listPlatformAdmins(database as never);
    expect(admins).toEqual([{ email: 'ops@arkova.ai' }]);

    const calls = (query as unknown as { _calls: Array<[string, unknown, unknown]> })._calls;
    expect(calls.find(([m, col]) => m === 'is' && col === 'deleted_at')).toBeDefined();
  });

  it('read error → empty recipient list (fail closed, never crash the job)', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: null, error: { message: 'boom' } })) };
    const admins = await listPlatformAdmins(database as never);
    expect(admins).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Anchors by status — bounded reads, graceful degradation to null
// ─────────────────────────────────────────────────────────────────────────────

describe('readAnchorStatusMetrics — bounded backlog + 24h-new counts', () => {
  const now = new Date('2026-08-18T13:00:00Z');

  it('reports a bounded backlog depth for a tracked transient status', async () => {
    const database = {
      from: vi.fn(() => makeQuery({ data: [{ created_at: '2026-08-18T10:00:00Z' }] })),
    };
    const metrics = await readAnchorStatusMetrics(database as never, now);
    const pending = metrics?.find((m) => m.status === 'PENDING');
    expect(pending).toBeDefined();
    expect(pending?.currentDepth).toBeGreaterThanOrEqual(0);
  });

  it('never computes a full-table current depth for a terminal status (SECURED) — currentDepth stays null', async () => {
    const database = {
      from: vi.fn(() => makeQuery({ data: [{ created_at: '2026-08-18T10:00:00Z' }] })),
    };
    const metrics = await readAnchorStatusMetrics(database as never, now);
    const secured = metrics?.find((m) => m.status === 'SECURED');
    expect(secured).toBeDefined();
    expect(secured?.currentDepth).toBeNull();
  });

  it('read error → null (not measured), never a false zero', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: null, error: { msg: 'boom' } })) };
    const metrics = await readAnchorStatusMetrics(database as never, now);
    expect(metrics).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Job queue depth / oldest
// ─────────────────────────────────────────────────────────────────────────────

describe('readJobQueueMetrics', () => {
  it('reports pending depth and the oldest pending job age', async () => {
    const now = new Date('2026-08-18T13:00:00Z');
    const query = makeQuery({ data: [{ created_at: '2026-08-18T12:45:00Z' }] });
    const database = { from: vi.fn(() => query) };
    const jq = await readJobQueueMetrics(database as never, now);
    expect(jq?.pendingDepth).toBe(1);
    expect(jq?.oldestPendingAgeMinutes).toBe(15);

    const calls = (query as unknown as { _calls: Array<[string, unknown, unknown]> })._calls;
    expect(calls.find(([m, col]) => m === 'eq' && col === 'status')?.[2]).toBe('pending');
  });

  it('an empty queue reports zero depth and a null oldest age', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: [] })) };
    const jq = await readJobQueueMetrics(database as never, new Date());
    expect(jq).toEqual({ pendingDepth: 0, pendingDepthCapped: false, oldestPendingAgeMinutes: null });
  });

  it('read error → null', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: null, error: { msg: 'boom' } })) };
    const jq = await readJobQueueMetrics(database as never, new Date());
    expect(jq).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch flush of the night — fired? tx? count?
// ─────────────────────────────────────────────────────────────────────────────

describe('readBatchFlushMetrics', () => {
  it('reports the latest batch fired in the last 24h with its anchor count', async () => {
    const database = {
      from: vi.fn(() =>
        makeQuery({
          data: [
            {
              txid: 'b'.repeat(64),
              signed_at: '2026-08-18T03:00:00Z',
              anchor_ids: new Array(8500).fill('x'),
            },
          ],
        }),
      ),
    };
    const bf = await readBatchFlushMetrics(database as never, new Date('2026-08-18T13:00:00Z'));
    expect(bf?.fired).toBe(true);
    expect(bf?.batchesLast24h).toBe(1);
    expect(bf?.totalAnchorsLast24h).toBe(8500);
    expect(bf?.latestTxid).toBe('b'.repeat(64));
  });

  it('reports fired:false when nothing signed in the last 24h', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: [] })) };
    const bf = await readBatchFlushMetrics(database as never, new Date());
    expect(bf).toEqual({
      fired: false,
      batchesLast24h: 0,
      totalAnchorsLast24h: 0,
      latestTxid: null,
      latestSignedAt: null,
    });
  });

  it('read error → null', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: null, error: { msg: 'boom' } })) };
    const bf = await readBatchFlushMetrics(database as never, new Date());
    expect(bf).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Connector health rollup — platform-wide, never a per-org breakdown
// ─────────────────────────────────────────────────────────────────────────────

describe('readConnectorHealthMetrics', () => {
  it('rolls up the worst state per connector across orgs, and counts affected orgs', async () => {
    const database = {
      from: vi.fn(() =>
        makeQuery({
          data: [
            { connector_id: 'docusign', org_id: 'org-a', last_state: 'connected', updated_at: '2026-08-18T10:00:00Z' },
            { connector_id: 'docusign', org_id: 'org-b', last_state: 'degraded', updated_at: '2026-08-18T11:00:00Z' },
            { connector_id: 'google_drive', org_id: 'org-a', last_state: 'connected', updated_at: '2026-08-18T09:00:00Z' },
          ],
        }),
      ),
    };
    const connectors = await readConnectorHealthMetrics(database as never);
    const docusign = connectors?.find((c) => c.connectorId === 'docusign');
    expect(docusign?.worstState).toBe('degraded');
    expect(docusign?.orgsAffected).toBe(1);
    const drive = connectors?.find((c) => c.connectorId === 'google_drive');
    expect(drive?.worstState).toBe('connected');
    expect(drive?.orgsAffected).toBe(0);
  });

  it('excludes the synthetic demo connector from the rollup', async () => {
    const database = {
      from: vi.fn(() =>
        makeQuery({
          data: [{ connector_id: 'demo', org_id: 'org-a', last_state: 'disconnected', updated_at: '2026-08-18T10:00:00Z' }],
        }),
      ),
    };
    const connectors = await readConnectorHealthMetrics(database as never);
    expect(connectors?.find((c) => c.connectorId === 'demo')).toBeUndefined();
  });

  it('read error → null', async () => {
    const database = { from: vi.fn(() => makeQuery({ data: null, error: { msg: 'boom' } })) };
    const connectors = await readConnectorHealthMetrics(database as never);
    expect(connectors).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quota anomalies — test-tier orgs at/over their anchor_quota cap
// ─────────────────────────────────────────────────────────────────────────────

describe('readQuotaAnomalies', () => {
  it('flags a test-tier org whose non-deleted anchor count meets or exceeds its quota', async () => {
    const database = {
      from: vi.fn((table: string) => {
        if (table === 'org_credits') {
          return makeQuery({ data: [{ org_id: 'org-sandbox', anchor_quota: 10 }] });
        }
        if (table === 'organizations') {
          return makeQuery({ data: [{ id: 'org-sandbox', display_name: 'Sandbox Org' }] });
        }
        if (table === 'anchors') {
          return makeQuery({ data: new Array(11).fill({ id: 'x' }) });
        }
        return makeQuery({ data: [] });
      }),
    };
    const anomalies = await readQuotaAnomalies(database as never);
    expect(anomalies).toEqual([
      { orgId: 'org-sandbox', orgName: 'Sandbox Org', anchorQuota: 10, nonDeletedAnchorCount: 11 },
    ]);
  });

  it('does not flag a test-tier org still under its quota', async () => {
    const database = {
      from: vi.fn((table: string) => {
        if (table === 'org_credits') return makeQuery({ data: [{ org_id: 'org-sandbox', anchor_quota: 10 }] });
        if (table === 'organizations') return makeQuery({ data: [{ id: 'org-sandbox', display_name: 'Sandbox Org' }] });
        if (table === 'anchors') return makeQuery({ data: new Array(3).fill({ id: 'x' }) });
        return makeQuery({ data: [] });
      }),
    };
    const anomalies = await readQuotaAnomalies(database as never);
    expect(anomalies).toEqual([]);
  });

  it('read error on the org_credits scan → null', async () => {
    const database = {
      from: vi.fn((table: string) => {
        if (table === 'org_credits') return makeQuery({ data: null, error: { msg: 'boom' } });
        return makeQuery({ data: [] });
      }),
    };
    const anomalies = await readQuotaAnomalies(database as never);
    expect(anomalies).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot assembly — one section's failure does not sink the others
// ─────────────────────────────────────────────────────────────────────────────

describe('assemblePlatformHealthSnapshot — per-section graceful degradation', () => {
  it('a job_queue read failure still returns anchors/connectors/quota sections, with jobQueue: null', async () => {
    const now = new Date('2026-08-18T13:00:00Z');
    const database = {
      from: vi.fn((table: string) => {
        if (table === 'job_queue') return makeQuery({ data: null, error: { msg: 'boom' } });
        if (table === 'anchors') return makeQuery({ data: [] });
        if (table === 'connector_alert_state') return makeQuery({ data: [] });
        if (table === 'org_credits') return makeQuery({ data: [] });
        if (table === 'anchor_txid_journal') return makeQuery({ data: [] });
        return makeQuery({ data: [] });
      }),
    };
    const snapshot = await assemblePlatformHealthSnapshot(database as never, now);
    expect(snapshot.jobQueue).toBeNull();
    expect(snapshot.connectors).toEqual([]);
    expect(snapshot.quotaAnomalies).toEqual([]);
    expect(snapshot.measuredAt).toBe(now.toISOString());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cron loop — flag gate, fan-out to every platform admin, idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe('runPlatformHealthDigest — cron loop', () => {
  it('is a no-op when the digest is disabled (flag-off)', async () => {
    const prev = mockConfig.enablePlatformHealthDigest;
    try {
      mockConfig.enablePlatformHealthDigest = false;
      const send = vi.fn(async () => ({ success: true }));
      const from = vi.fn();
      const result = await runPlatformHealthDigest({ database: { from } as never, send: send as never });
      expect(result.admins).toBe(0);
      expect(send).not.toHaveBeenCalled();
      expect(from).not.toHaveBeenCalled();
    } finally {
      mockConfig.enablePlatformHealthDigest = prev;
    }
  });

  it('sends the SAME digest to every platform admin and aggregates the result', async () => {
    const database = {
      from: vi.fn((table: string) => {
        switch (table) {
          case 'profiles':
            return makeQuery({ data: [{ email: 'ops1@arkova.ai' }, { email: 'ops2@arkova.ai' }] });
          case 'anchors':
            return makeQuery({ data: [] });
          case 'job_queue':
            return makeQuery({ data: [] });
          case 'connector_alert_state':
            return makeQuery({ data: [] });
          case 'org_credits':
            return makeQuery({ data: [] });
          case 'anchor_txid_journal':
            return makeQuery({ data: [] });
          case 'audit_events':
            return { ...makeQuery({ data: [] }), insert: vi.fn(async () => ({ error: null })) };
          default:
            return makeQuery({ data: [] });
        }
      }),
    };
    const send = vi.fn(async () => ({ success: true, messageId: 'm1' }));
    const result = await runPlatformHealthDigest({
      database: database as never,
      send: send as never,
      now: new Date('2026-08-18T13:00:00Z'),
    });
    expect(result.admins).toBe(2);
    expect(result.sent).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops1@arkova.ai', emailType: 'notification' }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops2@arkova.ai', emailType: 'notification' }));
  });

  it('with zero platform admins, does nothing and never builds a snapshot', async () => {
    const anchorsFrom = vi.fn(() => makeQuery({ data: [] }));
    const database = {
      from: vi.fn((table: string) => {
        if (table === 'profiles') return makeQuery({ data: [] });
        if (table === 'anchors') return anchorsFrom();
        return makeQuery({ data: [] });
      }),
    };
    const send = vi.fn(async () => ({ success: true }));
    const result = await runPlatformHealthDigest({ database: database as never, send: send as never });
    expect(result.admins).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(anchorsFrom).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// audit_events-backed store
// ─────────────────────────────────────────────────────────────────────────────

describe('createPlatformHealthStore', () => {
  it('reads back a SENT row scoped to (recipient, digest date)', async () => {
    const database = {
      from: vi.fn(() =>
        makeQuery({
          data: [
            {
              event_type: 'PLATFORM_HEALTH_DIGEST_SENT',
              details: JSON.stringify({ digest_date: '2026-08-18', attempts: 1 }),
            },
          ],
        }),
      ),
    };
    const store = createPlatformHealthStore(database as never);
    const log = await store.getDeliveryLog('ops@arkova.ai', '2026-08-18');
    expect(log).toMatchObject({ status: 'SENT', attempts: 1 });
  });

  it('reservation insert conflict (23505) → false, another worker already sent', async () => {
    const insert = vi.fn(async () => ({ error: { code: '23505' } }));
    const database = { from: vi.fn(() => ({ insert })) };
    const store = createPlatformHealthStore(database as never);
    const won = await store.reserveDelivery({
      adminEmail: 'ops@arkova.ai',
      digestDate: '2026-08-18',
      status: 'SENT',
      attempts: 1,
    });
    expect(won).toBe(false);
  });
});

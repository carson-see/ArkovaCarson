/**
 * Tests for SCRUM-1147 — Google Drive + Microsoft Graph subscription renewal.
 *
 * Acceptance Criteria:
 *   - Stores channel/subscription expiration metadata
 *   - Renewal job refreshes channels before expiration
 *   - Failed renewal marks connector degraded with actionable error
 *   - UI/API exposes last renewal and next expiration
 *   - Tests cover expired, soon-expiring, successful renewal, and failed renewal paths
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface SubscriptionRow {
  id: string;
  provider: 'google_drive' | 'microsoft_graph';
  org_id: string;
  vendor_subscription_id: string;
  expires_at: string;
  status: string;
  last_renewed_at: string | null;
  last_renewal_error: string | null;
}

const dbState = {
  rows: [] as SubscriptionRow[],
  updates: new Map<string, Record<string, unknown>>(),
};

vi.mock('../config.js', () => ({ config: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../utils/db.js', () => {
  // The renewal job chains `.from('connector_subscriptions').select(...).or(...).order(...).limit(...)`
  // and `.from('connector_subscriptions').update(...).eq(...)`. The proxy
  // below stays chainable until `.limit()` resolves to the mock data.
  const select = (_cols?: string) => {
    const limit = async () => ({ data: dbState.rows, error: null });
    const order = () => ({ limit });
    const or = () => ({ order, limit });
    return { or, order, limit };
  };
  const update = (patch: Record<string, unknown>) => ({
    eq: async (_col: string, val: unknown) => {
      dbState.updates.set(String(val), patch);
      return { error: null };
    },
  });
  return {
    db: {
      from: (table: string) => {
        if (table === 'connector_subscriptions') return { select, update };
        throw new Error(`unexpected table: ${table}`);
      },
    },
  };
});

const driveRenew = vi.fn();
const graphRenew = vi.fn();

const { runSubscriptionRenewal, RENEWAL_WINDOW_MS } = await import(
  './workspace-subscription-renewal.js'
);

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function row(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  const base: SubscriptionRow = {
    id: 'sub-1',
    provider: 'google_drive',
    org_id: ORG_ID,
    vendor_subscription_id: 'channel-1',
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 'active',
    last_renewed_at: null,
    last_renewal_error: null,
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.rows = [];
  dbState.updates = new Map();
  driveRenew.mockResolvedValue({
    vendor_subscription_id: 'channel-1-renewed',
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });
  graphRenew.mockResolvedValue({
    vendor_subscription_id: 'sub-1-renewed',
    expires_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
  });
});

describe('runSubscriptionRenewal (SCRUM-1147)', () => {
  it('renews a soon-to-expire Google Drive subscription and clears any prior error', async () => {
    dbState.rows = [
      row({
        provider: 'google_drive',
        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        last_renewal_error: 'previous-error',
      }),
    ];
    const res = await runSubscriptionRenewal({ driveRenew, graphRenew });
    expect(res.checked).toBe(1);
    expect(res.renewed).toBe(1);
    expect(res.failed).toBe(0);
    expect(driveRenew).toHaveBeenCalledTimes(1);
    const update = dbState.updates.get('sub-1');
    expect(update?.status).toBe('active');
    expect(update?.last_renewal_error).toBeNull();
    expect(update?.last_renewed_at).toBeDefined();
    expect(typeof update?.expires_at).toBe('string');
    expect(update?.vendor_subscription_id).toBe('channel-1-renewed');
  });

  it('renews already-expired subscriptions (does not skip past-due rows)', async () => {
    dbState.rows = [row({ expires_at: new Date(Date.now() - 60_000).toISOString() })];
    const res = await runSubscriptionRenewal({ driveRenew, graphRenew });
    expect(res.renewed).toBe(1);
    expect(driveRenew).toHaveBeenCalledTimes(1);
  });

  it('marks degraded with actionable error when vendor renewal fails', async () => {
    dbState.rows = [row({})];
    driveRenew.mockRejectedValueOnce(new Error('401 invalid_grant'));
    const res = await runSubscriptionRenewal({ driveRenew, graphRenew });
    expect(res.failed).toBe(1);
    expect(res.renewed).toBe(0);
    const update = dbState.updates.get('sub-1');
    expect(update?.status).toBe('degraded');
    expect(update?.last_renewal_error).toContain('invalid_grant');
  });

  it('routes Microsoft Graph subscriptions to the Graph renewer', async () => {
    dbState.rows = [
      row({ id: 'sub-2', provider: 'microsoft_graph', vendor_subscription_id: 'graph-sub-2' }),
    ];
    const res = await runSubscriptionRenewal({ driveRenew, graphRenew });
    expect(res.renewed).toBe(1);
    expect(graphRenew).toHaveBeenCalledTimes(1);
    expect(driveRenew).not.toHaveBeenCalled();
    const update = dbState.updates.get('sub-2');
    expect(update?.vendor_subscription_id).toBe('sub-1-renewed');
  });

  it('respects ENABLE_WORKSPACE_RENEWAL=false (no DB or vendor traffic)', async () => {
    process.env.ENABLE_WORKSPACE_RENEWAL = 'false';
    dbState.rows = [row({})];
    const res = await runSubscriptionRenewal({ driveRenew, graphRenew });
    expect(res.checked).toBe(0);
    expect(driveRenew).not.toHaveBeenCalled();
    expect(graphRenew).not.toHaveBeenCalled();
    delete process.env.ENABLE_WORKSPACE_RENEWAL;
  });

  it('exposes RENEWAL_WINDOW_MS as a positive constant (>= 1 hour)', () => {
    expect(RENEWAL_WINDOW_MS).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it('processes mixed batches and reports per-row outcomes', async () => {
    driveRenew.mockResolvedValueOnce({
      vendor_subscription_id: 'channel-A-renewed',
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    graphRenew.mockRejectedValueOnce(new Error('subscription not found'));
    dbState.rows = [
      row({ id: 'sub-A', provider: 'google_drive', vendor_subscription_id: 'channel-A' }),
      row({ id: 'sub-B', provider: 'microsoft_graph', vendor_subscription_id: 'graph-B' }),
    ];
    const res = await runSubscriptionRenewal({ driveRenew, graphRenew });
    expect(res.checked).toBe(2);
    expect(res.renewed).toBe(1);
    expect(res.failed).toBe(1);
    expect(dbState.updates.get('sub-A')?.status).toBe('active');
    expect(dbState.updates.get('sub-B')?.status).toBe('degraded');
  });
});

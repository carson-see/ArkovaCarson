/**
 * GH #1835 — Google Drive `org_integrations` subscription renewal tests.
 *
 * Pure orchestrator — DB, Drive API, and alerting are all injected. These
 * tests drive it directly with fakes; no real network or Postgres traffic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renewDriveSubscriptions,
  type DriveSubscriptionRenewalDb,
  type DriveSubscriptionRenewalClient,
} from './drive-subscription-renewal.js';

beforeEach(() => vi.clearAllMocks());

const NOW = new Date('2026-08-03T00:00:00.000Z');

function dueRow(over: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    org_id: 'org-1',
    subscription_id: 'chan-old',
    subscription_expires_at: '2026-08-03T06:00:00.000Z', // 6h out → within 24h horizon
    account_label: JSON.stringify({ email: 'admin@example.com', channel_token: 'old-token', resource_id: 'res-old' }),
    watch_renewal_failure_count: 0,
    ...over,
  };
}

function makeClient(over: Partial<DriveSubscriptionRenewalClient> = {}): DriveSubscriptionRenewalClient {
  return {
    getAccessToken: vi.fn(async () => ({ accessToken: 'at', revoked: false })),
    stopChannel: vi.fn(async () => {}),
    createChannel: vi.fn(async () => ({ resourceId: 'res-new', expiration: '2026-08-10T00:00:00.000Z' })),
    ...over,
  };
}

function makeDb(rows: Record<string, unknown>[], over: Partial<DriveSubscriptionRenewalDb> = {}): {
  db: DriveSubscriptionRenewalDb;
  updates: unknown[];
} {
  const updates: unknown[] = [];
  const db: DriveSubscriptionRenewalDb = {
    listRenewableConnections: vi.fn(async () => rows as never),
    updateConnection: vi.fn(async (u) => {
      updates.push(u);
      return { error: false };
    }),
    ...over,
  };
  return { db, updates };
}

describe('renewDriveSubscriptions (GH #1835)', () => {
  it('scans nothing → returns a zeroed summary without touching the client', async () => {
    const { db } = makeDb([]);
    const client = makeClient();
    const alert = vi.fn();
    const summary = await renewDriveSubscriptions({ db, client, alert, now: () => NOW });
    expect(summary).toEqual({ scanned: 0, renewed: 0, degraded: 0, failed: 0 });
    expect(client.getAccessToken).not.toHaveBeenCalled();
  });

  it('renews a due channel: stops the old one, registers a new one, persists id/expiry/label, clears the failure count', async () => {
    const { db, updates } = makeDb([dueRow()]);
    const client = makeClient();
    const alert = vi.fn();
    const summary = await renewDriveSubscriptions({
      db,
      client,
      alert,
      now: () => NOW,
      channelIdFactory: () => 'chan-new',
      channelTokenFactory: () => 'new-random-token',
    });

    expect(summary).toEqual({ scanned: 1, renewed: 1, degraded: 0, failed: 0 });
    expect(client.stopChannel).toHaveBeenCalledWith({
      accessToken: 'at',
      channelId: 'chan-old',
      resourceId: 'res-old',
    });
    expect(client.createChannel).toHaveBeenCalledWith({
      accessToken: 'at',
      channelId: 'chan-new',
      channelToken: 'new-random-token',
    });
    expect(updates).toHaveLength(1);
    const update = updates[0] as Record<string, unknown>;
    expect(update.subscription_id).toBe('chan-new');
    expect(update.subscription_expires_at).toBe('2026-08-10T00:00:00.000Z');
    expect(update.last_renewal_error).toBeNull();
    expect(update.watch_renewal_failure_count).toBe(0);
    const label = JSON.parse(update.account_label as string);
    expect(label.channel_token).toBe('new-random-token');
    expect(label.resource_id).toBe('res-new');
    expect(label.email).toBe('admin@example.com'); // preserved, not clobbered
    expect(alert).not.toHaveBeenCalled();
  });

  // CRITICAL invariant — see the module doc comment. A renewal that touches
  // last_page_token would silently drop unprocessed changes.
  it('NEVER writes last_page_token on a successful renewal', async () => {
    const { db, updates } = makeDb([dueRow()]);
    const client = makeClient();
    await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW });
    const update = updates[0] as Record<string, unknown>;
    expect('last_page_token' in update).toBe(false);
  });

  it('registers a channel for a connection whose subscription was never bootstrapped (subscription_id null)', async () => {
    const { db, updates } = makeDb([dueRow({ subscription_id: null, account_label: null })]);
    const client = makeClient();
    await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW });
    // No old channel to stop.
    expect(client.stopChannel).not.toHaveBeenCalled();
    expect(client.createChannel).toHaveBeenCalled();
    expect(updates).toHaveLength(1);
  });

  it('a stopChannel failure on the old channel does not block renewal of the new one', async () => {
    const { db, updates } = makeDb([dueRow()]);
    const client = makeClient({ stopChannel: vi.fn(async () => { throw new Error('channels.stop 404'); }) });
    const summary = await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW });
    expect(summary.renewed).toBe(1);
    expect(updates).toHaveLength(1);
  });

  it('OAuth grant revoked (no access token) degrades the connection and alerts token_revoked — never touches the channel', async () => {
    const { db, updates } = makeDb([dueRow()]);
    const client = makeClient({ getAccessToken: vi.fn(async () => ({ accessToken: null, revoked: true })) });
    const alert = vi.fn();
    const summary = await renewDriveSubscriptions({ db, client, alert, now: () => NOW });

    expect(summary).toEqual({ scanned: 1, renewed: 0, degraded: 1, failed: 0 });
    expect(client.stopChannel).not.toHaveBeenCalled();
    expect(client.createChannel).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: 'int-1',
      orgId: 'org-1',
      kind: 'token_revoked',
    }));
    const update = updates[0] as Record<string, unknown>;
    // Existing subscription/label preserved untouched — a revoked grant does
    // not mean the (still valid, not-yet-expired) channel state is gone.
    expect(update.subscription_id).toBe('chan-old');
    expect(update.watch_renewal_failure_count).toBe(1);
  });

  it('getAccessToken throwing counts as failed, increments the failure count, and alerts renewal_failed', async () => {
    const { db, updates } = makeDb([dueRow({ watch_renewal_failure_count: 2 })]);
    const client = makeClient({ getAccessToken: vi.fn(async () => { throw new Error('kms unavailable'); }) });
    const alert = vi.fn();
    const summary = await renewDriveSubscriptions({ db, client, alert, now: () => NOW });

    expect(summary).toEqual({ scanned: 1, renewed: 0, degraded: 0, failed: 1 });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'renewal_failed', reason: 'kms unavailable' }));
    expect((updates[0] as Record<string, unknown>).watch_renewal_failure_count).toBe(3);
  });

  it('createChannel throwing counts as failed and preserves the existing (still-active) subscription state', async () => {
    const { db, updates } = makeDb([dueRow()]);
    const client = makeClient({ createChannel: vi.fn(async () => { throw new Error('changes.watch 500') }) });
    const alert = vi.fn();
    const summary = await renewDriveSubscriptions({ db, client, alert, now: () => NOW });

    expect(summary).toEqual({ scanned: 1, renewed: 0, degraded: 0, failed: 1 });
    const update = updates[0] as Record<string, unknown>;
    expect(update.subscription_id).toBe('chan-old');
    expect(update.last_renewal_error).toBe('changes.watch 500');
    expect(update.watch_renewal_failure_count).toBe(1);
  });

  it('a DB write failure on the successful-renewal path is counted as failed, not renewed', async () => {
    const { db } = makeDb([dueRow()], { updateConnection: vi.fn(async () => ({ error: true })) });
    const client = makeClient();
    const alert = vi.fn();
    const summary = await renewDriveSubscriptions({ db, client, alert, now: () => NOW });
    expect(summary).toEqual({ scanned: 1, renewed: 0, degraded: 0, failed: 1 });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'renewal_failed' }));
  });

  it('processes multiple due connections independently — one failure does not block another\'s renewal', async () => {
    const rows = [
      dueRow({ id: 'int-1', org_id: 'org-1' }),
      dueRow({ id: 'int-2', org_id: 'org-2', account_label: null }),
    ];
    const { db, updates } = makeDb(rows);
    let call = 0;
    const client = makeClient({
      createChannel: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('transient');
        return { resourceId: 'res-2', expiration: '2026-08-10T00:00:00.000Z' };
      }),
    });
    const summary = await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW });
    expect(summary).toEqual({ scanned: 2, renewed: 1, degraded: 0, failed: 1 });
    expect(updates).toHaveLength(2);
  });

  it('reason strings are bounded to avoid an unbounded error message ballooning the row', async () => {
    const { db, updates } = makeDb([dueRow()]);
    const client = makeClient({
      createChannel: vi.fn(async () => { throw new Error('x'.repeat(2000)); }),
    });
    await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW });
    const update = updates[0] as Record<string, unknown>;
    expect((update.last_renewal_error as string).length).toBeLessThanOrEqual(500);
  });
});

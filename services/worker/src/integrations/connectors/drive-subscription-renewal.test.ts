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
    // CRITICAL (PR #1944 review): the old channel must NEVER be stopped when
    // createChannel fails — see the dedicated create-then-stop describe
    // block below for the full regression coverage.
    expect(client.stopChannel).not.toHaveBeenCalled();
  });

  // CRITICAL FIX (PR #1944 review): renewDriveSubscriptions() used to call
  // tryStop() on the OLD channel BEFORE attempting createChannel() for the
  // new one. If createChannel then failed, the persisted row still claimed
  // the OLD channel was active — but it had already been stopped. Net
  // effect: the org would have ZERO live Drive channels and receive no
  // webhooks until a LATER sweep happened to succeed — the renewal job
  // built to close GH #1835 would have reproduced GH #1835's exact
  // silent-outage symptom, on healthy connections, on a realistic first-run
  // failure (WORKER_PUBLIC_URL not yet configured) or any transient Google
  // 5xx. Fixed to create-then-stop: the old channel is stopped ONLY after
  // the new one is both live at Google AND successfully persisted.
  describe('create-then-stop ordering (CRITICAL, PR #1944 review)', () => {
    it('createChannel throws → the old channel is NEVER stopped, and the row still points at the old, still-live channel', async () => {
      const { db, updates } = makeDb([dueRow()]);
      const client = makeClient({
        createChannel: vi.fn(async () => { throw new Error('changes.watch 500 (e.g. WORKER_PUBLIC_URL unset)'); }),
      });
      const summary = await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW });

      expect(summary).toEqual({ scanned: 1, renewed: 0, degraded: 0, failed: 1 });
      // The old channel was never touched.
      expect(client.stopChannel).not.toHaveBeenCalled();
      // The persisted row still names the OLD, never-stopped channel —
      // never a channel we killed and then lied about.
      const update = updates[0] as Record<string, unknown>;
      expect(update.subscription_id).toBe('chan-old');
      const label = JSON.parse(update.account_label as string);
      expect(label.channel_token).toBe('old-token');
      expect(label.resource_id).toBe('res-old');
    });

    it('createChannel succeeds but the DB write fails → the old channel is STILL not stopped (new channel is the orphan, not the old one)', async () => {
      const { db } = makeDb([dueRow()], { updateConnection: vi.fn(async () => ({ error: true })) });
      const client = makeClient();
      const summary = await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW });

      expect(summary).toEqual({ scanned: 1, renewed: 0, degraded: 0, failed: 1 });
      // A successfully-created-but-not-persisted new channel must not cost
      // us the old one — the DB still names the old channel as current, so
      // the old channel must still be the one actually live.
      expect(client.stopChannel).not.toHaveBeenCalled();
    });

    it('createChannel succeeds AND persists → the old channel IS stopped, using the OLD channel id/resourceId (not the new one)', async () => {
      const { db } = makeDb([dueRow()]);
      const client = makeClient();
      const summary = await renewDriveSubscriptions({
        db, client, alert: vi.fn(), now: () => NOW,
        channelIdFactory: () => 'chan-new', channelTokenFactory: () => 'tok-new',
      });

      expect(summary.renewed).toBe(1);
      expect(client.stopChannel).toHaveBeenCalledTimes(1);
      expect(client.stopChannel).toHaveBeenCalledWith({
        accessToken: 'at',
        channelId: 'chan-old', // the OLD id, never the newly-created 'chan-new'
        resourceId: 'res-old',
      });
    });

    it('stop happens strictly AFTER createChannel and updateConnection, not before (call-order proof)', async () => {
      const { db } = makeDb([dueRow()]);
      const order: string[] = [];
      const client = makeClient({
        createChannel: vi.fn(async () => { order.push('createChannel'); return { resourceId: 'res-new', expiration: '2026-08-10T00:00:00.000Z' }; }),
        stopChannel: vi.fn(async () => { order.push('stopChannel'); }),
      });
      const dbWithOrder: DriveSubscriptionRenewalDb = {
        ...db,
        updateConnection: async (u) => { order.push('updateConnection'); return db.updateConnection(u); },
      };
      await renewDriveSubscriptions({ db: dbWithOrder, client, alert: vi.fn(), now: () => NOW });
      expect(order).toEqual(['createChannel', 'updateConnection', 'stopChannel']);
    });
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

  // PR #1944 review addendum (SECURITY, higher priority than the perf finds):
  // boundedReason() used to cap length only — never PII-scrub — even though
  // the result is persisted to org_integrations.last_renewal_error AND
  // passed as Sentry extra.reason. A raw Google API error body can carry an
  // account email or token fragment. Now routed through the canonical
  // boundedErrorDetail() (utils/byte-safety.ts), which scrubs PII by
  // construction.
  describe('PII scrub on persisted/alerted failure reasons (boundedErrorDetail)', () => {
    it('an error message containing an email does NOT reach the persisted last_renewal_error', async () => {
      const { db, updates } = makeDb([dueRow()]);
      const client = makeClient({
        createChannel: vi.fn(async () => {
          throw new Error('Google API rejected request for user secret-user@example.com: invalid_grant');
        }),
      });
      await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW });
      const update = updates[0] as Record<string, unknown>;
      expect(update.last_renewal_error as string).not.toContain('secret-user@example.com');
    });

    it('an error message containing an email does NOT reach the Sentry alert payload', async () => {
      const { db } = makeDb([dueRow()]);
      const client = makeClient({
        createChannel: vi.fn(async () => {
          throw new Error('Google API rejected request for user secret-user@example.com: invalid_grant');
        }),
      });
      const alert = vi.fn();
      await renewDriveSubscriptions({ db, client, alert, now: () => NOW });
      expect(alert).toHaveBeenCalledWith(
        expect.objectContaining({ reason: expect.not.stringContaining('secret-user@example.com') }),
      );
    });

    it('scrubs PII on the getAccessToken-throw path too (not just createChannel)', async () => {
      const { db, updates } = makeDb([dueRow()]);
      const client = makeClient({
        getAccessToken: vi.fn(async () => {
          throw new Error('KMS decrypt failed for token belonging to leaked@example.com');
        }),
      });
      await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW });
      const update = updates[0] as Record<string, unknown>;
      expect(update.last_renewal_error as string).not.toContain('leaked@example.com');
    });
  });

  // FINDING 2 (PR #1944 review round 3, perf): connections are independent
  // and must be processed CONCURRENTLY within a bounded chunk, not one at a
  // time — sequential processing of a ~100-row batch (each involving a KMS
  // decrypt + 1-3 Drive API round trips) risks running past the sweep's own
  // hourly trigger or the Cloud Run request timeout.
  describe('bounded concurrency (FINDING 2)', () => {
    it('processes connections within a chunk CONCURRENTLY, not sequentially', async () => {
      const rows = Array.from({ length: 3 }, (_, i) => dueRow({ id: `int-${i}`, org_id: `org-${i}` }));
      const { db } = makeDb(rows);
      const startOrder: string[] = [];
      const releaseGate: Array<() => void> = [];
      const client = makeClient({
        getAccessToken: vi.fn(async (conn) => {
          startOrder.push(conn.id);
          // Block until every row has STARTED — this can only resolve if all
          // three are in flight simultaneously, which is only possible under
          // concurrent (not sequential) processing.
          await new Promise<void>((resolve) => releaseGate.push(resolve));
          return { accessToken: 'at', revoked: false };
        }),
      });

      const runPromise = renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW, concurrency: 5 });

      // Give the microtask queue a chance to let all three getAccessToken
      // calls start before releasing any of them.
      await new Promise((r) => setTimeout(r, 10));
      expect(startOrder).toHaveLength(3);
      releaseGate.forEach((release) => release());

      const summary = await runPromise;
      expect(summary.renewed).toBe(3);
    });

    it('bounds concurrency to the configured limit — no more than N connections have getAccessToken in flight at once', async () => {
      const rows = Array.from({ length: 12 }, (_, i) => dueRow({ id: `int-${i}`, org_id: `org-${i}` }));
      const { db } = makeDb(rows);
      let inFlight = 0;
      let maxInFlight = 0;
      const client = makeClient({
        getAccessToken: vi.fn(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight -= 1;
          return { accessToken: 'at', revoked: false };
        }),
      });

      const summary = await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW, concurrency: 4 });

      expect(summary.renewed).toBe(12);
      expect(maxInFlight).toBeLessThanOrEqual(4);
      // And it actually USED concurrency — not degenerately serialized to 1.
      expect(maxInFlight).toBeGreaterThan(1);
    });

    it('one connection erroring inside a chunk does NOT prevent its chunk-mates from completing (error isolation under concurrency)', async () => {
      const rows = Array.from({ length: 5 }, (_, i) => dueRow({ id: `int-${i}`, org_id: `org-${i}` }));
      const { db, updates } = makeDb(rows);
      // A genuine per-connection DATA dependency (accessToken flows from
      // THIS connection's own getAccessToken call to THIS connection's own
      // createChannel call) rather than a call-COUNT coincidence — robust
      // regardless of exactly how the concurrent chunk interleaves.
      const client = makeClient({
        getAccessToken: vi.fn(async (conn) => ({
          accessToken: conn.id === 'int-2' ? 'at-fail' : 'at-ok',
          revoked: false,
        })),
        createChannel: vi.fn(async (callArgs) => {
          if (callArgs.accessToken === 'at-fail') throw new Error('changes.watch 500');
          return { resourceId: 'res-ok', expiration: '2026-08-10T00:00:00.000Z' };
        }),
      });
      const summary = await renewDriveSubscriptions({
        db, client, alert: vi.fn(), now: () => NOW, concurrency: 5,
      });

      expect(summary.scanned).toBe(5);
      expect(summary.renewed).toBe(4);
      expect(summary.failed).toBe(1);
      expect(updates).toHaveLength(5);
    });

    it('processes chunks in SEQUENCE across a batch larger than one chunk (never opens more than `concurrency` at once, even across chunks)', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => dueRow({ id: `int-${i}`, org_id: `org-${i}` }));
      const { db } = makeDb(rows);
      let inFlight = 0;
      let maxInFlight = 0;
      const client = makeClient({
        getAccessToken: vi.fn(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight -= 1;
          return { accessToken: 'at', revoked: false };
        }),
      });

      const summary = await renewDriveSubscriptions({ db, client, alert: vi.fn(), now: () => NOW, concurrency: 3 });
      expect(summary.renewed).toBe(10);
      expect(maxInFlight).toBeLessThanOrEqual(3);
    });
  });
});

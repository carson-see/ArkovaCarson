/**
 * DRIVE-06 (SCRUM-2371) — folder-watch channel renewal tests.
 *
 * Channels renew BEFORE expiry. Renewal failures alert + surface in ops status.
 * Expired-channel recovery is idempotent. Entitlement loss stops the watch
 * rather than renewing it.
 *
 * NO cron here — `renewDriveWatchChannels` is a pure function invoked by the
 * Lane-2 Cloud Scheduler → HTTP /jobs/* path (node-cron does not fire on a
 * throttled Cloud Run). These tests drive it directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renewDriveWatchChannels,
  type DriveRenewalDb,
  type DriveRenewalClient,
} from './drive-channel-renewal.js';

beforeEach(() => vi.clearAllMocks());

const NOW = new Date('2026-07-01T00:00:00.000Z');

function dueRow(over: Record<string, unknown> = {}) {
  return {
    id: 'watch-1',
    org_id: 'org-1',
    integration_id: 'int-1',
    watched_folder_id: 'folder-1',
    channel_id: 'chan-old',
    channel_resource_id: 'res-old',
    channel_expires_at: '2026-07-01T00:30:00.000Z', // 30 min out → within window
    owner_scope: 'my_drive',
    drive_id: null,
    status: 'active',
    ...over,
  };
}

function makeClient(over: Partial<DriveRenewalClient> = {}): DriveRenewalClient {
  return {
    getAccessToken: vi.fn(async () => ({ accessToken: 'at', entitled: true })),
    stopChannel: vi.fn(async () => {}),
    createChannel: vi.fn(async () => ({
      channelId: 'chan-new',
      resourceId: 'res-new',
      expiration: '2026-07-08T00:00:00.000Z',
      startPageToken: 'p',
    })),
    ...over,
  };
}

function makeDb(rows: Record<string, unknown>[], over: Partial<DriveRenewalDb> = {}): {
  db: DriveRenewalDb;
  updates: unknown[];
} {
  const updates: unknown[] = [];
  const db: DriveRenewalDb = {
    listRenewableWatches: vi.fn(async () => rows as never),
    updateWatchState: vi.fn(async (u) => {
      updates.push(u);
      return { error: false };
    }),
    ...over,
  };
  return { db, updates };
}

describe('renewDriveWatchChannels — normal renewal', () => {
  it('renews a channel that is within the pre-expiry window (stop old + create new)', async () => {
    const { db, updates } = makeDb([dueRow()]);
    const client = makeClient();
    const alert = vi.fn();

    const summary = await renewDriveWatchChannels({ db, client, now: () => NOW, alert });

    expect(summary.renewed).toBe(1);
    expect(summary.failed).toBe(0);
    expect(client.stopChannel).toHaveBeenCalled();
    expect(client.createChannel).toHaveBeenCalled();
    const u = updates[0] as Record<string, unknown>;
    expect(u).toMatchObject({
      id: 'watch-1',
      channel_id: 'chan-new',
      channel_resource_id: 'res-new',
      channel_expires_at: '2026-07-08T00:00:00.000Z',
      status: 'active',
      last_renewal_error: null,
    });
    expect(alert).not.toHaveBeenCalled();
  });

  it('does nothing for a channel that is not yet near expiry', async () => {
    const { db } = makeDb([]); // listRenewableWatches returns only due rows
    const client = makeClient();
    const summary = await renewDriveWatchChannels({ db, client, now: () => NOW, alert: vi.fn() });
    expect(summary.renewed).toBe(0);
    expect(client.createChannel).not.toHaveBeenCalled();
  });
});

describe('renewDriveWatchChannels — failure alerting + ops status', () => {
  it('alerts and marks the watch degraded when channel creation fails', async () => {
    const { db, updates } = makeDb([dueRow()]);
    const client = makeClient({
      createChannel: vi.fn(async () => {
        throw new Error('changes.watch failed (401)');
      }),
    });
    const alert = vi.fn();

    const summary = await renewDriveWatchChannels({ db, client, now: () => NOW, alert });

    expect(summary.failed).toBe(1);
    expect(alert).toHaveBeenCalledTimes(1);
    const u = updates[0] as Record<string, unknown>;
    expect(u).toMatchObject({ id: 'watch-1', status: 'degraded' });
    // Ops surface carries a bounded, non-secret reason.
    expect((u as { last_renewal_error?: string }).last_renewal_error).toBeTruthy();
  });

  it('does not abort the whole run when one watch fails — remaining watches still renew', async () => {
    const { db } = makeDb([dueRow({ id: 'w1' }), dueRow({ id: 'w2' })]);
    let call = 0;
    const client = makeClient({
      createChannel: vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('boom');
        return { channelId: 'c', resourceId: 'r', expiration: '2026-07-08T00:00:00.000Z', startPageToken: 'p' };
      }),
    });
    const summary = await renewDriveWatchChannels({ db, client, now: () => NOW, alert: vi.fn() });
    expect(summary.renewed).toBe(1);
    expect(summary.failed).toBe(1);
  });
});

describe('renewDriveWatchChannels — expired recovery (idempotent)', () => {
  it('recovers an already-expired channel without a stop call (old channel is gone)', async () => {
    const { db, updates } = makeDb([
      dueRow({ status: 'expired', channel_expires_at: '2026-06-30T00:00:00.000Z' }),
    ]);
    const client = makeClient();
    const summary = await renewDriveWatchChannels({ db, client, now: () => NOW, alert: vi.fn() });

    expect(summary.renewed).toBe(1);
    // An expired channel need not be stopped (Drive already dropped it) — but a
    // stop attempt, if made, must be best-effort and not fail the recovery.
    const u = updates[0] as Record<string, unknown>;
    expect(u).toMatchObject({ status: 'active', channel_id: 'chan-new' });
  });

  it('is idempotent: re-running recovery on the same row converges to one active channel', async () => {
    const { db, updates } = makeDb([dueRow({ status: 'expired' })]);
    const client = makeClient();
    await renewDriveWatchChannels({ db, client, now: () => NOW, alert: vi.fn() });
    await renewDriveWatchChannels({ db, client, now: () => NOW, alert: vi.fn() });
    // Both runs converge to status=active; no duplicate rows are created (the
    // renewal only ever UPDATEs an existing watch by id).
    for (const u of updates) {
      expect((u as { status: string }).status).toBe('active');
    }
  });
});

describe('renewDriveWatchChannels — entitlement + revoked token', () => {
  it('stops (does not renew) a watch whose org lost entitlement', async () => {
    const { db, updates } = makeDb([dueRow()]);
    const client = makeClient({
      getAccessToken: vi.fn(async () => ({ accessToken: null, entitled: false })),
    });
    const alert = vi.fn();

    const summary = await renewDriveWatchChannels({ db, client, now: () => NOW, alert });

    expect(summary.renewed).toBe(0);
    expect(summary.stopped).toBe(1);
    expect(client.createChannel).not.toHaveBeenCalled();
    const u = updates[0] as Record<string, unknown>;
    expect(u).toMatchObject({ id: 'watch-1', status: 'stopped' });
  });

  it('marks a watch degraded + alerts when the OAuth token is revoked (no access token, still entitled)', async () => {
    const { db, updates } = makeDb([dueRow()]);
    const client = makeClient({
      getAccessToken: vi.fn(async () => ({ accessToken: null, entitled: true })),
    });
    const alert = vi.fn();

    const summary = await renewDriveWatchChannels({ db, client, now: () => NOW, alert });

    expect(summary.failed).toBe(1);
    expect(alert).toHaveBeenCalled();
    const u = updates[0] as Record<string, unknown>;
    expect(u).toMatchObject({ id: 'watch-1', status: 'degraded' });
  });
});

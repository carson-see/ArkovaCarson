/**
 * GH #1835 — production-wiring tests for Drive subscription renewal.
 *
 * Real Supabase / Drive API / KMS are all mocked at the module boundary; no
 * network or Postgres traffic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadDriveAccessTokenMock = vi.fn();
const createChangesWatchMock = vi.fn();
const stopDriveChannelMock = vi.fn();
const captureMessageMock = vi.fn();

// PR #1944 review follow-up: WORKER_PUBLIC_URL is resolved through the
// Zod-validated `config` export (config.ts), not an ad-hoc process.env read
// in this file — mock `config` directly rather than mutating process.env.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: { workerPublicUrl: 'https://worker.example.com' as string | undefined },
}));
vi.mock('../config.js', () => ({ config: mockConfig }));

vi.mock('../utils/db.js', () => ({ db: {} }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@sentry/node', () => ({ captureMessage: (...args: unknown[]) => captureMessageMock(...args) }));
vi.mock('../integrations/oauth/drive.js', () => ({
  createChangesWatch: (...args: unknown[]) => createChangesWatchMock(...args),
  stopDriveChannel: (...args: unknown[]) => stopDriveChannelMock(...args),
}));
vi.mock('../integrations/oauth/crypto.js', () => ({
  createDefaultKmsClient: vi.fn(async () => ({ encrypt: vi.fn(), decrypt: vi.fn() })),
}));
vi.mock('../integrations/connectors/drive-changes-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../integrations/connectors/drive-changes-runner.js')>(
    '../integrations/connectors/drive-changes-runner.js',
  );
  return {
    ...actual,
    loadDriveAccessToken: (...args: unknown[]) => loadDriveAccessTokenMock(...args),
  };
});

// PR #1944 review correction: runDriveSubscriptionRenewal() tests want the
// REAL withRunLease/acquireRunLease logic (so the lease test has teeth) but
// a fully-controlled pure orchestrator — mock renewDriveSubscriptions only.
const renewDriveSubscriptionsMock = vi.fn();
vi.mock('../integrations/connectors/drive-subscription-renewal.js', async () => {
  const actual = await vi.importActual<typeof import('../integrations/connectors/drive-subscription-renewal.js')>(
    '../integrations/connectors/drive-subscription-renewal.js',
  );
  return {
    ...actual,
    renewDriveSubscriptions: (...args: unknown[]) => renewDriveSubscriptionsMock(...args),
  };
});

import { DriveRunnerError } from '../integrations/connectors/drive-changes-runner.js';
import { DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE } from './run-lease.js';
import { createRunLeaseStore } from './__tests__/__testHelpers.js';
import {
  makeDriveSubscriptionRenewalDb,
  makeDriveSubscriptionRenewalClient,
  alertDriveSubscriptionRenewal,
  runDriveSubscriptionRenewal,
} from './drive-subscription-renewal-deps.js';

const ORG = 'org-1';
const INT = 'int-1';

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.workerPublicUrl = 'https://worker.example.com';
});

function mockQuery(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.is = vi.fn().mockReturnValue(chain);
  chain.or = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(Promise.resolve(result));
  return chain;
}

describe('makeDriveSubscriptionRenewalDb', () => {
  it('listRenewableConnections filters provider=google_drive, revoked_at IS NULL, and expiring-or-never-registered', async () => {
    const chain = mockQuery({
      data: [{
        id: INT,
        org_id: ORG,
        subscription_id: 'chan-1',
        subscription_expires_at: '2026-08-04T00:00:00.000Z',
        account_label: JSON.stringify({ email: 'a@example.com' }),
        watch_renewal_failure_count: 0,
        encrypted_tokens: 'ct',
        token_kms_key_id: 'key-1',
        last_page_token: 'pt-1',
      }],
      error: null,
    });
    const from = vi.fn().mockReturnValue(chain);
    const dbDeps = makeDriveSubscriptionRenewalDb({ db: { from } });
    const rows = await dbDeps.listRenewableConnections({ now: '2026-08-03T00:00:00.000Z', horizonMs: 24 * 60 * 60 * 1000 });

    expect(from).toHaveBeenCalledWith('org_integrations');
    expect(chain.eq).toHaveBeenCalledWith('provider', 'google_drive');
    expect(chain.is).toHaveBeenCalledWith('revoked_at', null);
    expect(chain.or).toHaveBeenCalledWith(
      expect.stringContaining('subscription_id.is.null'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: INT, org_id: ORG, subscription_id: 'chan-1' });
  });

  it('throws on a DB error rather than silently returning an empty list', async () => {
    const chain = mockQuery({ data: null, error: { message: 'connection lost' } });
    const from = vi.fn().mockReturnValue(chain);
    const dbDeps = makeDriveSubscriptionRenewalDb({ db: { from } });
    await expect(
      dbDeps.listRenewableConnections({ now: '2026-08-03T00:00:00.000Z', horizonMs: 1000 }),
    ).rejects.toThrow(/drive_renewal_candidate_fetch_failed/);
  });

  it('updateConnection scopes the update by row id and returns error:false on success', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
    const from = vi.fn().mockReturnValue({ update: updateMock });
    const dbDeps = makeDriveSubscriptionRenewalDb({ db: { from } });

    const result = await dbDeps.updateConnection({
      id: INT,
      subscription_id: 'chan-new',
      subscription_expires_at: '2026-08-10T00:00:00.000Z',
      account_label: '{}',
      last_renewal_error: null,
      last_renewal_at: '2026-08-03T00:00:00.000Z',
      watch_renewal_failure_count: 0,
    });

    expect(result).toEqual({ error: false });
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ subscription_id: 'chan-new' }));
    // id must NOT appear inside the patch body — it's the .eq() filter.
    expect(updateMock.mock.calls[0][0]).not.toHaveProperty('id');
    expect(eqMock).toHaveBeenCalledWith('id', INT);
  });

  it('updateConnection returns error:true on a DB failure', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: { message: 'row locked' } });
    const from = vi.fn().mockReturnValue({ update: vi.fn().mockReturnValue({ eq: eqMock }) });
    const dbDeps = makeDriveSubscriptionRenewalDb({ db: { from } });
    const result = await dbDeps.updateConnection({
      id: INT,
      subscription_id: null,
      subscription_expires_at: null,
      account_label: null,
      last_renewal_error: 'x',
      last_renewal_at: '2026-08-03T00:00:00.000Z',
      watch_renewal_failure_count: 1,
    });
    expect(result).toEqual({ error: true });
  });
});

describe('makeDriveSubscriptionRenewalClient', () => {
  function row(over: Record<string, unknown> = {}) {
    return {
      id: INT,
      org_id: ORG,
      subscription_id: 'chan-1',
      subscription_expires_at: '2026-08-04T00:00:00.000Z',
      account_label: JSON.stringify({ email: 'a@example.com', resource_id: 'res-1' }),
      watch_renewal_failure_count: 0,
      encrypted_tokens: 'ct',
      token_kms_key_id: 'key-1',
      last_page_token: 'pt-1',
      ...over,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('getAccessToken decrypts/refreshes via loadDriveAccessToken and returns revoked:false', async () => {
    loadDriveAccessTokenMock.mockResolvedValueOnce({ accessToken: 'at-1', refreshed: false });
    const client = makeDriveSubscriptionRenewalClient({ db: { from: vi.fn() } });
    const result = await client.getAccessToken(row());
    expect(result).toEqual({ accessToken: 'at-1', revoked: false });
    expect(loadDriveAccessTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: INT, org_id: ORG, encrypted_tokens: 'ct', token_kms_key_id: 'key-1' }),
      expect.anything(),
    );
  });

  it('getAccessToken returns revoked:true without calling loadDriveAccessToken when the row has no encrypted tokens', async () => {
    const client = makeDriveSubscriptionRenewalClient({ db: { from: vi.fn() } });
    const result = await client.getAccessToken(row({ encrypted_tokens: null, token_kms_key_id: null }));
    expect(result).toEqual({ accessToken: null, revoked: true });
    expect(loadDriveAccessTokenMock).not.toHaveBeenCalled();
  });

  it('getAccessToken maps a DriveRunnerError(no_refresh_token) to revoked:true (permanent, reconnect required)', async () => {
    loadDriveAccessTokenMock.mockRejectedValueOnce(new DriveRunnerError('no_refresh_token', 'no refresh_token stored'));
    const client = makeDriveSubscriptionRenewalClient({ db: { from: vi.fn() } });
    const result = await client.getAccessToken(row());
    expect(result).toEqual({ accessToken: null, revoked: true });
  });

  it('getAccessToken rethrows any OTHER error (transient failure, retry on next sweep) rather than mis-classifying it as revoked', async () => {
    loadDriveAccessTokenMock.mockRejectedValueOnce(new DriveRunnerError('token_persist_failed', 'CAS write failed'));
    const client = makeDriveSubscriptionRenewalClient({ db: { from: vi.fn() } });
    await expect(client.getAccessToken(row())).rejects.toThrow('CAS write failed');
  });

  it('stopChannel no-ops when resourceId is null (never bootstrapped)', async () => {
    const client = makeDriveSubscriptionRenewalClient({ db: { from: vi.fn() } });
    await client.stopChannel({ accessToken: 'at', channelId: 'chan-1', resourceId: null });
    expect(stopDriveChannelMock).not.toHaveBeenCalled();
  });

  it('stopChannel calls stopDriveChannel with the accessToken/channelId/resourceId', async () => {
    const client = makeDriveSubscriptionRenewalClient({ db: { from: vi.fn() } });
    await client.stopChannel({ accessToken: 'at', channelId: 'chan-1', resourceId: 'res-1' });
    expect(stopDriveChannelMock).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'at', channelId: 'chan-1', resourceId: 'res-1' }),
    );
  });

  it('createChannel registers a fresh watch at the canonical webhook path with the NEW channel token, discarding startPageToken', async () => {
    createChangesWatchMock.mockResolvedValueOnce({
      resourceId: 'res-2',
      expiration: '2026-08-10T00:00:00.000Z',
      startPageToken: 'DANGEROUS-if-persisted',
    });
    const client = makeDriveSubscriptionRenewalClient({ db: { from: vi.fn() } });
    const result = await client.createChannel({ accessToken: 'at', channelId: 'chan-new', channelToken: 'tok-new' });

    expect(result).toEqual({ resourceId: 'res-2', expiration: '2026-08-10T00:00:00.000Z' });
    expect(result).not.toHaveProperty('startPageToken');
    expect(createChangesWatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'at',
        channelId: 'chan-new',
        address: 'https://worker.example.com/api/v1/webhooks/drive',
        token: 'tok-new',
      }),
    );
  });

  it('createChannel fails closed when config.workerPublicUrl is unset', async () => {
    mockConfig.workerPublicUrl = undefined;
    const client = makeDriveSubscriptionRenewalClient({ db: { from: vi.fn() } });
    await expect(
      client.createChannel({ accessToken: 'at', channelId: 'chan-new', channelToken: 'tok-new' }),
    ).rejects.toThrow(/WORKER_PUBLIC_URL/);
    expect(createChangesWatchMock).not.toHaveBeenCalled();
  });

  it('createChannel honors an explicit workerPublicUrl DI override over config.workerPublicUrl', async () => {
    mockConfig.workerPublicUrl = 'https://config-value.example.com';
    createChangesWatchMock.mockResolvedValueOnce({
      resourceId: 'res-3',
      expiration: '2026-08-10T00:00:00.000Z',
      startPageToken: 'ignored',
    });
    const client = makeDriveSubscriptionRenewalClient({
      db: { from: vi.fn() },
      workerPublicUrl: 'https://override.example.com',
    });
    await client.createChannel({ accessToken: 'at', channelId: 'chan-new', channelToken: 'tok-new' });
    expect(createChangesWatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'https://override.example.com/api/v1/webhooks/drive' }),
    );
  });
});

describe('alertDriveSubscriptionRenewal', () => {
  it('captures a warning-level Sentry message for token_revoked', () => {
    alertDriveSubscriptionRenewal({ integrationId: INT, orgId: ORG, kind: 'token_revoked', reason: 'reconnect required' });
    expect(captureMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('token_revoked'),
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('captures an error-level Sentry message for renewal_failed', () => {
    alertDriveSubscriptionRenewal({ integrationId: INT, orgId: ORG, kind: 'renewal_failed', reason: 'changes.watch 500' });
    expect(captureMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('renewal_failed'),
      expect.objectContaining({ level: 'error' }),
    );
  });

  it('never throws even if Sentry itself throws', () => {
    captureMessageMock.mockImplementationOnce(() => { throw new Error('sentry down'); });
    expect(() =>
      alertDriveSubscriptionRenewal({ integrationId: INT, orgId: ORG, kind: 'renewal_failed', reason: 'x' }),
    ).not.toThrow();
  });
});

// PR #1944 review correction: renewDriveSubscriptions() is now ONLY ever
// invoked through this lease-guarded entry point — both routes/cron.ts's
// Cloud Scheduler route and routes/scheduled.ts's in-process backup call
// runDriveSubscriptionRenewal() directly, never renewDriveSubscriptions()
// itself. These tests exercise the REAL withRunLease/acquireRunLease logic
// (createRunLeaseStore evaluates the actual CAS predicate the code emits,
// not a restated one — see __testHelpers.ts) against a mocked pure
// orchestrator, so the lease assertions have teeth.
describe('runDriveSubscriptionRenewal (lease-guarded entry point, PR #1944 correction)', () => {
  beforeEach(() => {
    renewDriveSubscriptionsMock.mockReset();
  });

  it('acquires the lease and runs the sweep, returning its summary unchanged', async () => {
    const store = createRunLeaseStore(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, 'free');
    renewDriveSubscriptionsMock.mockResolvedValueOnce({ scanned: 3, renewed: 2, degraded: 0, failed: 1 });

    const result = await runDriveSubscriptionRenewal({ db: store.client });

    expect(result).toEqual({ scanned: 3, renewed: 2, degraded: 0, failed: 1 });
    expect(renewDriveSubscriptionsMock).toHaveBeenCalledTimes(1);
  });

  it('returns skipped:true with a zeroed summary when the lease is already held by another instance', async () => {
    const store = createRunLeaseStore(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, {
      held: { holder: 'other-instance:999:nonce', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    renewDriveSubscriptionsMock.mockResolvedValueOnce({ scanned: 99, renewed: 99, degraded: 0, failed: 0 });

    const result = await runDriveSubscriptionRenewal({ db: store.client });

    expect(result).toEqual({ scanned: 0, renewed: 0, degraded: 0, failed: 0, skipped: true });
    // The whole point: the sweep body never ran.
    expect(renewDriveSubscriptionsMock).not.toHaveBeenCalled();
  });

  // The exact scenario PR #1944 review round 3 flagged: Cloud Scheduler and
  // the in-process backup both firing. Both call THIS function — proving
  // concurrent invocation runs the body exactly once proves the double-fire
  // race is closed regardless of which trigger fires first.
  it('CRITICAL: concurrent invocation (Cloud Scheduler racing the in-process backup) runs the sweep body EXACTLY ONCE', async () => {
    const store = createRunLeaseStore(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, 'free');
    renewDriveSubscriptionsMock.mockResolvedValue({ scanned: 1, renewed: 1, degraded: 0, failed: 0 });

    const [first, second] = await Promise.all([
      runDriveSubscriptionRenewal({ db: store.client }),
      runDriveSubscriptionRenewal({ db: store.client }),
    ]);

    expect(renewDriveSubscriptionsMock).toHaveBeenCalledTimes(1);
    const results = [first, second];
    expect(results.filter((r) => r.skipped)).toHaveLength(1);
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
  });

  it('a store/CAS failure fails closed to skipped (never runs the sweep on an unverifiable lease)', async () => {
    // Simulate a broken store: every `.from()` call throws.
    const brokenClient = {
      from: () => { throw new Error('PostgREST unreachable'); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    renewDriveSubscriptionsMock.mockResolvedValueOnce({ scanned: 1, renewed: 1, degraded: 0, failed: 0 });

    const result = await runDriveSubscriptionRenewal({ db: brokenClient });

    expect(result.skipped).toBe(true);
    expect(renewDriveSubscriptionsMock).not.toHaveBeenCalled();
  });
});

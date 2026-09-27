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
const runDriveFolderReconciliationMock = vi.fn();

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
// Fix-round item 3, second half: runDriveReconciliationSweep is mocked so
// the wiring test below is deterministic — the sweep's own scan/invoke
// logic is covered independently in drive-changes-runner.test.ts.
const runDriveReconciliationSweepMock = vi.fn();
vi.mock('../integrations/connectors/drive-changes-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../integrations/connectors/drive-changes-runner.js')>(
    '../integrations/connectors/drive-changes-runner.js',
  );
  return {
    ...actual,
    loadDriveAccessToken: (...args: unknown[]) => loadDriveAccessTokenMock(...args),
    runDriveReconciliationSweep: (...args: unknown[]) => runDriveReconciliationSweepMock(...args),
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
vi.mock('../integrations/connectors/drive-folder-reconciliation.js', () => ({
  DRIVE_FOLDER_RECONCILIATION_RUN_BUDGET_MS: 8 * 60_000,
  DriveFolderReconciliationError: class DriveFolderReconciliationError extends Error {
    constructor(public readonly summary: unknown) { super('drive folder reconciliation failed'); }
  },
  runDriveFolderReconciliation: (...args: unknown[]) => runDriveFolderReconciliationMock(...args),
}));

import { DriveRunnerError } from '../integrations/connectors/drive-changes-runner.js';
import { DriveFolderReconciliationError } from '../integrations/connectors/drive-folder-reconciliation.js';
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

  // BUG 2026-09-13: the sweep decides whether to bootstrap by reading
  // `conn.last_page_token`. If the column ever falls out of the select list,
  // that check reads `undefined` — indistinguishable from NULL — and the
  // sweep would clobber a LIVE cursor on every renewal. The select list and
  // the mapped row are both pinned here.
  it('selects last_page_token and surfaces it on the mapped row (the bootstrap null-check depends on it)', async () => {
    const chain = mockQuery({
      data: [{
        id: INT,
        org_id: ORG,
        subscription_id: 'chan-1',
        subscription_expires_at: '2026-08-04T00:00:00.000Z',
        account_label: null,
        watch_renewal_failure_count: 0,
        encrypted_tokens: 'ct',
        token_kms_key_id: 'key-1',
        last_page_token: 'pt-live',
      }],
      error: null,
    });
    const from = vi.fn().mockReturnValue(chain);
    const dbDeps = makeDriveSubscriptionRenewalDb({ db: { from } });
    const rows = await dbDeps.listRenewableConnections({ now: '2026-08-03T00:00:00.000Z', horizonMs: 1000 });

    expect(chain.select).toHaveBeenCalledWith(expect.stringContaining('last_page_token'));
    expect(rows[0].last_page_token).toBe('pt-live');
  });

  it('a NULL last_page_token stays null on the mapped row (never coerced to a falsy-but-present default)', async () => {
    const chain = mockQuery({
      data: [{
        id: INT,
        org_id: ORG,
        subscription_id: null,
        subscription_expires_at: null,
        account_label: null,
        watch_renewal_failure_count: null,
        encrypted_tokens: 'ct',
        token_kms_key_id: 'key-1',
        last_page_token: null,
      }],
      error: null,
    });
    const dbDeps = makeDriveSubscriptionRenewalDb({ db: { from: vi.fn().mockReturnValue(chain) } });
    const rows = await dbDeps.listRenewableConnections({ now: '2026-08-03T00:00:00.000Z', horizonMs: 1000 });
    expect(rows[0].last_page_token).toBeNull();
  });

  it('updateConnection forwards an optional last_page_token/last_token_advanced_at patch unchanged (bootstrap write)', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
    const from = vi.fn().mockReturnValue({ update: updateMock });
    const dbDeps = makeDriveSubscriptionRenewalDb({ db: { from } });

    const res = await dbDeps.updateConnection({
      id: INT,
      subscription_id: 'chan-new',
      subscription_expires_at: '2026-08-10T00:00:00.000Z',
      account_label: null,
      last_renewal_error: null,
      last_renewal_at: '2026-08-03T00:00:00.000Z',
      watch_renewal_failure_count: 0,
      last_page_token: 'stp-1',
      last_token_advanced_at: '2026-08-03T00:00:00.000Z',
    });

    expect(res).toEqual({ error: false });
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ last_page_token: 'stp-1', last_token_advanced_at: '2026-08-03T00:00:00.000Z' }),
    );
    expect(eqMock).toHaveBeenCalledWith('id', INT);
  });

  // CTO review 2026-09-13 (PR #2903, focus item 1 — TOCTOU): the bootstrap
  // decision ("is this cursor null?") is made in the PURE module from the row
  // snapshot `listRenewableConnections` returned at the START of the sweep,
  // not re-validated against the row's CURRENT state at write time. This test
  // pins that the adapter's `updateConnection` issues an unconditional
  // `UPDATE ... SET last_page_token = X WHERE id = Y` — no
  // `WHERE last_page_token IS NULL` compare-and-swap guard. Given the current
  // architecture this is provably NOT exploitable by
  // `drive-changes-processor.ts` (`runDriveChanges` refuses to run at all
  // without an already-non-null cursor — see drive-changes-runner.ts's
  // bootstrap guard — so the processor can never be the one that populates a
  // null cursor out from under a concurrent renewal). It COULD race
  // `drive-oauth.ts`'s reconnect callback, which unconditionally re-seeds
  // `last_page_token` from its own fresh `startPageToken` on every successful
  // re-watch (upsert, not gated on the prior value) — a pre-existing writer
  // this PR does not touch. Flagged as a follow-up, not fixed here: closing it
  // requires a CAS-guarded write, and the renewal's `subscription_id` /
  // `account_label` fields already carry the identical stale-snapshot
  // exposure today, independent of this PR's two new columns — a narrower fix
  // scoped to `last_page_token` alone would not close the real gap.
  it('updateConnection has no compare-and-swap guard — the write is unconditional on row id alone (TOCTOU note, see comment)', async () => {
    const eqMock = vi.fn().mockResolvedValue({ error: null });
    const updateMock = vi.fn().mockReturnValue({ eq: eqMock });
    const from = vi.fn().mockReturnValue({ update: updateMock });
    const dbDeps = makeDriveSubscriptionRenewalDb({ db: { from } });

    await dbDeps.updateConnection({
      id: INT,
      subscription_id: 'chan-new',
      subscription_expires_at: '2026-08-10T00:00:00.000Z',
      account_label: null,
      last_renewal_error: null,
      last_renewal_at: '2026-08-03T00:00:00.000Z',
      watch_renewal_failure_count: 0,
      last_page_token: 'stp-from-this-sweeps-watch',
      last_token_advanced_at: '2026-08-03T00:00:00.000Z',
    });

    // The only filter on the update chain is `.eq('id', ...)`. No `.is(
    // 'last_page_token', null)` or any other current-state guard is applied
    // — if another writer populated the row's cursor between the sweep's
    // SELECT and this UPDATE, this write still lands and clobbers it.
    expect(from).toHaveBeenCalledWith('org_integrations');
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(eqMock).toHaveBeenCalledTimes(1);
    expect(eqMock).toHaveBeenCalledWith('id', INT);
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

  // BUG 2026-09-13: this adapter used to DROP the startPageToken, and this
  // test used to assert that dropping as a feature. That is precisely what
  // left the prod connection's null cursor unbootstrappable — the sweep can
  // only bootstrap a value it is handed. The adapter now threads it through;
  // the decision to write it (null cursor only) stays in the pure module.
  it('createChannel registers a fresh watch at the canonical webhook path with the NEW channel token, threading startPageToken back to the sweep', async () => {
    createChangesWatchMock.mockResolvedValueOnce({
      resourceId: 'res-2',
      expiration: '2026-08-10T00:00:00.000Z',
      startPageToken: 'stp-1',
    });
    const client = makeDriveSubscriptionRenewalClient({ db: { from: vi.fn() } });
    const result = await client.createChannel({ accessToken: 'at', channelId: 'chan-new', channelToken: 'tok-new' });

    expect(result).toEqual({
      resourceId: 'res-2',
      expiration: '2026-08-10T00:00:00.000Z',
      startPageToken: 'stp-1',
    });
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
    runDriveReconciliationSweepMock.mockReset();
    runDriveReconciliationSweepMock.mockResolvedValue({ scanned: 0, ran: 0, skipped: 0, errored: 0 });
    runDriveFolderReconciliationMock.mockReset();
    runDriveFolderReconciliationMock.mockResolvedValue({
      candidates: 0, page: 0, pages: 1, scanned: 0, eligible: 0,
      created: 0, existing: 0, skipped: 0, errored: 0, invalid: 0, needsAdminRepair: 0, deadlineExceeded: false,
    });
  });

  it('acquires the lease and runs the sweep, returning its summary plus the reconciliation result', async () => {
    const store = createRunLeaseStore(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, 'free');
    renewDriveSubscriptionsMock.mockResolvedValueOnce({ scanned: 3, renewed: 2, degraded: 0, failed: 1 });

    const result = await runDriveSubscriptionRenewal({ db: store.client });

    expect(result).toEqual({
      scanned: 3, renewed: 2, degraded: 0, failed: 1,
      reconciliation: { scanned: 0, ran: 0, skipped: 0, errored: 0 },
      folderReconciliation: {
        candidates: 0, page: 0, pages: 1, scanned: 0, eligible: 0,
        created: 0, existing: 0, skipped: 0, errored: 0, invalid: 0, needsAdminRepair: 0, deadlineExceeded: false,
      },
    });
    expect(renewDriveSubscriptionsMock).toHaveBeenCalledTimes(1);
  });

  // Fix-round item 3, second half: the periodic reconciliation backstop —
  // a webhook proves delivery, not completeness.
  describe('reconciliation sweep wiring', () => {
    it('runs the reconciliation sweep in the SAME lease-held pass, after renewal, and merges its result', async () => {
      const store = createRunLeaseStore(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, 'free');
      renewDriveSubscriptionsMock.mockResolvedValueOnce({ scanned: 5, renewed: 5, degraded: 0, failed: 0 });
      runDriveReconciliationSweepMock.mockResolvedValueOnce({ scanned: 2, ran: 1, skipped: 1, errored: 0 });

      const result = await runDriveSubscriptionRenewal({ db: store.client });

      expect(runDriveReconciliationSweepMock).toHaveBeenCalledTimes(1);
      expect(result.reconciliation).toEqual({ scanned: 2, ran: 1, skipped: 1, errored: 0 });
    });

    it('a thrown reconciliation sweep does NOT lose the renewal summary — failure-isolated', async () => {
      const store = createRunLeaseStore(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, 'free');
      renewDriveSubscriptionsMock.mockResolvedValueOnce({ scanned: 4, renewed: 3, degraded: 1, failed: 0 });
      runDriveReconciliationSweepMock.mockRejectedValueOnce(new Error('reconciliation exploded'));

      const result = await runDriveSubscriptionRenewal({ db: store.client });

      expect(result).toMatchObject({ scanned: 4, renewed: 3, degraded: 1, failed: 0 });
      expect(result.reconciliation).toBeUndefined();
    });

    it('when the renewal lease is held elsewhere, the reconciliation sweep never runs either', async () => {
      const store = createRunLeaseStore(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, {
        held: { holder: 'other-instance:1:nonce', expiresAt: new Date(Date.now() + 60_000).toISOString() },
      });

      await runDriveSubscriptionRenewal({ db: store.client });

      expect(runDriveReconciliationSweepMock).not.toHaveBeenCalled();
      expect(runDriveFolderReconciliationMock).not.toHaveBeenCalled();
    });

    it('runs folder recovery even when renewal throws, then rethrows so the scheduler observes failure', async () => {
      const store = createRunLeaseStore(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, 'free');
      renewDriveSubscriptionsMock.mockRejectedValueOnce(new Error('renewal database unavailable'));

      await expect(runDriveSubscriptionRenewal({ db: store.client })).rejects.toThrow('renewal database unavailable');

      expect(runDriveReconciliationSweepMock).toHaveBeenCalledTimes(1);
      expect(runDriveFolderReconciliationMock).toHaveBeenCalledTimes(1);
    });

    it('surfaces a folder-scan failure after the other reconciliation pass runs', async () => {
      const store = createRunLeaseStore(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, 'free');
      renewDriveSubscriptionsMock.mockResolvedValueOnce({ scanned: 0, renewed: 0, degraded: 0, failed: 0 });
      runDriveFolderReconciliationMock.mockRejectedValueOnce(new Error('rule scan unavailable'));

      await expect(runDriveSubscriptionRenewal({ db: store.client })).rejects.toThrow('rule scan unavailable');

      expect(runDriveReconciliationSweepMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a folder reconciliation aggregate carrying partial counters', async () => {
      const store = createRunLeaseStore(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE, 'free');
      renewDriveSubscriptionsMock.mockResolvedValueOnce({ scanned: 0, renewed: 0, degraded: 0, failed: 0 });
      const aggregate = new DriveFolderReconciliationError({
        candidates: 2, page: 0, pages: 1, scanned: 2, eligible: 2,
        created: 1, existing: 0, skipped: 0, errored: 1, invalid: 0, needsAdminRepair: 0, deadlineExceeded: false,
      });
      runDriveFolderReconciliationMock.mockRejectedValueOnce(aggregate);

      await expect(runDriveSubscriptionRenewal({ db: store.client })).rejects.toBe(aggregate);
      expect(runDriveReconciliationSweepMock).toHaveBeenCalledTimes(1);
    });
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

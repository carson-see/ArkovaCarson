/**
 * SCRUM-3031: `processPublicRecordAnchoring` is WIRED to the cross-instance run
 * lease.
 *
 * The lease PRIMITIVE — compare-and-set predicate, TTL bounds, holder nonce,
 * fail-closed behaviour — is pinned in `run-lease.test.ts`. This file pins only
 * the wiring, which the primitive's own suite cannot see: without these tests,
 * deleting the `withRunLease` call from this job would leave every lease test
 * green while restoring the exact production overlap.
 *
 * OBSERVED IN PRODUCTION 2026-08-01 (Cloud Run `arkova-worker`, revision
 * 01164-xux). `anchor-public-records` is scheduled every 10 minutes; a run that
 * exceeds the Cloud Scheduler attempt deadline is abandoned by the scheduler
 * but keeps executing server-side, so the next tick starts a SECOND run on a
 * different instance:
 *
 *   19:12:27Z  "Creating individual anchors" recordCount=10000  instance …72908
 *   19:22:26Z  "Creating individual anchors" recordCount=10000  instance …72963
 *
 * Both runs selected the SAME 10,000 unlinked records. The row-lock contention
 * pushed each 1,000-row chunk past its 20s client deadline into the serial
 * fallback, so the backlog did not move (405,376 before and after three
 * consecutive runs).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config.js', () => ({
  config: {
    logLevel: 'info',
    nodeEnv: 'test',
    useMocks: true,
    enableProdNetworkAnchoring: false,
    bitcoinNetwork: 'signet',
    batchAnchorMaxSize: 10_000,
  },
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));

vi.mock('../../utils/db.js', () => ({
  db: {},
  withDbTimeout: vi.fn((operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../chain/client.js', () => ({
  getInitializedChainClient: () => ({ submitFingerprint: vi.fn() }),
  getChainClientAsync: () => Promise.resolve({ submitFingerprint: vi.fn() }),
}));

import { PUBLIC_RECORD_ANCHOR_RUN_LEASE } from '../run-lease.js';
import { processPublicRecordAnchoring } from '../publicRecordAnchor.js';
import { createRunLeaseStore } from './__testHelpers.js';

const EMPTY = {
  processed: 0,
  anchorsCreated: 0,
  batchId: null,
  merkleRoot: null,
  txId: null,
};

/** `get_flag` on, so the enablement gate never masks a lease result. */
const enabledRpc = () =>
  vi.fn(async (name: string) =>
    name === 'get_flag' ? { data: true, error: null } : { data: null, error: null },
  );

describe('public-record anchoring is guarded by the shared run lease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does no pipeline work when another instance holds the lease', async () => {
    const profileSelect = vi.fn(() => ({
      eq: vi.fn(() => ({
        single: vi.fn(async () => ({ data: { id: 'admin', org_id: 'org' }, error: null })),
      })),
    }));
    const publicRecordsSelect = vi.fn(() => {
      throw new Error('public_records must not be read while another instance holds the lease');
    });

    // Lease permanently held by someone else: the CAS UPDATE matches no row.
    const held = createRunLeaseStore(PUBLIC_RECORD_ANCHOR_RUN_LEASE, {
      held: { holder: 'other-instance', expiresAt: '2099-01-01T00:00:00Z' },
    });
    const client = {
      rpc: enabledRpc(),
      from: (table: string) => {
        if (table === 'job_queue') return held.from(table);
        if (table === 'profiles') return { select: profileSelect };
        return { select: publicRecordsSelect };
      },
    } as unknown as Parameters<typeof processPublicRecordAnchoring>[0];

    expect(await processPublicRecordAnchoring(client)).toEqual(EMPTY);
    expect(publicRecordsSelect).not.toHaveBeenCalled();
    expect(profileSelect).not.toHaveBeenCalled();
    expect(held.current()?.payload.holder).toBe('other-instance');
  });

  it('releases the lease when the run throws', async () => {
    const store = createRunLeaseStore(PUBLIC_RECORD_ANCHOR_RUN_LEASE, 'free');
    const client = {
      rpc: enabledRpc(),
      from: (table: string) => {
        if (table === 'job_queue') return store.from(table);
        // profiles lookup explodes — the run must still give the lease back.
        return {
          select: () => ({
            eq: () => ({
              single: async () => {
                throw new Error('profiles exploded');
              },
            }),
          }),
        };
      },
    } as unknown as Parameters<typeof processPublicRecordAnchoring>[0];

    await expect(processPublicRecordAnchoring(client)).rejects.toThrow('profiles exploded');
    expect(store.current()?.status).toBe('completed');
    expect(store.current()?.scheduled_for).toBeNull();
  });

  /**
   * The lease is claimed AFTER the enablement gate on purpose: a disabled
   * pipeline should not write lease rows on every cron tick just to discover it
   * has nothing to do.
   */
  it('does not touch the lease row when the pipeline is disabled', async () => {
    const store = createRunLeaseStore(PUBLIC_RECORD_ANCHOR_RUN_LEASE, 'free');
    const client = {
      rpc: vi.fn(async (name: string) =>
        name === 'get_flag' ? { data: false, error: null } : { data: null, error: null },
      ),
      from: (table: string) => {
        if (table === 'job_queue') return store.from(table);
        throw new Error('no table should be read when the pipeline is disabled');
      },
    } as unknown as Parameters<typeof processPublicRecordAnchoring>[0];

    expect(await processPublicRecordAnchoring(client)).toEqual(EMPTY);
    expect(store.callCount()).toBe(0);
  });
});

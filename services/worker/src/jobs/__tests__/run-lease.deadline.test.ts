/**
 * F-D0-5 (fullsoak 2026-08-12, day0-bl2-secured-e2e-evidence.md §2.6a/§4):
 * the run lease could keep a HUNG run alive forever.
 *
 * Observed live on the fullsoak rig (revision …-00012-f45, prod image digest):
 * a `check-confirmations` run parked on an awaited provider response at
 * 14:16:00Z and never finished. Its heartbeat kept renewing the lease exactly
 * on schedule (ttl/3 apart), so the TTL never expired; `withRunLease`'s
 * `finally` — the only place the lease is released — was never reached; and
 * the per-process `inFlight` short-circuit blocked every later local
 * invocation before the store was even consulted. 31 forced POSTs over 29
 * minutes all returned `{"checked":0,"confirmed":0}` while SUBMITTED→SECURED
 * promotion was disabled for every tenant, with zero warn/error logs.
 *
 * Two properties close that hole, and this file pins both:
 *
 *   1. THE BODY IS BOUNDED, NOT JUST THE LEASE. `withRunLease` races the body
 *      against a `maxRunMs` deadline; on expiry the heartbeat stops, the lease
 *      is released, the in-process guard is freed, and the caller gets a
 *      typed error instead of silence.
 *   2. BLOCKED RUNS ARE OBSERVABLE. A lease that stays unavailable for longer
 *      than a full TTL across repeated skips means renewals are keeping an
 *      overrunning holder alive — exactly the F-D0-5 signature — and warrants
 *      a warn-level log, since each individual skip is indistinguishable from
 *      healthy overlap.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));
// SCRUM-1258: run-lease.ts reads the Cloud Run revision via the Zod-validated
// `config` export; config.ts throws outside a fully-configured worker, so
// tests mock it — the established pattern in this directory.
vi.mock('../../config.js', () => ({
  config: { logLevel: 'info', nodeEnv: 'test', kRevision: 'arkova-worker-fullsoak-00012-f45' },
}));

import {
  BATCH_ANCHOR_RUN_LEASE,
  CHECK_CONFIRMATIONS_RUN_LEASE,
  PUBLIC_RECORD_ANCHOR_RUN_LEASE,
  RUN_LEASE_SPECS,
  RunLeaseBodyTimeoutError,
  acquireRunLease,
  resetRunLeaseSkipTrackingForTests,
  withRunLease,
} from '../run-lease.js';
import { createRunLeaseStore } from './__testHelpers.js';

const SPEC = PUBLIC_RECORD_ANCHOR_RUN_LEASE;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The prod failure mode: a body that never settles. */
const parkedBody = (): Promise<never> => new Promise<never>(() => {});

describe('run body deadline (F-D0-5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunLeaseSkipTrackingForTests();
  });

  it('completes a body that finishes under the deadline exactly as before', async () => {
    const fastSpec = { ...SPEC, ttlMs: 60, maxRunMs: 200 };
    const store = createRunLeaseStore(fastSpec, 'free');

    const outcome = await withRunLease({ ...fastSpec, client: store.client }, async () => 'done');

    expect(outcome).toEqual({ acquired: true, result: 'done' });
    expect(store.current()?.status).toBe('completed');
  });

  it('times out a hung body at maxRunMs, releases the lease, and lets a competitor claim', async () => {
    const fastSpec = { ...SPEC, ttlMs: 60, maxRunMs: 90 };
    const store = createRunLeaseStore(fastSpec, 'free');

    await expect(
      withRunLease({ ...fastSpec, client: store.client }, () => parkedBody()),
    ).rejects.toThrow(RunLeaseBodyTimeoutError);

    // Released — not left `processing` with a renewed TTL, which is the state
    // the prod incident was stuck in.
    expect(store.current()?.status).toBe('completed');
    expect(store.current()?.scheduled_for).toBeNull();

    // The very next tick — on ANY instance — can now claim the lease.
    expect(await acquireRunLease(store.client, fastSpec, 'competitor', new Date())).toBe(true);
  });

  it('stops the heartbeat when the deadline fires, instead of renewing a dead run forever', async () => {
    const fastSpec = { ...SPEC, ttlMs: 60, maxRunMs: 90 }; // heartbeat every 20ms
    const store = createRunLeaseStore(fastSpec, 'free');

    await expect(
      withRunLease({ ...fastSpec, client: store.client }, () => parkedBody()),
    ).rejects.toThrow(RunLeaseBodyTimeoutError);

    const callsAtTimeout = store.callCount();
    await sleep(120); // ≥6 heartbeat periods — a live heartbeat would show up here
    expect(store.callCount()).toBe(callsAtTimeout);
  });

  it('frees the in-process guard after a timeout so the next local tick can run (self-block fix)', async () => {
    // Mechanism 2 of F-D0-5: the holding instance also blocked ITSELF, because
    // `inFlight` is checked before the store. The deadline must clear it.
    const fastSpec = { ...SPEC, ttlMs: 60, maxRunMs: 90 };
    const store = createRunLeaseStore(fastSpec, 'free');

    await expect(
      withRunLease({ ...fastSpec, client: store.client }, () => parkedBody()),
    ).rejects.toThrow(RunLeaseBodyTimeoutError);

    const second = await withRunLease({ ...fastSpec, client: store.client }, async () => 'recovered');
    expect(second).toEqual({ acquired: true, result: 'recovered' });
  });

  it('logs the timeout at error level — the incident produced ZERO logs', async () => {
    const fastSpec = { ...SPEC, ttlMs: 60, maxRunMs: 90 };
    const store = createRunLeaseStore(fastSpec, 'free');

    await expect(
      withRunLease({ ...fastSpec, client: store.client }, () => parkedBody()),
    ).rejects.toThrow(RunLeaseBodyTimeoutError);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ lease: fastSpec.label, maxRunMs: fastSpec.maxRunMs }),
      expect.stringContaining('deadline'),
    );
  });

  it('observes a timed-out body that settles later, so it cannot become an unhandled rejection', async () => {
    const fastSpec = { ...SPEC, ttlMs: 60, maxRunMs: 90 };
    const store = createRunLeaseStore(fastSpec, 'free');
    let rejectLate!: (error: Error) => void;

    await expect(
      withRunLease(
        { ...fastSpec, client: store.client },
        () => new Promise<never>((_, reject) => { rejectLate = reject; }),
      ),
    ).rejects.toThrow(RunLeaseBodyTimeoutError);

    // The zombie thaws and fails long after the deadline. Vitest fails the run
    // on an unhandled rejection, so surviving this IS the core assertion.
    rejectLate(new Error('provider socket died much later'));
    await sleep(20);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ lease: fastSpec.label }),
      expect.stringContaining('after its deadline'),
    );
  });
});

describe('run lease skip observability (F-D0-5 / F-D0-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunLeaseSkipTrackingForTests();
  });

  it('warns once skips have persisted longer than a full TTL — but not on healthy overlap', async () => {
    const fastSpec = { ...SPEC, ttlMs: 100, maxRunMs: 200 };
    const store = createRunLeaseStore(fastSpec, {
      held: { holder: 'hung-holder', expiresAt: '2099-01-01T00:00:00Z' },
    });

    // A few skips inside one TTL window is what a healthy long run on another
    // instance looks like — that must NOT alarm.
    for (let i = 0; i < 3; i++) {
      await withRunLease({ ...fastSpec, client: store.client }, async () => 'never runs');
    }
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('continuously unavailable'),
    );

    // …but a streak that outlives a full TTL means renewals are keeping an
    // overrunning holder alive. That is the F-D0-5 signature.
    await sleep(130);
    await withRunLease({ ...fastSpec, client: store.client }, async () => 'never runs');

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ lease: fastSpec.label, consecutiveSkips: 4 }),
      expect.stringContaining('continuously unavailable'),
    );
  });

  it('resets the streak after a successful acquisition', async () => {
    const fastSpec = { ...SPEC, ttlMs: 200, maxRunMs: 400 };
    const store = createRunLeaseStore(fastSpec, {
      held: { holder: 'hung-holder', expiresAt: '2099-01-01T00:00:00Z' },
    });

    for (let i = 0; i < 3; i++) {
      await withRunLease({ ...fastSpec, client: store.client }, async () => 'never runs');
    }
    await sleep(220);
    await withRunLease({ ...fastSpec, client: store.client }, async () => 'never runs');
    const warnsAfterStreak = mockLogger.warn.mock.calls.filter(
      ([, message]) => typeof message === 'string' && message.includes('continuously unavailable'),
    ).length;
    expect(warnsAfterStreak).toBeGreaterThan(0);

    // The hung holder finally lets go, a run succeeds, and the streak resets:
    // a NEW short streak must not inherit the old first-skip timestamp. The
    // streak is keyed per lease id, not per store, so switching to a fresh
    // free store continues the same streak bookkeeping.
    const freed = createRunLeaseStore(fastSpec, 'free');
    await withRunLease({ ...fastSpec, client: freed.client }, async () => 'ok');

    await acquireRunLease(freed.client, fastSpec, 'new-holder', new Date());
    for (let i = 0; i < 3; i++) {
      await withRunLease({ ...fastSpec, client: freed.client }, async () => 'never runs');
    }
    const warnsAfterReset = mockLogger.warn.mock.calls.filter(
      ([, message]) => typeof message === 'string' && message.includes('continuously unavailable'),
    ).length;
    expect(warnsAfterReset).toBe(warnsAfterStreak);
  });
});

describe('run body deadline bounds', () => {
  /**
   * The deadline must never undercut the TTL: a crashed holder is already
   * bounded by the TTL, so a deadline below it would add steal-risk without
   * adding recovery. The deadline exists for the case the TTL cannot reach —
   * a hung-but-alive run whose heartbeat renews forever.
   */
  it.each(RUN_LEASE_SPECS.map((spec) => [spec.label, spec] as const))(
    '%s bounds its body at or above its TTL',
    (_label, spec) => {
      expect(spec.maxRunMs).toBeGreaterThanOrEqual(spec.ttlMs);
      expect(Number.isFinite(spec.maxRunMs)).toBe(true);
    },
  );

  /**
   * Same asymmetry as the TTLs: a stuck confirmation check lags SECURED
   * promotion for every customer, so it gets the tightest recovery bound,
   * while the signing job gets the most protection against a mid-run cutoff.
   */
  it('gives the promotion job the tightest body deadline', () => {
    expect(CHECK_CONFIRMATIONS_RUN_LEASE.maxRunMs).toBeLessThanOrEqual(
      PUBLIC_RECORD_ANCHOR_RUN_LEASE.maxRunMs,
    );
    expect(CHECK_CONFIRMATIONS_RUN_LEASE.maxRunMs).toBeLessThanOrEqual(
      BATCH_ANCHOR_RUN_LEASE.maxRunMs,
    );
  });
});

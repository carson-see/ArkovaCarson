/**
 * SCRUM-3031: the shared cross-instance run lease.
 *
 * OBSERVED IN PRODUCTION 2026-08-01 (Cloud Run `arkova-worker`, revision
 * 01164-xux). `anchor-public-records` is scheduled every 10 minutes with a
 * Cloud Scheduler `attemptDeadline` of 540s, while Cloud Run's request timeout
 * is 3600s. A run that exceeds the attempt deadline is abandoned by Cloud
 * Scheduler (`AttemptFinished status=DEADLINE_EXCEEDED`) but keeps executing
 * server-side, so the next tick starts a SECOND run — and Cloud Run places it
 * on a different instance:
 *
 *   19:12:27Z  "Creating individual anchors" recordCount=10000  instance …72908
 *   19:22:26Z  "Creating individual anchors" recordCount=10000  instance …72963
 *
 * The per-PROCESS `…Running = false` boolean each job carried cannot prevent
 * that: it is invisible to another instance. `batch-anchor.ts` and
 * `check-confirmations.ts` carried the identical boolean and the identical
 * exposure, and `batch-anchor.ts` is the one that SIGNS AND BROADCASTS from the
 * shared treasury — two concurrent runs there select overlapping UTXOs and
 * produce conflicting mainnet transactions. So the guard lives here once, and
 * all three jobs wrap themselves in it.
 *
 * These tests pin the lease semantics against an in-memory store that
 * EVALUATES the compare-and-set expression the code actually emits (see
 * `createRunLeaseStore` in `__testHelpers.ts`), so a regression that
 * reintroduces cross-instance overlap fails here rather than in production.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/logger.js', () => ({ logger: mockLogger }));
// SCRUM-1258: run-lease.ts reads the Cloud Run revision via the Zod-validated
// `config` export rather than `process.env` directly. config.ts validates the
// whole environment at import time and throws outside a fully-configured
// worker, so tests mock it — the established pattern in this directory
// (edgarFetcher, australiaLawFetcher, publicRecordAnchor-lease, …).
vi.mock('../../config.js', () => ({
  config: { logLevel: 'info', nodeEnv: 'test', kRevision: 'arkova-worker-01164-xux' },
}));

import {
  BATCH_ANCHOR_RUN_LEASE,
  CHECK_CONFIRMATIONS_RUN_LEASE,
  CLOUD_RUN_REQUEST_TIMEOUT_MS,
  PUBLIC_RECORD_ANCHOR_RUN_LEASE,
  RUN_LEASE_SPECS,
  acquireRunLease,
  releaseRunLease,
  renewRunLease,
  runLeaseHolder,
  withRunLease,
} from '../run-lease.js';
import { createRunLeaseStore, erroringRunLeaseClient } from './__testHelpers.js';

const SPEC = PUBLIC_RECORD_ANCHOR_RUN_LEASE;

/** Lets a test hold a run open across an await boundary. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('run lease — compare-and-set semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acquires a free lease and stamps a TTL in the future', async () => {
    const store = createRunLeaseStore(SPEC, 'free');
    const now = new Date('2026-08-01T19:10:00Z');

    expect(await acquireRunLease(store.client, SPEC, 'instance-a', now)).toBe(true);

    const row = store.current();
    expect(row?.status).toBe('processing');
    expect(row?.payload.holder).toBe('instance-a');
    expect(new Date(row?.scheduled_for as string).getTime()).toBe(now.getTime() + SPEC.ttlMs);
  });

  /**
   * The steady state is EVERY acquisition after the first one, ever, per lease.
   * `org-queue-scheduler` runs every 15 min in prod and claims up to 25 orgs per
   * pass, re-acquiring the same global batch lease for each — so a redundant
   * bootstrap write here is thousands of no-op writes a day against `job_queue`,
   * a table the db-health monitor already tracks as hot.
   */
  it('takes a free lease in a single round-trip, with no redundant bootstrap', async () => {
    const store = createRunLeaseStore(SPEC, 'free');

    expect(await acquireRunLease(store.client, SPEC, 'instance-a', new Date())).toBe(true);
    expect(store.callCount()).toBe(1);
  });

  /**
   * The bootstrap is reachable only when the compare-and-set matches nothing,
   * which is ambiguous: either the singleton row does not exist yet, or another
   * instance genuinely holds the lease. Seeding is safe in both cases
   * (`ignoreDuplicates` on the primary key) and the re-run CAS stays the only
   * arbiter, so concurrent first-ever runs still cannot both win.
   */
  it('bootstraps the singleton row on a first-ever run', async () => {
    const store = createRunLeaseStore(SPEC, 'absent');

    expect(await acquireRunLease(store.client, SPEC, 'instance-a', new Date())).toBe(true);
    expect(store.current()?.id).toBe(SPEC.leaseId);
    expect(store.current()?.type).toBe(SPEC.leaseType);
    expect(store.current()?.payload.holder).toBe('instance-a');
  });

  it('does not grant on the post-bootstrap retry when the lease is genuinely held', async () => {
    const store = createRunLeaseStore(SPEC, {
      held: { holder: 'other-instance', expiresAt: '2099-01-01T00:00:00Z' },
    });

    expect(await acquireRunLease(store.client, SPEC, 'instance-b', new Date())).toBe(false);
    expect(store.current()?.payload.holder).toBe('other-instance');
  });

  // The production failure: two Cloud Run instances, one live lease.
  it('refuses a second instance while another holds an unexpired lease', async () => {
    const store = createRunLeaseStore(SPEC, 'free');

    expect(
      await acquireRunLease(store.client, SPEC, 'instance-72908', new Date('2026-08-01T19:12:27Z')),
    ).toBe(true);
    expect(
      await acquireRunLease(store.client, SPEC, 'instance-72963', new Date('2026-08-01T19:22:26Z')),
    ).toBe(false);

    expect(store.current()?.payload.holder).toBe('instance-72908');
  });

  /**
   * Mutation guard for the `scheduled_for.lt.<now>` disjunct. Delete it and a
   * crashed holder's lease is never reclaimable — the job stops forever.
   */
  it('lets a later run steal a lease whose TTL has expired', async () => {
    const store = createRunLeaseStore(SPEC, {
      held: { holder: 'crashed-instance', expiresAt: '2026-08-01T19:00:00Z' },
    });

    expect(
      await acquireRunLease(store.client, SPEC, 'instance-b', new Date('2026-08-01T19:00:01Z')),
    ).toBe(true);
    expect(store.current()?.payload.holder).toBe('instance-b');
  });

  /**
   * Mutation guard for the `status.eq.completed` disjunct. A released lease has
   * `scheduled_for = NULL`, so the `lt` comparison is NULL — only the status
   * term can grant. Delete it and the CAS matches zero rows forever: acquire
   * fails CLOSED and the job silently never runs again.
   */
  it('grants on the released-status term alone, with no expiry to compare against', async () => {
    const store = createRunLeaseStore(SPEC, 'free');
    expect(store.current()?.scheduled_for).toBeNull();

    expect(await acquireRunLease(store.client, SPEC, 'instance-a', new Date())).toBe(true);
  });

  it('releases only its own lease', async () => {
    const store = createRunLeaseStore(SPEC, {
      held: { holder: 'instance-a', expiresAt: '2026-08-01T20:00:00Z' },
    });

    await releaseRunLease(store.client, SPEC, 'instance-b');
    expect(store.current()?.status).toBe('processing');
    expect(store.current()?.payload.holder).toBe('instance-a');

    await releaseRunLease(store.client, SPEC, 'instance-a');
    expect(store.current()?.status).toBe('completed');
    expect(store.current()?.scheduled_for).toBeNull();
  });

  it('warns rather than throwing when the release finds the lease already reclaimed', async () => {
    const store = createRunLeaseStore(SPEC, {
      held: { holder: 'thief', expiresAt: '2099-01-01T00:00:00Z' },
    });

    await expect(releaseRunLease(store.client, SPEC, 'overran')).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('frees the lease for the next run after a release', async () => {
    const store = createRunLeaseStore(SPEC, 'free');
    const now = new Date('2026-08-01T19:10:00Z');

    await acquireRunLease(store.client, SPEC, 'instance-a', now);
    await releaseRunLease(store.client, SPEC, 'instance-a');

    expect(await acquireRunLease(store.client, SPEC, 'instance-b', now)).toBe(true);
  });

  it('fails CLOSED when the bootstrap upsert errors', async () => {
    const client = erroringRunLeaseClient({ failOn: 'upsert' });
    expect(await acquireRunLease(client, SPEC, 'instance-a', new Date())).toBe(false);
  });

  it('fails CLOSED when the compare-and-set update errors', async () => {
    const client = erroringRunLeaseClient({ failOn: 'update' });
    expect(await acquireRunLease(client, SPEC, 'instance-a', new Date())).toBe(false);
  });

  it('fails CLOSED when the store throws outright', async () => {
    const client = erroringRunLeaseClient({ failOn: 'throw' });
    expect(await acquireRunLease(client, SPEC, 'instance-a', new Date())).toBe(false);
  });

  /**
   * INC-2026-08-04 — the outage this suite did NOT catch.
   *
   * PostgREST resolves an UPDATE's `or=` filter against the `select=`
   * projection. The CAS emitted `.select('id')` while filtering on `status`
   * and `scheduled_for`, so prod answered `42703 column job_queue.status does
   * not exist` on EVERY acquisition. `withRunLease` reads a failed claim as
   * "another instance holds it", so batch anchoring, check-confirmations,
   * public-record anchoring and the connector drain all silently stopped —
   * ~36h with zero anchors secured, while the suite stayed green because the
   * store double discarded the projection argument.
   *
   * The first test pins the fix; the second proves the double would now catch
   * a re-narrowing, so this guard cannot rot back into a no-op.
   */
  it('emits a projection covering every column its or() filter references', async () => {
    const store = createRunLeaseStore(SPEC, 'free');

    expect(await acquireRunLease(store.client, SPEC, 'instance-a', new Date())).toBe(true);
    expect(store.current()?.status).toBe('processing');
  });

  it('fails CLOSED when a projection omits an or() filter column (guard self-test)', async () => {
    const store = createRunLeaseStore(SPEC, 'free');
    const narrowed = {
      from: () => {
        const inner = store.from('job_queue') as Record<string, (...args: unknown[]) => unknown>;
        const proxy: Record<string, unknown> = {};
        for (const key of Object.keys(inner)) {
          proxy[key] =
            key === 'select'
              ? // Re-narrow to the pre-incident projection.
                (..._args: unknown[]) => inner.select('id')
              : (...args: unknown[]) => {
                  const out = inner[key](...args);
                  return out === inner ? proxy : out;
                };
        }
        return proxy;
      },
    } as unknown as Parameters<typeof acquireRunLease>[0];

    expect(await acquireRunLease(narrowed, SPEC, 'instance-a', new Date())).toBe(false);
  });
});

describe('run lease — holder identity', () => {
  /**
   * Regression guard for a real review finding. `K_REVISION` is the Cloud Run
   * REVISION name — identical on every instance — and the container's exec-form
   * CMD makes node PID 1 everywhere, so a holder id of `${K_REVISION}:${pid}`
   * is the SAME string on every instance. The release predicate would then
   * match another instance's LIVE lease: A overruns the TTL, B steals it and
   * writes the identical holder string, A finishes and releases B's claim, and
   * the next tick starts a third overlapping run — the exact failure the lease
   * exists to prevent, made self-sustaining.
   */
  it('mints a holder that cannot collide across instances of one revision', () => {
    // The revision comes from the mocked `config.kRevision` above, which is what
    // production reads too — this test no longer mutates process.env, so it can
    // never pass by exercising a code path prod does not take.
    const holder = runLeaseHolder();
    const shared = `arkova-worker-01164-xux:${process.pid}:`;
    // Everything a second instance of the same revision would also compute…
    expect(holder.startsWith(shared)).toBe(true);
    // …plus something it could not.
    expect(holder.slice(shared.length)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  /**
   * PER-ACQUISITION, not per-process.
   *
   * A per-process holder would make the holder-scoped release predicate safe
   * only BECAUSE the in-process guard prevents two same-process runs from
   * overlapping — an invisible coupling. If anyone later moved the
   * `inFlight.add` after the acquire, or dropped the Set, run 1 overrunning its
   * TTL and run 2 stealing it IN THE SAME PROCESS would let run 1's release
   * free run 2's live claim. Minting per acquisition removes the coupling
   * outright: a release can only ever match the exact run that took the lease.
   */
  it('mints a distinct holder per acquisition, not one per process', () => {
    expect(runLeaseHolder()).not.toBe(runLeaseHolder());
  });
});

describe('run lease renewal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extends the expiry of a lease this holder still owns', async () => {
    const store = createRunLeaseStore(SPEC, 'free');
    const acquiredAt = new Date('2026-08-01T19:00:00Z');
    await acquireRunLease(store.client, SPEC, 'instance-a', acquiredAt);
    const firstExpiry = store.current()?.scheduled_for as string;

    const later = new Date('2026-08-01T19:20:00Z');
    expect(await renewRunLease(store.client, SPEC, 'instance-a', later)).toBe('renewed');

    const renewedExpiry = store.current()?.scheduled_for as string;
    expect(new Date(renewedExpiry).getTime()).toBe(later.getTime() + SPEC.ttlMs);
    expect(new Date(renewedExpiry).getTime()).toBeGreaterThan(new Date(firstExpiry).getTime());
    expect(store.current()?.payload.holder).toBe('instance-a');
  });

  /**
   * The critical renewal property. A run whose lease already expired and was
   * STOLEN must not renew its way back on top of the new holder — that would
   * put two runs on the lease at once, which for `batch-anchor.ts` means two
   * instances signing from the same treasury.
   */
  it('refuses to renew a lease that has already been stolen', async () => {
    const store = createRunLeaseStore(SPEC, {
      held: { holder: 'thief', expiresAt: '2099-01-01T00:00:00Z' },
    });

    expect(await renewRunLease(store.client, SPEC, 'overran', new Date())).toBe('lost');
    expect(store.current()?.payload.holder).toBe('thief');
    expect(store.current()?.scheduled_for).toBe('2099-01-01T00:00:00Z');
  });

  /**
   * A store ERROR is not evidence about ownership. Distinguishing it from a
   * zero-row match is the whole reason this returns a tri-state rather than a
   * boolean: collapsing them made one transient PostgREST timeout look
   * identical to a stolen lease.
   */
  it('reports a store error as an error, not as a lost lease', async () => {
    const client = erroringRunLeaseClient({ failOn: 'update' });
    await expect(renewRunLease(client, SPEC, 'instance-a', new Date())).resolves.toBe(
      'store-error',
    );
  });

  /**
   * Wiring: a run that outlives its TTL keeps the lease instead of having it
   * stolen mid-flight. This was raised as a P1 on PR #1813 and never addressed
   * there; with `batch-anchor.ts` now behind the same primitive, an unrenewed
   * long run is a double-broadcast risk, not just a duplicated drain.
   *
   * The ORACLE is a competing acquisition, not the release. Releasing does not
   * prove renewal: `releaseRunLease` matches on `id` AND `payload->>holder`
   * and does NOT consider expiry, so a lapsed-but-unreclaimed lease releases
   * exactly as successfully as a renewed one. Only a second instance trying to
   * claim the lease AFTER the original TTL would have elapsed can tell the two
   * apart — it is granted the moment renewal stops happening, because the CAS's
   * `scheduled_for.lt.<now>` disjunct starts matching.
   */
  it('refuses a competing instance while a long run keeps renewing past its own TTL', async () => {
    // Real timers, deliberately. The heartbeat is an `unref`'d `setInterval`
    // whose renewal resolves through a chained `.then()`; driving that with
    // fake timers means hand-pumping the microtask queue between advances, and
    // getting that wrong produces a test that passes without the heartbeat ever
    // firing — the exact false green this test exists to prevent. A tiny TTL
    // buys the same coverage in ~350ms of real time.
    const fastSpec = { ...SPEC, ttlMs: 150 };
    const store = createRunLeaseStore(fastSpec, 'free');
    let competitor: boolean | undefined;

    const outcome = await withRunLease({ ...fastSpec, client: store.client }, async () => {
      // Twice the TTL: without renewal the lease is now provably stealable.
      await new Promise((resolve) => setTimeout(resolve, 300));
      competitor = await acquireRunLease(store.client, fastSpec, 'competitor', new Date());
      return 'long';
    });

    expect(competitor).toBe(false);
    expect(outcome).toEqual({ acquired: true, result: 'long' });
    expect(store.current()?.status).toBe('completed');
    expect(store.current()?.scheduled_for).toBeNull();
  });

  /**
   * THE REGRESSION THIS FIXES. The heartbeat's only escape hatch used to be
   * "the renewal did not return true", which a transient store error satisfies
   * — so one PostgREST timeout permanently disarmed the anti-double-broadcast
   * protection for the rest of the run. On the 3am `daily-anchor-flush` that is
   * the difference between one drain and two instances signing from the same
   * treasury UTXO set.
   */
  it('keeps renewing after a transient store error on a renewal', async () => {
    const fastSpec = { ...SPEC, ttlMs: 60 }; // heartbeat every 20ms
    const store = createRunLeaseStore(fastSpec, 'free', { failOwnedWrites: 1 });
    let attemptsWhileRunning = 0;

    await withRunLease({ ...fastSpec, client: store.client }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 200)); // ~10 periods
      attemptsWhileRunning = store.ownedWriteAttempts();
      return 'long';
    });

    expect(attemptsWhileRunning).toBeGreaterThan(1);
    // …and the error must not masquerade as the real alarm, which would make a
    // genuine mid-run steal indistinguishable from a blip in the logs.
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('no longer holds its lease'),
    );
  });

  /**
   * The other direction, and the reason the tri-state is not just "never give
   * up": a run whose lease was genuinely stolen must stop asserting a claim it
   * does not hold, or it would renew its way back on top of the new holder.
   */
  it('stops renewing once the lease is provably lost, and says so', async () => {
    const fastSpec = { ...SPEC, ttlMs: 60 }; // heartbeat every 20ms
    const store = createRunLeaseStore(fastSpec, 'free');
    let attemptsAfterTheft = 0;

    await withRunLease({ ...fastSpec, client: store.client }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      store.steal('thief');
      await new Promise((resolve) => setTimeout(resolve, 100)); // ≥5 periods to notice
      const noticed = store.ownedWriteAttempts();
      await new Promise((resolve) => setTimeout(resolve, 120)); // 6 more periods
      attemptsAfterTheft = store.ownedWriteAttempts() - noticed;
      return 'long';
    });

    expect(attemptsAfterTheft).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('no longer holds its lease'),
    );
  });

  it('stops renewing once the run finishes', async () => {
    const fastSpec = { ...SPEC, ttlMs: 60 };
    const store = createRunLeaseStore(fastSpec, 'free');

    await withRunLease({ ...fastSpec, client: store.client }, async () => 'quick');
    const callsAtCompletion = store.callCount();

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(store.callCount()).toBe(callsAtCompletion);
  });
});

describe('withRunLease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the body and releases the lease afterwards', async () => {
    const store = createRunLeaseStore(SPEC, 'free');
    const body = vi.fn(async () => 'done');

    const outcome = await withRunLease({ ...SPEC, client: store.client }, body);

    expect(outcome).toEqual({ acquired: true, result: 'done' });
    expect(body).toHaveBeenCalledTimes(1);
    expect(store.current()?.status).toBe('completed');
  });

  it('releases the lease when the body throws, and rethrows', async () => {
    const store = createRunLeaseStore(SPEC, 'free');

    await expect(
      withRunLease({ ...SPEC, client: store.client }, async () => {
        throw new Error('body exploded');
      }),
    ).rejects.toThrow('body exploded');

    expect(store.current()?.status).toBe('completed');
    expect(store.current()?.scheduled_for).toBeNull();
  });

  it('does NOT run the body when another instance holds the lease', async () => {
    const store = createRunLeaseStore(SPEC, {
      held: { holder: 'other-instance', expiresAt: '2099-01-01T00:00:00Z' },
    });
    const body = vi.fn(async () => 'done');

    const outcome = await withRunLease({ ...SPEC, client: store.client }, body);

    expect(outcome.acquired).toBe(false);
    expect(body).not.toHaveBeenCalled();
    expect(store.current()?.payload.holder).toBe('other-instance');
  });

  it('does NOT run the body when the store is unreachable (fail closed)', async () => {
    const body = vi.fn(async () => 'done');

    const outcome = await withRunLease(
      { ...SPEC, client: erroringRunLeaseClient({ failOn: 'update' }) },
      body,
    );

    expect(outcome.acquired).toBe(false);
    expect(body).not.toHaveBeenCalled();
  });

  /**
   * The in-process short-circuit that replaced the three `…Running = false`
   * booleans. It must fire BEFORE the store round-trip: a second concurrent
   * call on the same instance is refused without touching `job_queue`.
   */
  it('refuses a concurrent call in the SAME process without touching the store', async () => {
    const store = createRunLeaseStore(SPEC, 'free');
    const started = deferred();
    const finish = deferred();

    const first = withRunLease({ ...SPEC, client: store.client }, async () => {
      started.resolve();
      await finish.promise;
      return 'first';
    });

    let second: Awaited<ReturnType<typeof withRunLease<string>>>;
    let storeCallsWhileHeld: number;
    let storeCallsAfterSecond: number;
    try {
      await started.promise; // the first run now demonstrably holds the lease
      storeCallsWhileHeld = store.callCount();
      second = await withRunLease({ ...SPEC, client: store.client }, async () => 'second');
      storeCallsAfterSecond = store.callCount();
    } finally {
      // Never leave the in-process guard held: it is module state, and a
      // pending run would poison every later test in this file.
      finish.resolve();
    }

    expect(await first).toEqual({ acquired: true, result: 'first' });
    expect(second.acquired).toBe(false);
    expect(storeCallsAfterSecond).toBe(storeCallsWhileHeld);
  });

  /**
   * The in-process guard has to be taken SYNCHRONOUSLY, where the boolean it
   * replaces was. If it were added only after the acquire round-trip resolved,
   * two same-process callers would both slip past the check and both spend two
   * round-trips discovering what this process already knew.
   */
  it('short-circuits a same-process caller that races the very first acquire', async () => {
    const store = createRunLeaseStore(SPEC, 'free');
    const finish = deferred();

    // No await between the two calls: the second starts while the first is
    // still mid-acquire.
    const first = withRunLease({ ...SPEC, client: store.client }, async () => {
      await finish.promise;
      return 'first';
    });
    const second = await withRunLease({ ...SPEC, client: store.client }, async () => 'second');
    finish.resolve();

    expect(await first).toEqual({ acquired: true, result: 'first' });
    expect(second.acquired).toBe(false);
    // Exactly the first run's compare-and-set + release. The racing caller
    // performed no store operation at all.
    expect(store.callCount()).toBe(2);
  });

  it('frees the in-process guard after a run so the next tick can proceed', async () => {
    const store = createRunLeaseStore(SPEC, 'free');

    await withRunLease({ ...SPEC, client: store.client }, async () => 'a');
    const second = await withRunLease({ ...SPEC, client: store.client }, async () => 'b');

    expect(second).toEqual({ acquired: true, result: 'b' });
  });

  it('frees the in-process guard even when the body throws', async () => {
    const store = createRunLeaseStore(SPEC, 'free');

    await expect(
      withRunLease({ ...SPEC, client: store.client }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const second = await withRunLease({ ...SPEC, client: store.client }, async () => 'b');
    expect(second.acquired).toBe(true);
  });

  it('does not let one job block another job lease', async () => {
    const publicRecords = createRunLeaseStore(PUBLIC_RECORD_ANCHOR_RUN_LEASE, 'free');
    const batch = createRunLeaseStore(BATCH_ANCHOR_RUN_LEASE, 'free');
    const started = deferred();
    const finish = deferred();

    const running = withRunLease(
      { ...PUBLIC_RECORD_ANCHOR_RUN_LEASE, client: publicRecords.client },
      async () => {
        started.resolve();
        await finish.promise;
        return 'records';
      },
    );

    let other: Awaited<ReturnType<typeof withRunLease<string>>>;
    try {
      await started.promise;
      other = await withRunLease(
        { ...BATCH_ANCHOR_RUN_LEASE, client: batch.client },
        async () => 'batch',
      );
    } finally {
      finish.resolve();
    }

    await running;
    expect(other).toEqual({ acquired: true, result: 'batch' });
  });
});

describe('run lease TTL bounds', () => {
  /**
   * Every TTL is derived, not copied. The floor is the SLOWEST cadence recorded
   * for that job across live Cloud Scheduler and `scheduler-manifest.ts` — a
   * TTL at or below it would let the very next tick steal the lease from a run
   * that is still working, reproducing the overlap this exists to prevent. The
   * ceiling is Cloud Run's request timeout: a holder that dies without
   * releasing must never block its job for longer than one abandoned request
   * could possibly have run.
   */
  it.each(RUN_LEASE_SPECS.map((spec) => [spec.label, spec] as const))(
    '%s TTL sits strictly between its slowest cadence and the Cloud Run request ceiling',
    (_label, spec) => {
      expect(spec.ttlMs).toBeGreaterThan(spec.slowestRecordedCadenceMs);
      expect(spec.ttlMs).toBeLessThan(CLOUD_RUN_REQUEST_TIMEOUT_MS);
    },
  );

  /**
   * `batch-anchor.ts` signs and broadcasts from the shared treasury: a stolen
   * lease costs real mainnet fees and a reverted cohort, while a stuck lease
   * only defers work that stays PENDING. The asymmetry is deliberate, so pin
   * it — batch anchoring must never be the shortest-lived lease.
   */
  it('gives the broadcasting job the most headroom against a mid-run steal', () => {
    expect(BATCH_ANCHOR_RUN_LEASE.ttlMs).toBeGreaterThan(CHECK_CONFIRMATIONS_RUN_LEASE.ttlMs);
    expect(BATCH_ANCHOR_RUN_LEASE.ttlMs).toBeGreaterThan(PUBLIC_RECORD_ANCHOR_RUN_LEASE.ttlMs);
  });

  it('gives every job its own lease row and type', () => {
    const ids = RUN_LEASE_SPECS.map((spec) => spec.leaseId);
    const types = RUN_LEASE_SPECS.map((spec) => spec.leaseType);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(types).size).toBe(types.length);
  });

  it('keys every lease on a well-formed uuid, since the row id is a uuid column', () => {
    for (const spec of RUN_LEASE_SPECS) {
      expect(spec.leaseId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });
});

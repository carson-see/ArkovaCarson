/**
 * Cross-instance run lease for singleton cron jobs (SCRUM-3031).
 *
 * WHY THIS EXISTS. Three jobs each carried a per-PROCESS `…Running = false`
 * boolean as their overlap guard. Under Cloud Run that protects nothing that
 * matters: a job is triggered over HTTP, Cloud Scheduler abandons the attempt
 * at its `attemptDeadline` (120-540s depending on the job) while Cloud Run lets
 * the request keep executing to its 3600s timeout, and the next tick therefore
 * starts a SECOND run — which Cloud Run places on a different instance, where
 * that boolean is `false`.
 *
 * Observed in production 2026-08-01 (revision `arkova-worker-01164-xux`): two
 * instances entered `anchor-public-records` ten minutes apart against the same
 * 10,000 unlinked records. The row-lock contention on `anchors` pushed every
 * `batch_insert_anchors` chunk past its 20s client deadline into the
 * 1,000-round-trip serial fallback, which made the run slower and guaranteed
 * the next overlap. One run linked the batch (`linked=10000`) while the other
 * spent ~13 minutes to link ZERO — the overlap does not halt a drain, it burns
 * a duplicate copy of every run.
 *
 * `batch-anchor.ts` and `check-confirmations.ts` carried the identical boolean
 * and the identical exposure, and `batch-anchor.ts` is the one that SIGNS AND
 * BROADCASTS: two concurrent runs there select from the same treasury UTXO set
 * and produce conflicting mainnet transactions. So the guard lives here once,
 * and every such job wraps itself in `withRunLease`.
 *
 * IMPLEMENTATION. A TTL lease row in `job_queue` at a fixed primary key,
 * claimed with an atomic compare-and-set UPDATE. `job_queue` is reused
 * deliberately: `claim_next_job` is TYPE-scoped, so a row of these types is
 * never claimed by a job runner, and the free state is `completed` — the
 * terminal status the proof jobs already use precisely so queue-depth monitors
 * do not count it. No migration.
 *
 * A session advisory lock (`try_advisory_lock`, used by the proof jobs) was
 * REJECTED for this path: it is reached through PostgREST's 23-backend pool, so
 * the release can land on a different backend than the acquire and silently
 * no-op, leaving a lease stuck until that connection recycles. For jobs that
 * must run every few minutes, a stuck lock is a worse outage than the overlap
 * it prevents. A TTL lease cannot stick.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const MINUTES = 60_000;

/**
 * Cloud Run's request timeout on `arkova-worker` (`--timeout 3600` in
 * `.github/workflows/deploy-worker.yml`; confirmed live 2026-08-02 via
 * `gcloud run services describe arkova-worker`).
 *
 * It is the ceiling on every TTL, for a LIVENESS reason: a holder that dies
 * without releasing must never block its job for longer than one abandoned
 * request could have run.
 *
 * It is deliberately NOT claimed as a bound on how long a run can live. Cloud
 * Run's timeout terminates the REQUEST, not the JS continuation, and the
 * service runs CPU-throttled between requests (the same property that makes
 * in-process node-cron unreliable here — see `routes/cron.ts`). An abandoned
 * run is therefore frozen, not killed, and can thaw during a later request.
 * That is exactly why an ACTIVE run renews its lease (`renewRunLease` below)
 * rather than relying on the TTL to outlast it, and why the txid journal — not
 * the lease — is the authority on whether a signed transaction may be
 * broadcast.
 */
export const CLOUD_RUN_REQUEST_TIMEOUT_MS = 60 * MINUTES;

export interface RunLeaseSpec {
  /**
   * Fixed primary key of the singleton lease row. A CONSTANT id means the
   * bootstrap insert is a primary-key upsert, so concurrent first-ever runs
   * cannot create two lease rows (there is no unique constraint on
   * `job_queue.type` to lean on, and adding one would be a migration).
   */
  readonly leaseId: string;
  /** `job_queue.type`. Never claimed by a runner — `claim_next_job` is type-scoped. */
  readonly leaseType: string;
  /** Lease lifetime. Bounded by `slowestRecordedCadenceMs` below and the Cloud Run ceiling above. */
  readonly ttlMs: number;
  /** Job name, for logs. */
  readonly label: string;
  /**
   * The SLOWEST cadence recorded for this job across live Cloud Scheduler and
   * `scheduler-manifest.ts`. It is the TTL floor: a TTL at or below the cadence
   * would let the very next tick steal the lease from a run that is still
   * working, which is the overlap this exists to prevent. Recorded per job
   * because the cadences genuinely differ — and because the manifest currently
   * DRIFTS from live Cloud Scheduler on two of these three jobs, so taking the
   * slower of the two is the only safe reading.
   */
  readonly slowestRecordedCadenceMs: number;
  /**
   * Hard deadline on the run BODY (F-D0-5, fullsoak 2026-08-12). The TTL
   * bounds how long a DEAD holder blocks the job, but a hung-but-ALIVE run is
   * outside its reach: the heartbeat below renews the lease on schedule for as
   * long as the event loop turns, so a body parked on a single await — the
   * observed incident was a provider response whose body never arrived — holds
   * the lease forever, and `withRunLease`'s `finally` (the only release path)
   * is never reached. `maxRunMs` is the bound the TTL cannot be: when it
   * expires, the heartbeat stops, the lease is released, the in-process guard
   * is freed, and the caller gets a typed error instead of silence.
   *
   * Floor: the TTL (a body bound below the TTL would add cutoff-risk without
   * adding recovery — a crashed holder is already TTL-bounded). It must stay
   * comfortably above the job's worst HEALTHY run, because the deadline
   * abandons the body: the abandoned run keeps executing detached (nothing can
   * kill a promise), it just no longer holds the lease.
   */
  readonly maxRunMs: number;
}

/**
 * `anchor-public-records` — the job the 2026-08-01 incident was observed on.
 *
 * Cadence: every 10 minutes live (verified 2026-08-02 via `gcloud scheduler
 * jobs list`; attemptDeadline 540s), every 30 minutes in
 * `scheduler-manifest.ts`. Floor is the slower of the two: 30 min. Observed
 * healthy runs take ~13 min. TTL 45 min clears both with headroom and sits well
 * under the Cloud Run ceiling.
 */
export const PUBLIC_RECORD_ANCHOR_RUN_LEASE: RunLeaseSpec = {
  leaseId: '5f1c0de1-9a3b-4c7e-8d21-70ec0dea1e5e',
  leaseType: 'public-record-anchor:lease',
  ttlMs: 45 * MINUTES,
  label: 'public-record anchoring',
  slowestRecordedCadenceMs: 30 * MINUTES,
  // Healthy runs ~13 min; degraded runs are documented to outlive the TTL
  // (see renewRunLease). 2× TTL leaves that headroom while still recovering
  // from a hung run within one missed-and-a-half cadence window.
  maxRunMs: 90 * MINUTES,
};

/**
 * `batch-anchors` — THE JOB THAT SIGNS AND BROADCASTS. Highest stakes here.
 *
 * Cadence: every 30 minutes live (verified 2026-08-02; attemptDeadline 120s)
 * plus the `daily-anchor-flush` 3am forced drain
 * (`/jobs/batch-anchors?force=true`, 600s); every 10 minutes in
 * `scheduler-manifest.ts`. It is ALSO invoked ad hoc and off-cadence by
 * `org-queue-scheduler.ts`, `connector-artifact-drain.ts`, and the manual
 * `/queue/run` API — so cadence is a floor, never a bound on how often a claim
 * is attempted. Floor is the slowest recorded cadence: 30 min.
 *
 * TTL is pinned near the ceiling (55 min) because the two failure modes are NOT
 * symmetric. A lease STOLEN mid-run means two instances signing from the same
 * treasury UTXO set: conflicting transactions, real mainnet fees burned, and a
 * cohort unwound back to PENDING. A lease STUCK after a crash only defers work
 * — the anchors stay PENDING and drain on a later tick. So we buy the maximum
 * steal protection the Cloud Run ceiling allows, and accept that a crashed
 * holder costs up to two missed half-hourly ticks.
 */
export const BATCH_ANCHOR_RUN_LEASE: RunLeaseSpec = {
  leaseId: '7b47c4a1-0d2f-4e58-9c36-1a8e5f0b3d72',
  leaseType: 'batch-anchor:lease',
  ttlMs: 55 * MINUTES,
  label: 'batch anchoring',
  slowestRecordedCadenceMs: 30 * MINUTES,
  // The signing job gets the LONGEST body deadline, mirroring its TTL
  // asymmetry: cutting off a run that is mid-signing and releasing its lease
  // is the dangerous direction (the txid journal — not the lease — is what
  // makes even that safe against a double broadcast), while a hung run only
  // defers PENDING work. 2× TTL.
  maxRunMs: 110 * MINUTES,
};

/**
 * `check-confirmations` — SUBMITTED → SECURED promotion.
 *
 * Cadence: every 30 minutes live (verified 2026-08-02; attemptDeadline 300s),
 * every 2 minutes in `scheduler-manifest.ts` and in the `scheduled.ts`
 * in-process backup. Floor is the slower of the two: 30 min. A run is bounded
 * at `MAX_TX_CHECKS_PER_RUN` = 100 tx
 * lookups at `MEMPOOL_CONCURRENCY` = 10, each with a 10s timeout plus a 10s
 * fallback, so even an all-timeouts run is ~10 waves x 20s ≈ 3.5 min before the
 * drain RPCs.
 *
 * TTL 35 min — deliberately the SHORTEST of the three. This job makes no
 * signing or spending calls: its chain reads are idempotent and its promotion
 * goes through the drain RPC, so a stolen lease costs duplicated reads, not
 * money. The cost that dominates here is the other direction — a stuck lease
 * lags SECURED promotion for every customer — so it gets the least headroom
 * above its floor.
 */
export const CHECK_CONFIRMATIONS_RUN_LEASE: RunLeaseSpec = {
  leaseId: '2e9d6f30-5c14-4a7b-8f92-6b3c0d81ae45',
  leaseType: 'check-confirmations:lease',
  ttlMs: 35 * MINUTES,
  label: 'confirmation check',
  slowestRecordedCadenceMs: 30 * MINUTES,
  // The TIGHTEST body deadline of the three, for the same reason it has the
  // shortest TTL: a stuck run lags SECURED promotion for every customer —
  // the F-D0-5 incident held it for 35+ minutes with no recovery path — while
  // this job's chain reads are idempotent and its promotion goes through the
  // drain RPC, so an abandoned body costs duplicated reads, not money. Worst
  // healthy run is ~12 min (100 tx lookups + capped drain iterations), so
  // 45 min still clears it with ~4× headroom.
  maxRunMs: 45 * MINUTES,
};

/**
 * `drive-subscription-renewal` (GH #1835/#1836) — Drive `changes.watch`
 * channel renewal + GH #1836 legacy-token rotation.
 *
 * PR #1944 review correction: this job's Cloud Scheduler trigger and its
 * `scheduled.ts` in-process backup are BOTH hourly (`0 * * * *` — see
 * `routes/agents.md`), because there is no live-vs-manifest cadence drift to
 * take the slower of (the Cloud Scheduler job is not even applied to prod
 * yet as of this PR). `jobs/drive-subscription-renewal-deps.ts`'s
 * `runDriveSubscriptionRenewal()` is the ONE lease-guarded entry point BOTH
 * triggers call, so whichever fires first wins and the other no-ops —
 * exactly the batch-anchor.ts pattern, applied to the renewal job that
 * would otherwise reproduce GH #1835's own silent-outage symptom if two
 * concurrent sweeps raced each other's channel registrations.
 *
 * DELIBERATELY NOT added to `RUN_LEASE_SPECS` below. That array's shared
 * test asserts `ttlMs > slowestRecordedCadenceMs` for every entry — a real
 * safety margin for the three anchor-pipeline jobs, whose cadences (30 min)
 * sit well under the `CLOUD_RUN_REQUEST_TIMEOUT_MS` ceiling (60 min). This
 * job's cadence IS the ceiling (60 min), so no TTL can satisfy
 * `> 60min AND < 60min` simultaneously — the constraint is structurally
 * unsatisfiable here, not a gap in this spec. TTL is set to 50 min instead:
 * comfortably under the ceiling, and — for a run that is genuinely ALIVE —
 * the TTL-vs-cadence relationship isn't what protects it anyway; the
 * heartbeat (`startRunLeaseHeartbeat`, firing at ttl/3 ≈ 17 min) renews an
 * active run's lease long before any expiry regardless of how TTL compares
 * to cadence. TTL only governs how long a CRASHED holder blocks the job,
 * and a renewal sweep (bounded batch, `RENEWAL_CONCURRENCY`-chunked) is
 * expected to complete in seconds to low minutes, not 50.
 */
export const DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE: RunLeaseSpec = {
  leaseId: '9c4f2a18-6e73-4b0d-a5f1-3d8c7e2b9061',
  leaseType: 'drive-subscription-renewal:lease',
  ttlMs: 50 * MINUTES,
  label: 'Drive subscription renewal',
  slowestRecordedCadenceMs: 60 * MINUTES,
  // A renewal sweep completes in seconds to low minutes; one hour recovers a
  // hung sweep within its own hourly cadence while clearing the TTL floor.
  maxRunMs: 60 * MINUTES,
};

/**
 * Every registered lease covered by the shared TTL-bounds/uniqueness test
 * suite. `DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE` is deliberately NOT here —
 * see its own doc comment for why an hourly-cadence job cannot satisfy that
 * suite's `ttlMs > cadence` assertion under the shared 60-min Cloud Run
 * ceiling. It has its own dedicated coverage in
 * jobs/drive-subscription-renewal-deps.test.ts instead.
 */
export const RUN_LEASE_SPECS: readonly RunLeaseSpec[] = [
  PUBLIC_RECORD_ANCHOR_RUN_LEASE,
  BATCH_ANCHOR_RUN_LEASE,
  CHECK_CONFIRMATIONS_RUN_LEASE,
];

/**
 * Identifies the holder in logs and, load-bearingly, in the renew and release
 * predicates. The revision and pid are for humans reading logs; the nonce is
 * what makes it correct.
 *
 * A nonce is required because `K_REVISION` is the Cloud Run REVISION name —
 * identical on every instance of a revision — and the container's exec-form
 * `CMD ["node", …]` makes node PID 1 in every instance, so `${K_REVISION}:${pid}`
 * is the SAME string on every instance. With a colliding holder id the release
 * predicate would match another instance's lease: A overruns the TTL, B steals
 * it and writes the identical holder string, A finishes and releases B's live
 * claim, and the next tick starts a third overlapping run — the exact failure
 * this lease exists to prevent, made self-sustaining.
 *
 * The nonce is minted PER ACQUISITION rather than once per process. A
 * per-process nonce is safe only because `inFlight` below stops two
 * same-process runs from overlapping — an invisible coupling that a future
 * refactor of the in-process guard could break silently, reintroducing exactly
 * the release-someone-else's-lease bug one scope down. Per-acquisition removes
 * the dependency: a renew or release can only ever match the precise run that
 * took the lease.
 */
export function runLeaseHolder(): string {
  // SCRUM-1258: read the Cloud Run revision through the Zod-validated `config`
  // export, never `process.env` directly — an ad-hoc read here bypasses that
  // validation and is rejected by the worker-env gate in ci.yml.
  return `${config.kRevision ?? 'local'}:${process.pid}:${randomUUID()}`;
}

/**
 * Claims a run lease. Returns false when another instance holds an unexpired
 * one, and fails CLOSED on any store error — a run without a verified lease is
 * exactly the concurrent execution this guards against, so an unverifiable
 * lease must skip the run, not proceed on optimism.
 */
export async function acquireRunLease(
  client: SupabaseClient,
  spec: RunLeaseSpec,
  holder: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    // Compare-and-set FIRST. This is the whole acquisition in the steady state
    // — which is every run after the first one ever, per lease — so it is one
    // round-trip, not two. `org-queue-scheduler` alone re-acquires the global
    // batch lease up to 25 times per pass, every 15 minutes.
    const claimed = await compareAndSetLease(client, spec, holder, now);
    if (claimed.error) {
      logger.error({ error: claimed.error, holder, lease: spec.label }, 'Run lease claim failed — skipping run');
      return false;
    }
    if (claimed.matched) return true;

    // Zero rows is AMBIGUOUS: either the singleton row does not exist yet, or
    // another instance genuinely holds an unexpired lease. Seed it — a no-op in
    // the second case, since `ignoreDuplicates` on the primary key leaves an
    // existing lease alone — and re-run the CAS, which remains the only
    // arbiter. Concurrent first-ever runs therefore still cannot both win: one
    // insert lands, the other is ignored, and the retried CAS decides.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: seedError } = await (client as any)
      .from('job_queue')
      .upsert(
        {
          id: spec.leaseId,
          type: spec.leaseType,
          status: 'completed',
          scheduled_for: null,
          payload: {},
        },
        { onConflict: 'id', ignoreDuplicates: true },
      );

    if (seedError) {
      logger.error(
        { error: seedError, lease: spec.label },
        'Run lease bootstrap failed — skipping run',
      );
      return false;
    }

    const retried = await compareAndSetLease(client, spec, holder, now);
    if (retried.error) {
      logger.error({ error: retried.error, holder, lease: spec.label }, 'Run lease claim failed — skipping run');
      return false;
    }
    return retried.matched;
  } catch (error) {
    logger.error(
      { error, holder, lease: spec.label },
      'Run lease store unreachable — skipping run',
    );
    return false;
  }
}

/**
 * The claim itself: take the lease only if it is free or expired.
 *
 * ONE `UPDATE`, so two instances racing it cannot both match — Postgres
 * re-evaluates the `WHERE` after taking the row lock. The `.or(...)` is the
 * entire safety argument, which is why the test double parses and evaluates the
 * emitted expression rather than restating it.
 *
 * INC-2026-08-04: ownership is confirmed by a READ-BACK, never by the UPDATE's
 * returned rows. PostgREST applies an UPDATE's filters to the RETURNING
 * projection as well as to the WHERE clause, and this CAS mutates the very
 * columns it filters on — after the write the row is `processing` with a future
 * expiry, so it can never satisfy its own free-or-expired precondition. Two
 * failure modes came out of that, in order:
 *
 *   1. `.select('id')` — filter columns absent from the projection, so
 *      PostgREST 400s with `42703 column job_queue.status does not exist`.
 *      Every claim failed hard and every lease-guarded job stopped.
 *   2. `.select('id, status, scheduled_for')` — no error, but the returned set
 *      is filtered by the same `or=` and comes back EMPTY. Far worse than (1):
 *      the write LANDS, so the caller takes the lease, reads `matched === false`
 *      and reports "another instance holds it" — then skips the release,
 *      because `withRunLease` only releases what it believes it claimed. Every
 *      attempt silently poisoned the lease for a full TTL while doing no work.
 *
 * Both were verified directly against prod PostgREST. The read-back below is
 * immune to both: the UPDATE stays a single atomic CAS (two callers still
 * cannot both win — Postgres re-evaluates the WHERE under the row lock), and
 * ownership is then observed from the stored holder. That observation cannot
 * race: if we won, the row is ours until the TTL and nobody else can take it;
 * if we lost, it carries someone else's holder. `runLeaseHolder()` mints a
 * fresh uuid per call, so the comparison can never false-positive across runs.
 */
async function compareAndSetLease(
  client: SupabaseClient,
  spec: RunLeaseSpec,
  holder: string,
  now: Date,
): Promise<{ matched: boolean; error: unknown }> {
  const nowIso = now.toISOString();
  // The CAS itself. No `.select()` — see the note above; any returning
  // projection here is filtered by the same predicate and comes back empty.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (client as any)
    .from('job_queue')
    .update({
      status: 'processing',
      scheduled_for: new Date(now.getTime() + spec.ttlMs).toISOString(),
      payload: { holder, acquired_at: nowIso },
      updated_at: nowIso,
    })
    .eq('id', spec.leaseId)
    .or(`status.eq.completed,scheduled_for.lt.${nowIso}`);

  if (error) return { matched: false, error };

  // Read-back: did OUR holder land? An unfiltered point lookup, so nothing is
  // re-evaluated against the CAS predicate.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: readError } = await (client as any)
    .from('job_queue')
    .select('payload')
    .eq('id', spec.leaseId);

  if (readError) return { matched: false, error: readError };

  const rows = (data ?? []) as Array<{ payload?: { holder?: string } | null }>;
  return { matched: rows[0]?.payload?.holder === holder, error: null };
}

/**
 * The three genuinely different outcomes of a renewal attempt.
 *
 * `'lost'` and `'store-error'` are NOT the same answer, and collapsing them
 * into one falsy value was a real bug: `'lost'` is EVIDENCE about ownership
 * (the CAS ran and matched zero rows), while `'store-error'` is the ABSENCE of
 * evidence (the CAS never got an answer). Treating a PostgREST timeout as proof
 * the lease was stolen disarms the heartbeat for the rest of the run — the
 * opposite of the safe direction, since the run keeps working either way.
 */
export type RunLeaseRenewal = 'renewed' | 'lost' | 'store-error';

/**
 * Pushes this holder's expiry out by a fresh TTL.
 *
 * The TTL alone cannot keep a LIVE run safe. It bounds how long a DEAD holder
 * blocks the job, but nothing bounds how long a healthy run takes: the batch
 * drain's journal reconcile walks up to 100 journal rows serially, each a chain
 * `getReceipt` that retries with backoff, and the credit gate loops per claimed
 * anchor over a batch of up to 10,000. Under a degraded provider — precisely
 * when a stale mempool view makes a duplicate broadcast most likely — a run can
 * outlive any TTL that also satisfies the liveness ceiling. Without renewal the
 * next scheduler tick would then steal the lease from a run that is mid-flight
 * and, for `batch-anchor.ts`, mid-SIGNING.
 *
 * The predicate is holder-scoped for the case that matters: a run whose lease
 * already lapsed and was STOLEN must NOT renew its way back on top of the new
 * holder. That would put two runs on one lease — the failure this whole module
 * exists to prevent. Zero rows matched ⇒ we lost it ⇒ stop renewing and say so.
 */
export async function renewRunLease(
  client: SupabaseClient,
  spec: RunLeaseSpec,
  holder: string,
  now: Date = new Date(),
): Promise<RunLeaseRenewal> {
  const nowIso = now.toISOString();
  const { matched, error } = await updateOwnedLease(client, spec, holder, {
    scheduled_for: new Date(now.getTime() + spec.ttlMs).toISOString(),
    updated_at: nowIso,
  });

  if (error) {
    // Transient: the caller keeps trying until the run ends or the lease is
    // provably lost. A failed renewal is not itself a reason to stop working.
    logger.warn({ error, holder, lease: spec.label }, 'Run lease renewal failed — will retry');
    return 'store-error';
  }
  return matched ? 'renewed' : 'lost';
}

/**
 * Releases a run lease, but only if this holder still owns it. A run whose
 * lease expired and was stolen must not clear the new holder's claim.
 */
export async function releaseRunLease(
  client: SupabaseClient,
  spec: RunLeaseSpec,
  holder: string,
): Promise<void> {
  const { matched, error } = await updateOwnedLease(client, spec, holder, {
    status: 'completed',
    scheduled_for: null,
    updated_at: new Date().toISOString(),
  });

  // Best-effort: a failed release must not mask the run's real outcome. The TTL
  // is the backstop.
  if (error) {
    logger.warn(
      { error, holder, lease: spec.label },
      'Run lease release failed — TTL will expire it',
    );
    return;
  }

  // Zero rows means this run overran the TTL and someone else already took the
  // lease. Worth saying out loud: it means a run exceeded its TTL, which is the
  // signal that the batch size or the cadence needs revisiting.
  if (!matched) {
    logger.warn(
      { holder, lease: spec.label, ttlMs: spec.ttlMs },
      'Run lease was already reclaimed — this run overran its TTL; nothing released',
    );
  }
}

/**
 * The one holder-scoped write. Renew and release are the same UPDATE with
 * different payloads, so the predicate that makes both safe —
 * `id = <lease> AND payload->>holder = <us>` — lives in exactly one place and
 * cannot drift between them.
 *
 * Deliberately NOT shared with `acquireRunLease`. That one carries a bootstrap
 * upsert the other two do not, matches on a materially different condition
 * (free-or-expired, not still-mine), and fails at error level because it BLOCKS
 * the run rather than being best-effort. Folding it in would hide the predicate
 * difference behind a parameter — and that predicate is the whole safety
 * argument.
 */
async function updateOwnedLease(
  client: SupabaseClient,
  spec: RunLeaseSpec,
  holder: string,
  patch: Record<string, unknown>,
): Promise<{ matched: boolean; error: unknown }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (client as any)
      .from('job_queue')
      .update(patch)
      .eq('id', spec.leaseId)
      .eq('payload->>holder', holder)
      .select('id');

    if (error) return { matched: false, error };
    return { matched: ((data ?? []) as unknown[]).length > 0, error: null };
  } catch (error) {
    return { matched: false, error };
  }
}

export type RunLeaseOutcome<T> =
  | { acquired: true; result: T }
  | { acquired: false; result?: undefined };

/**
 * Lease ids currently held by THIS process.
 *
 * This replaces the per-job `…Running = false` booleans. It is not the guard
 * that matters — the `job_queue` row is — but it is a free short-circuit that
 * keeps a same-process re-entry from spending two round-trips to discover what
 * this process already knows.
 */
const inFlight = new Set<string>();

/**
 * Thrown when a run body exceeds its `maxRunMs` deadline (F-D0-5).
 *
 * A distinct type, not a bare Error, because the two questions a caller asks
 * are different: "did my work fail?" versus "was my work cut off because it
 * hung?". The second is an operational signal — it means a run parked long
 * enough to have blocked its job on every instance — and callers that convert
 * job failures into HTTP responses should be able to say so specifically.
 */
export class RunLeaseBodyTimeoutError extends Error {
  constructor(
    readonly lease: string,
    readonly maxRunMs: number,
  ) {
    super(`Run for '${lease}' exceeded its ${maxRunMs}ms body deadline and was abandoned`);
    this.name = 'RunLeaseBodyTimeoutError';
  }
}

/**
 * Consecutive lease-refused skips per lease id, with the time of the first
 * skip in the current streak.
 *
 * F-D0-2/F-D0-5: ONE skip is unremarkable — it is what healthy overlap looks
 * like, and this job logs it at info. A streak that outlives a full TTL is
 * not: the TTL should have expired the holder by then, so continued refusal
 * means an ACTIVE heartbeat is renewing a run that never ends. That is the
 * incident's exact signature, and it is what earns a warn.
 */
const skipStreaks = new Map<string, { count: number; firstSkipAtMs: number }>();

/** Test seam — module state must not leak between test files. */
export function resetRunLeaseSkipTrackingForTests(): void {
  skipStreaks.clear();
}

/**
 * Records a refused claim and warns when the streak has outlived a full TTL.
 * Returns the current consecutive-skip count.
 */
function recordRunLeaseSkip(spec: RunLeaseSpec, holder: string): number {
  const nowMs = Date.now();
  const previous = skipStreaks.get(spec.leaseId);
  const streak = previous
    ? { count: previous.count + 1, firstSkipAtMs: previous.firstSkipAtMs }
    : { count: 1, firstSkipAtMs: nowMs };
  skipStreaks.set(spec.leaseId, streak);

  const blockedForMs = nowMs - streak.firstSkipAtMs;
  if (blockedForMs > spec.ttlMs) {
    logger.warn(
      {
        holder,
        lease: spec.label,
        consecutiveSkips: streak.count,
        blockedForMs,
        ttlMs: spec.ttlMs,
      },
      'Run lease has been continuously unavailable for longer than a full TTL — the holder is renewing but not finishing; SUBMITTED work for this job is not progressing',
    );
  } else {
    logger.info(
      { holder, lease: spec.label, consecutiveSkips: streak.count },
      'Run skipped — another instance holds the run lease',
    );
  }
  return streak.count;
}

export interface WithRunLeaseOptions extends RunLeaseSpec {
  client: SupabaseClient;
}

/**
 * Runs `body` under the lease, or reports that it could not be claimed.
 *
 * The `{ acquired }` discriminant is deliberate: a skipped run is NOT the same
 * as an empty one, and each caller has to say what its own "did nothing" value
 * is rather than inheriting a silent default.
 *
 * F-D0-5: the body is raced against `spec.maxRunMs`. The lease alone cannot
 * bound a hung-but-alive run — the heartbeat renews it for as long as the
 * event loop turns — so the deadline is what makes the lease reclaimable at
 * all in that state. On expiry this throws {@link RunLeaseBodyTimeoutError}
 * after stopping the heartbeat, releasing the lease and freeing the
 * in-process guard, so the very next tick (on this instance or any other) can
 * proceed.
 */
export async function withRunLease<T>(
  options: WithRunLeaseOptions,
  body: () => Promise<T>,
): Promise<RunLeaseOutcome<T>> {
  const { client, ...spec } = options;

  if (inFlight.has(spec.leaseId)) {
    logger.info({ lease: spec.label }, 'Run skipped — already in progress on this instance');
    return { acquired: false };
  }
  // Claimed SYNCHRONOUSLY, before the first await — exactly where the
  // `…Running = true` it replaces sat. Adding it after the acquire round-trip
  // would leave a window in which two same-process callers both pass the check
  // above; the CAS would still refuse the second, but only after two wasted
  // round-trips, and the short-circuit would be decorative.
  inFlight.add(spec.leaseId);

  const holder = runLeaseHolder();
  let claimed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    claimed = await acquireRunLease(client, spec, holder);
    if (!claimed) {
      recordRunLeaseSkip(spec, holder);
      return { acquired: false };
    }
    skipStreaks.delete(spec.leaseId);
    heartbeat = startRunLeaseHeartbeat(client, spec, holder);
    return { acquired: true, result: await runBodyWithDeadline(spec, holder, body) };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    inFlight.delete(spec.leaseId);
    // Only if we actually took it. Releasing after a REFUSED claim would fire
    // an UPDATE that can never match (we never wrote our holder), logging a
    // false "this run overran its TTL" against a lease we never held.
    if (claimed) await releaseRunLease(client, spec, holder);
  }
}

/**
 * Races the run body against its `maxRunMs` deadline.
 *
 * IT DOES NOT KILL THE BODY — nothing can cancel a promise in JS. It ABANDONS
 * it: the parked run keeps whatever it is doing, detached, while this function
 * unwinds so `withRunLease`'s `finally` can release the lease. That asymmetry
 * is the whole point. The failure mode being fixed is not "a run does work
 * twice", it is "a run that will never finish holds a global lease forever and
 * disables the job for every tenant". A duplicate drain is idempotent; an
 * indefinitely blocked promotion pipeline is not recoverable without a
 * redeploy.
 *
 * The abandoned body is OBSERVED (`.then(…, …)`) so that a late rejection —
 * the socket finally dying twenty minutes on — cannot surface as an unhandled
 * rejection and crash the worker.
 */
async function runBodyWithDeadline<T>(
  spec: RunLeaseSpec,
  holder: string,
  body: () => Promise<T>,
): Promise<T> {
  const running = body();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startedAtMs = Date.now();

  try {
    return await Promise.race([
      running,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Attach the late-settlement observers BEFORE rejecting, so there is
          // no window in which the abandoned promise is unobserved.
          running.then(
            () => {
              logger.warn(
                { holder, lease: spec.label, maxRunMs: spec.maxRunMs },
                'Abandoned run completed after its deadline — its result was discarded and its lease had already been released',
              );
            },
            (error: unknown) => {
              logger.warn(
                { holder, lease: spec.label, maxRunMs: spec.maxRunMs, error },
                'Abandoned run failed after its deadline — the lease had already been released',
              );
            },
          );
          logger.error(
            {
              holder,
              lease: spec.label,
              maxRunMs: spec.maxRunMs,
              ttlMs: spec.ttlMs,
              elapsedMs: Date.now() - startedAtMs,
            },
            'Run exceeded its body deadline and was abandoned — releasing the lease so the next tick can proceed. A run that hangs past this bound is renewing its lease without making progress; investigate the job for an unbounded await',
          );
          reject(new RunLeaseBodyTimeoutError(spec.label, spec.maxRunMs));
        }, spec.maxRunMs);
        // A pending deadline must never keep the worker process alive, exactly
        // like the heartbeat it complements.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Keeps an ACTIVE run's lease from lapsing under it.
 *
 * Fires at a third of the TTL, so a renewal has two chances to land before the
 * lease could expire. It is `unref`'d: a heartbeat must never be the reason the
 * worker process stays alive, and it must never delay a shutdown.
 *
 * Renewal STOPS on `'lost'` and ONLY on `'lost'` — the CAS ran and matched zero
 * rows, which is proof the lease is someone else's now. That is the safe
 * direction: the run continues, but it stops asserting a claim it does not
 * hold, and the loud warning is the signal that a run outlived its TTL before
 * the heartbeat could save it.
 *
 * A `'store-error'` is deliberately NOT that signal. It carries no information
 * about ownership, and the lease is most likely still ours — so the interval
 * keeps running and the next tick retries, which is exactly what
 * `renewRunLease` promises. Stopping there would let one transient PostgREST
 * timeout, at ttl/3 into a 55-minute batch drain, silently disarm the
 * anti-double-broadcast protection for the whole rest of the run. It would also
 * fire the "another instance may be running concurrently" warning when nothing
 * of the kind happened, making the real alarm and the blip indistinguishable.
 */
function startRunLeaseHeartbeat(
  client: SupabaseClient,
  spec: RunLeaseSpec,
  holder: string,
): ReturnType<typeof setInterval> {
  const everyMs = Math.max(1, Math.floor(spec.ttlMs / 3));
  const timer = setInterval(() => {
    void renewRunLease(client, spec, holder).then((outcome) => {
      if (outcome !== 'lost') return;
      clearInterval(timer);
      logger.warn(
        { holder, lease: spec.label, ttlMs: spec.ttlMs },
        'Run lease renewal did not match — this run no longer holds its lease; another instance may be running concurrently',
      );
    });
  }, everyMs);
  timer.unref?.();
  return timer;
}

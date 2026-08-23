/**
 * In-process cron double-fire audit (SCRUM-3384).
 *
 * WHY THIS EXISTS — the retracted claim.
 *
 * Worker source and several `agents.md` files asserted, in various phrasings,
 * that "in-process node-cron is dormant under Cloud Run CPU throttling", and
 * used it as a safety argument: the in-process schedule in `scheduled.ts` was
 * described as a dev/test backup that cannot double-fire against the Cloud
 * Scheduler HTTP triggers in `cron.ts` because it never runs in prod at all.
 *
 * That is false for this service. node-cron is dormant on a revision that has
 * scaled to ZERO; it fires normally whenever an instance is alive. Prod
 * `arkova-worker` is deployed with `--min-instances 2 --max-instances 10`
 * (`.github/workflows/deploy-worker.yml`), and `DISABLE_IN_PROCESS_ANCHOR_CRON`
 * is left unset by design (`docs/staging/fullsoak-2026-08/flag-decision-matrix.csv`).
 * So every job registered below runs on 2-10 warm instances CONCURRENTLY, plus
 * whatever Cloud Scheduler drives over HTTP — and it has been doing so all
 * along. The load-bearing half of the sentence was the false half.
 *
 * WHAT THIS FILE IS.
 *
 * The per-job answer to "what actually stops the second copy?", recorded once
 * so it does not have to be re-derived from the 19 registrations spread across
 * 16 modules, and ratcheted by `in-process-cron-audit.test.ts` so a new
 * in-process cron cannot land without answering the question. It follows
 * `jobs/scheduler-manifest.ts`: a declaration table plus a pure validator, no
 * runtime behaviour.
 *
 * It is an AUDIT, not a fix. Seven jobs are recorded `unguarded`; each names its
 * follow-up. Wrapping them in `withRunLease` is deliberately NOT done here,
 * because a `RunLeaseSpec` is only correct if its `slowestRecordedCadenceMs`
 * and `maxRunMs` come from the SLOWEST cadence observed across live Cloud
 * Scheduler and `scheduler-manifest.ts` (see `jobs/run-lease.ts`, which derives
 * every existing TTL that way from `gcloud scheduler jobs list` output).
 * Inventing those numbers from the repo alone would be the same
 * unverified-claim failure this audit exists to correct.
 *
 * A NOTE ON `chain-maintenance.ts`. Five of the jobs below call
 * `acquireLock(LOCK_*)` before doing work, and one of them logs "another worker
 * holds the lock" on refusal. There is no lock: `acquireLock` is a stub that
 * returns a hardcoded `true`, on the reasoning that this is a "single-worker
 * process". It is not a single-worker process. Where those jobs are safe, they
 * are safe because of a per-row compare-and-set, never because of that call —
 * which is why `guard` below records the mechanism, and why the test verifies a
 * `run-lease` claim against the module that supposedly makes it.
 */

/** What actually prevents a second concurrent copy from doing damage. */
export type InProcessCronGuard =
  /** `withRunLease` — cross-instance TTL lease in `job_queue` (`jobs/run-lease.ts`). */
  | 'run-lease'
  /** A compare-and-set / SKIP-LOCKED claim makes each unit of work exactly-once. */
  | 'atomic-claim'
  /** No claim, but a second run writes the same value or no-ops. */
  | 'value-idempotent'
  /** Reads and alerts only; no writes to reconcile. */
  | 'read-only'
  /** Nothing. A second concurrent copy repeats the work and its side effects. */
  | 'unguarded';

/** What a second concurrent copy actually costs. Ordered least to most severe. */
export type InProcessCronDoubleFireImpact =
  /** Fully guarded — the loser no-ops. */
  | 'none'
  /** Duplicated reads/CPU; no incorrect state. */
  | 'wasted-work'
  /** The same page/Sentry event fires 2-10 times. */
  | 'duplicate-alert'
  /** Duplicate rows or repeated outbound calls that are not money or chain. */
  | 'duplicate-side-effect'
  /** Credit ledger or billing state can be written twice. */
  | 'money'
  /** Treasury UTXOs, signing, or broadcast state can be driven concurrently. */
  | 'chain';

export interface InProcessCronAuditEntry {
  /** Exactly as passed to `scheduleInProcess(...)` in `scheduled.ts`. */
  jobName: string;
  /**
   * Worker-src-relative path of the module whose entrypoint the cron calls —
   * where the guard lives, or would have to. `routes/scheduled.ts` when the
   * job body is inline (`cleanup-expired-data` calls an RPC directly).
   */
  entrypointModule: string;
  guard: InProcessCronGuard;
  doubleFireImpact: InProcessCronDoubleFireImpact;
  /** The mechanism, specifically enough to check. Not a reassurance. */
  rationale: string;
  /** REQUIRED when the job is unguarded: what has to happen, and who tracks it. */
  followUp?: string;
}

/**
 * Every job `scheduled.ts` registers, in registration order.
 *
 * Verified against `services/worker/src/routes/scheduled.ts`,
 * `jobs/chain-maintenance.ts`, `jobs/revocation.ts`, `webhooks/delivery.ts`
 * and the `allocate_monthly_credits` / `cleanup_expired_data` definitions in
 * `supabase/migrations/00000000000000_baseline_at_main_HEAD.sql`.
 */
export const IN_PROCESS_CRON_AUDIT: readonly InProcessCronAuditEntry[] = [
  {
    jobName: 'recover-stuck-broadcasts',
    entrypointModule: 'jobs/broadcast-recovery.ts',
    guard: 'atomic-claim',
    doubleFireImpact: 'wasted-work',
    rationale:
      'Each reset is a per-row compare-and-set on the anchor\'s previous status, so only one '
      + 'instance can flip a given row back to PENDING; the loser matches zero rows and skips.',
  },
  {
    jobName: 'process-batch-anchors',
    entrypointModule: 'jobs/batch-anchor.ts',
    guard: 'run-lease',
    doubleFireImpact: 'none',
    rationale:
      'Wrapped in withRunLease(BATCH_ANCHOR_RUN_LEASE). This is the job that signs and '
      + 'broadcasts, and it is the reason the lease primitive exists at all.',
  },
  {
    jobName: 'check-submitted-confirmations',
    entrypointModule: 'jobs/check-confirmations.ts',
    guard: 'run-lease',
    doubleFireImpact: 'none',
    rationale:
      'Wrapped in withRunLease(CHECK_CONFIRMATIONS_RUN_LEASE); the losing instance returns a '
      + 'zeroed result rather than repeating the SUBMITTED to SECURED drain.',
  },
  {
    jobName: 'process-revoked-anchors',
    entrypointModule: 'jobs/revocation.ts',
    guard: 'unguarded',
    doubleFireImpact: 'chain',
    rationale:
      'Selects up to 50 REVOKED anchors with revocation_tx_id IS NULL and broadcasts a chain '
      + 'revocation per anchor. Its own comment states that UTXO selection is unsafe under '
      + 'concurrency and that safety comes from processing the list SEQUENTIALLY — which holds '
      + 'only within one run. There is no claim on the rows, so every warm instance selects the '
      + 'same 50 anchors and spends from the same treasury UTXO set at the same time.',
    followUp:
      'Highest-severity entry in this audit. Needs withRunLease with a spec derived from the live '
      + 'Cloud Scheduler cadence for /jobs/process-revocations, or a per-row claim on '
      + 'revocation_tx_id. File against SCRUM-3384.',
  },
  {
    jobName: 'process-webhook-retries',
    entrypointModule: 'webhooks/delivery.ts',
    guard: 'unguarded',
    doubleFireImpact: 'duplicate-side-effect',
    rationale:
      'The 50-row `retrying` window is unclaimed, so concurrent instances select the same rows. '
      + 'The delivery_log ROW is safe — UNIQUE idempotency_key (endpoint + event_type + event_id, '
      + 'RACE-6) means the audit trail cannot double-count. The outbound POST is not: the '
      + 'pre-delivery idempotency lookup short-circuits only on status=success, and a `retrying` '
      + 'row is deliberately allowed through to re-fire (PR #753 fixed the opposite bug, where '
      + 'every retry short-circuited into a silent no-op). So nothing suppresses a concurrent '
      + 'duplicate, and a customer endpoint can receive the same event once per warm instance.',
    followUp:
      'Whether this matters depends on whether consumers are required to dedupe on event_id — no '
      + 'such contract is stated anywhere in docs/ or the webhook payload schemas, so it cannot be '
      + 'relied on. Either publish that requirement or claim the retry window. File against '
      + 'SCRUM-3384.',
  },
  {
    jobName: 'process-monthly-credits',
    entrypointModule: 'jobs/credit-expiry.ts',
    guard: 'unguarded',
    doubleFireImpact: 'money',
    rationale:
      'Calls allocate_monthly_credits(), which holds no lock (no advisory lock, no FOR UPDATE) '
      + 'and loops over credits rows with cycle_end <= now(). The UPDATE of credits.balance is '
      + 'value-idempotent (both writers compute purchased + plan_allocation), but each iteration '
      + 'also INSERTs an unconditional ALLOCATION row into credit_transactions — plus an EXPIRY '
      + 'row whose IF v_expired_monthly > 0 test both writers evaluate against the same '
      + 'pre-UPDATE snapshot, so they take the same branch. Two instances therefore write two '
      + 'ledger entries for one allocation while the balance moves once, which is precisely the '
      + 'shape of a conservation break. It fires at 0 0 1 * *, so every warm instance starts '
      + 'within the same second.',
    followUp:
      'Money-conservation exposure — this is exactly the drift reconcile-credit-conservation '
      + 'pages on. Needs either withRunLease on the caller or an advisory lock inside '
      + 'allocate_monthly_credits (the latter is a compensating migration). File against '
      + 'SCRUM-3384.',
  },
  {
    jobName: 'reconcile-credit-conservation',
    entrypointModule: 'jobs/credit-conservation-reconciler.ts',
    guard: 'read-only',
    doubleFireImpact: 'duplicate-alert',
    rationale:
      'Read-only ledger divergence check. Concurrent copies re-read the same rows and reach the '
      + 'same verdict; the only cost is the drift page firing once per warm instance.',
  },
  {
    jobName: 'anchor-expiry-sweep',
    entrypointModule: 'jobs/anchorExpirySweep.ts',
    guard: 'atomic-claim',
    doubleFireImpact: 'wasted-work',
    rationale:
      'The SECURED to EXPIRED transition is a compare-and-set on status=SECURED with a returning '
      + 'select, and the anchor.expired webhook plus audit row are dispatched only for rows the '
      + 'UPDATE actually matched. The losing instance silently skips.',
  },
  {
    jobName: 'check-stuck-anchors',
    entrypointModule: 'jobs/stuck-anchor-monitor.ts',
    guard: 'read-only',
    doubleFireImpact: 'duplicate-alert',
    rationale:
      'Oldest-PENDING probe with no writes. A stall is a true finding on every instance that '
      + 'observes it, so the duplication is in the paging, not the verdict.',
  },
  {
    jobName: 'cleanup-expired-data',
    entrypointModule: 'routes/scheduled.ts',
    guard: 'unguarded',
    doubleFireImpact: 'duplicate-side-effect',
    rationale:
      'Calls cleanup_expired_data() with no lock. The function DROPs and re-CREATEs the '
      + 'reject_audit_delete trigger around its audit_events purge, so concurrent runs contend on '
      + 'trigger DDL — observed deadlocking (SQLSTATE 40P01) on four of six consecutive nights in '
      + 'prod. The window between one instance DROPping the trigger and re-CREATEing it is also a '
      + 'window in which the other instance deletes audit rows unprotected.',
    followUp:
      'Already in flight: PR #2335 makes cleanup_expired_data() a singleton. This entry moves to '
      + 'atomic-claim when that lands; it is recorded unguarded because that is the state of main.',
  },
  {
    jobName: 'detect-reorgs',
    entrypointModule: 'jobs/chain-maintenance.ts',
    guard: 'atomic-claim',
    doubleFireImpact: 'wasted-work',
    rationale:
      'The acquireLock(LOCK_REORG_DETECTION) call is a no-op stub, and the "another worker holds '
      + 'the lock" log line it guards is unreachable. What actually protects this job is the '
      + 'per-row compare-and-set on status=SECURED in the revert path: only rows a given instance '
      + 'flipped are counted and retracted to subscribers. Duplicate mempool reads remain.',
  },
  {
    jobName: 'monitor-stuck-transactions',
    entrypointModule: 'jobs/chain-maintenance.ts',
    guard: 'atomic-claim',
    doubleFireImpact: 'wasted-work',
    rationale:
      'Same no-op acquireLock stub as detect-reorgs. The abandon path is a compare-and-set on '
      + 'status=SUBMITTED, so a stuck anchor is rewound to PENDING exactly once regardless of how '
      + 'many instances observe it.',
  },
  {
    jobName: 'rebroadcast-dropped-transactions',
    entrypointModule: 'jobs/chain-maintenance.ts',
    guard: 'unguarded',
    doubleFireImpact: 'chain',
    rationale:
      'Re-POSTing the stored raw transaction hex is itself harmless — it is the same txid, and '
      + 'nodes reject the duplicate. The defect is the attempt counter: metadata._rebroadcast_'
      + 'attempts is read, incremented in JS, and written back with a filter on anchor id only, '
      + 'so concurrent instances both read N and both write N+1. Attempts are LOST, not doubled, '
      + 'and MAX_REBROADCAST_ATTEMPTS can therefore never be reached — which strands an anchor in '
      + 'SUBMITTED instead of rewinding it to PENDING for a fresh broadcast.',
    followUp:
      'Make the counter a compare-and-set on the observed attempt value, or move the job under a '
      + 'run lease. File against SCRUM-3384.',
  },
  {
    jobName: 'consolidate-utxos',
    entrypointModule: 'jobs/chain-maintenance.ts',
    guard: 'unguarded',
    doubleFireImpact: 'duplicate-side-effect',
    rationale:
      'No guard, but the double-fire cost is smaller than it looks: consolidateUtxos does not '
      + 'currently sweep anything. It checks the fee rate, writes a chain.consolidation_'
      + 'opportunity audit row for ops, and returns utxosSwept: 0 — full automation is explicitly '
      + 'deferred in that function. So concurrent copies duplicate an audit row, they do not '
      + 'contend over treasury UTXOs.',
    followUp:
      'Not urgent while the job only logs. It becomes a chain-severity entry the moment the '
      + 'deferred sweep is implemented, and must get a run lease in that same change.',
  },
  {
    jobName: 'monitor-fee-rates',
    entrypointModule: 'jobs/chain-maintenance.ts',
    guard: 'unguarded',
    doubleFireImpact: 'duplicate-side-effect',
    rationale:
      'Each run INSERTs a chain.fee_rate_sample audit row, then computes the "24h average" over a '
      + '.gte(created_at, 24h ago).limit(200) read of those samples. One instance at a 10-minute '
      + 'cadence produces 144 samples a day, so the cap never binds; 2-10 instances produce '
      + '288-1440, so the cap binds and the average is taken over a fraction of the window. Note '
      + 'the read carries NO order-by, so which 200 rows come back is unspecified rather than "the '
      + 'most recent 200" — the average stops being a 24h average without ever being wrong enough '
      + 'to notice, and a genuine spike can stop clearing the 5x multiplier. The monitor gets less '
      + 'trustworthy the more instances run it.',
    followUp:
      'Bound the average by created_at rather than row count, and add the missing order-by, or '
      + 'lease the sampler. This one degrades a detection control rather than corrupting state. '
      + 'File against SCRUM-3384.',
  },
  {
    jobName: 'populate-confirmation-proofs',
    entrypointModule: 'jobs/confirmation-proof-backfill.ts',
    guard: 'value-idempotent',
    doubleFireImpact: 'wasted-work',
    rationale:
      'The populated block_header is its own watermark and the bytes are derived from the chain, '
      + 'so a second writer writes identical values. Cost is duplicated provider reads.',
  },
  {
    jobName: 'drain-connector-artifacts',
    entrypointModule: 'jobs/connector-artifact-drain.ts',
    guard: 'atomic-claim',
    doubleFireImpact: 'wasted-work',
    rationale:
      'Each row is taken with a compare-and-set claim to status=processing scoped by id, org and '
      + 'prior status, so the loser matches zero rows. The credit debit downstream is itself '
      + 'idempotent on the anchor id.',
  },
  {
    jobName: 'drive-file-changed',
    entrypointModule: 'jobs/drive-file-changed.ts',
    guard: 'atomic-claim',
    doubleFireImpact: 'wasted-work',
    rationale:
      'Drains through claim_next_job, which claims a single queue row atomically. Two instances '
      + 'interleave over distinct rows rather than repeating one.',
  },
  {
    jobName: 'drive-subscription-renewal',
    entrypointModule: 'jobs/drive-subscription-renewal-deps.ts',
    guard: 'run-lease',
    doubleFireImpact: 'none',
    rationale:
      'Wrapped in withRunLease(DRIVE_SUBSCRIPTION_RENEWAL_RUN_LEASE) precisely so this in-process '
      + 'backup and the Cloud Scheduler HTTP trigger can both exist; the loser returns skipped.',
  },
];

/** Jobs where nothing prevents a second concurrent copy. The audit's finding. */
export function unguardedInProcessCronJobs(): InProcessCronAuditEntry[] {
  return IN_PROCESS_CRON_AUDIT.filter((entry) => entry.guard === 'unguarded');
}

export function getInProcessCronAuditEntry(
  jobName: string,
): InProcessCronAuditEntry | undefined {
  return IN_PROCESS_CRON_AUDIT.find((entry) => entry.jobName === jobName);
}

/**
 * Structural problems with the audit table, as human-readable strings (empty
 * array means valid). Mirrors `validateSchedulerManifest` in
 * `jobs/scheduler-manifest.ts`.
 *
 * The `..` rejection on `entrypointModule` is not defensive theatre about
 * untrusted input — every value here is a repo-authored literal — it is so the
 * ratchet test can `resolve(WORKER_SRC, entry.entrypointModule)` and read the
 * file with no possibility of escaping the worker source tree, whatever a
 * future edit puts in this table.
 */
export function validateInProcessCronAudit(
  entries: readonly InProcessCronAuditEntry[],
): string[] {
  const problems: string[] = [];

  for (const entry of entries) {
    const where = entry.jobName || '<unnamed job>';

    if (!entry.jobName.trim()) {
      problems.push('an entry has an empty jobName');
    }

    if (!entry.entrypointModule.endsWith('.ts')) {
      problems.push(`${where}: entrypointModule must be a .ts path relative to services/worker/src`);
    }

    if (entry.entrypointModule.startsWith('/') || entry.entrypointModule.split('/').includes('..')) {
      problems.push(`${where}: entrypointModule must stay inside services/worker/src`);
    }

    // Long enough that it has to name a mechanism rather than assert safety.
    if (entry.rationale.trim().length < 60) {
      problems.push(`${where}: rationale must state the mechanism, not a reassurance`);
    }

    if (entry.guard === 'unguarded' && entry.doubleFireImpact === 'none') {
      problems.push(`${where}: an unguarded job cannot have a double-fire impact of 'none'`);
    }

    if (entry.guard !== 'unguarded' && entry.followUp) {
      problems.push(`${where}: followUp belongs on unguarded entries only`);
    }

    if (entry.guard === 'unguarded' && !entry.followUp?.trim()) {
      problems.push(`${where}: an unguarded job must name its follow-up`);
    }

    if (entry.guard === 'run-lease' && entry.doubleFireImpact !== 'none') {
      problems.push(`${where}: a lease-guarded job's loser no-ops, so impact must be 'none'`);
    }
  }

  return problems;
}

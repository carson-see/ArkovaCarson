/**
 * Durable 24-hour organization queue scheduler (SCRUM-1130).
 *
 * Claims due organizations via a Postgres RPC, then runs the existing
 * org-scoped batch path. This module intentionally does not anchor directly;
 * processBatchAnchors({ force: true, orgId }) remains the single worker-owned
 * execution path for queue runs.
 */
import { z } from 'zod';
import { db, isTransientConnectionError } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { dbUuid, parseDbRows } from '../utils/db-row-validation.js';
import { processBatchAnchors, type BatchAnchorResult } from './batch-anchor.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';

const CLAIM_LIMIT_DEFAULT = 25;

/**
 * BUG-2026-08-12-003 / FD-15.
 *
 * `org_id` is a Postgres `uuid` column handed back by `claim_due_org_queue_runs`,
 * so it is shape-checked, not RFC-checked — see `utils/db-row-validation.ts`.
 * Zod 4.4.3's strict `.uuid()` rejected the seeded fixture orgs
 * (`aaaaaaaa-0000-0000-0000-000000000001`: zero version/variant nibbles) that
 * Postgres had accepted, which is how this scheduler returned INTERNAL on every
 * run for a whole soak. PR #2215 fixed the seed side; this is the validator side.
 *
 * `last_run_at` is `.catch(null)` on purpose: the scheduler never reads it (only
 * `org_id` is consumed below), so a malformed value in a field nobody uses must
 * not cost that organization its run.
 */
const ClaimedOrgSchema = z.object({
  org_id: dbUuid('org_id'),
  last_run_at: z.string().nullable().optional().catch(null),
});

type QueueRunTrigger = 'manual' | 'scheduled';
type QueueRunStatus = 'succeeded' | 'failed';

export interface OrgQueueSchedulerResult {
  claimed: number;
  succeeded: number;
  /**
   * SCRUM-3031: claimed orgs whose drain never ran because another instance
   * held the cross-instance batch run lease. Counted separately from
   * `succeeded` because these orgs did NOT get their run and must stay due.
   */
  skipped: number;
  failed: number;
  processed: number;
  /**
   * FD-15: claimed rows dropped because they failed row validation. These orgs
   * did NOT get a run and their claim could not be released (an unparseable
   * `org_id` is not a key we can write back with), so they stay locked until
   * `claim_due_org_queue_runs`'s own 15-minute lock timeout reclaims them.
   * Surfaced here — rather than swallowed — because quarantining is a degraded
   * mode that must be alertable.
   */
  quarantined: number;
}

interface SchedulerDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: (...args: unknown[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
}

interface SchedulerLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface SchedulerDeps {
  db?: SchedulerDb;
  logger?: SchedulerLogger;
  now?: () => Date;
  workerId?: string;
  env?: NodeJS.ProcessEnv;
  processBatchAnchors?: (opts: { force: true; orgId: string }) => Promise<BatchAnchorResult>;
  emitOrgAdminNotifications?: typeof emitOrgAdminNotifications;
}

export interface RecordOrgQueueRunArgs {
  orgId: string;
  trigger: QueueRunTrigger;
  status: QueueRunStatus;
  startedAt: Date;
  finishedAt: Date;
  processed: number;
  batchId: string | null;
  merkleRoot: string | null;
  txId: string | null;
  workerId?: string | null;
  triggeredBy?: string | null;
  error?: string | null;
}

function getDeps(deps: SchedulerDeps = {}): Required<Omit<SchedulerDeps, 'workerId'>> & { workerId: string } {
  return {
    db: deps.db ?? (db as unknown as SchedulerDb),
    logger: deps.logger ?? logger,
    now: deps.now ?? (() => new Date()),
    workerId: deps.workerId ?? `org-queue-${process.pid}`,
    env: deps.env ?? process.env,
    processBatchAnchors: deps.processBatchAnchors ?? ((opts) => processBatchAnchors(opts)),
    emitOrgAdminNotifications: deps.emitOrgAdminNotifications ?? emitOrgAdminNotifications,
  };
}

function buildIdempotencyKey(args: RecordOrgQueueRunArgs): string {
  const actor = args.triggeredBy ?? args.workerId ?? 'system';
  return `${args.trigger}:${args.orgId}:${args.startedAt.toISOString()}:${actor}`;
}

export async function recordOrgQueueRunResult(
  args: RecordOrgQueueRunArgs,
  deps: Pick<SchedulerDeps, 'db' | 'logger'> = {},
): Promise<void> {
  const actual = getDeps(deps);
  const idempotencyKey = buildIdempotencyKey(args);
  const errorText = args.error ? args.error.slice(0, 4000) : null;

  try {
    const { error: historyError } = await actual.db
      .from('organization_queue_runs')
      .insert({
        org_id: args.orgId,
        trigger: args.trigger,
        status: args.status,
        idempotency_key: idempotencyKey,
        worker_id: args.workerId ?? null,
        triggered_by: args.triggeredBy ?? null,
        started_at: args.startedAt.toISOString(),
        finished_at: args.finishedAt.toISOString(),
        processed_count: args.processed,
        batch_id: args.batchId,
        merkle_root: args.merkleRoot,
        tx_id: args.txId,
        error: errorText,
      });

    if (historyError && (historyError as { code?: string }).code !== '23505') {
      actual.logger.warn(
        { error: historyError, orgId: args.orgId, trigger: args.trigger },
        'org queue run history insert failed',
      );
    }
  } catch (err) {
    actual.logger.warn(
      { error: err, orgId: args.orgId, trigger: args.trigger },
      'org queue run history insert threw',
    );
  }

  const finishedAt = args.finishedAt.toISOString();
  await upsertOrgQueueRunState(
    {
      org_id: args.orgId,
      last_run_at: finishedAt,
      ...(args.status === 'succeeded' ? { last_success_at: finishedAt } : {}),
      last_run_status: args.status,
      last_run_trigger: args.trigger,
      last_error: errorText,
      locked_at: null,
      locked_by: null,
      updated_at: finishedAt,
    },
    actual,
    { orgId: args.orgId, trigger: args.trigger },
    'org queue run state upsert',
  );
}

/**
 * The single `organization_queue_run_state` writer. Best-effort by design: a
 * failed state write must not mask the run's real outcome.
 *
 * The PAYLOAD is deliberately the caller's, not this function's. PostgREST's
 * upsert assigns only the columns it is given, and which columns a caller omits
 * is load-bearing — `releaseOrgQueueClaim` leaving out `last_run_at` is exactly
 * what keeps a skipped org due. A mode flag here instead of caller-owned
 * payloads would put the skip path one boolean away from asserting run evidence
 * it does not have, which is the bug class SCRUM-3031 is closing.
 */
async function upsertOrgQueueRunState(
  payload: Record<string, unknown>,
  deps: ReturnType<typeof getDeps>,
  logContext: Record<string, unknown>,
  what: string,
): Promise<void> {
  try {
    const { error } = await deps.db
      .from('organization_queue_run_state')
      .upsert(payload, { onConflict: 'org_id' });
    if (error) {
      deps.logger.warn({ error, ...logContext }, `${what} failed`);
    }
  } catch (err) {
    deps.logger.warn({ error: err, ...logContext }, `${what} threw`);
  }
}

/**
 * Hands a claimed org straight back without touching its due clock (SCRUM-3031).
 *
 * Used only when the batch run lease refused the drain. Clearing `locked_at` /
 * `locked_by` is required — `claim_due_org_queue_runs` will not re-offer a
 * locked org — but `last_run_at`, `last_run_status` and `last_success_at` are
 * deliberately absent from the payload: PostgREST's upsert only assigns the
 * columns it is given, so the org's existing due state survives untouched and
 * it is due again on the very next scheduler pass.
 */
async function releaseOrgQueueClaim(
  orgId: string,
  deps: ReturnType<typeof getDeps>,
): Promise<void> {
  await upsertOrgQueueRunState(
    { org_id: orgId, locked_at: null, locked_by: null, updated_at: deps.now().toISOString() },
    deps,
    { orgId },
    'org queue claim release after a run-lease skip',
  );
}

/**
 * Incident 2026-07-29 (launch-72h/legacy-soak signet rigs): `claim_due_org_queue_runs`
 * is a PostgREST RPC — always a POST — and db.ts's outbound fetch wrapper
 * deliberately never auto-retries POST/RPC calls (SCRUM-2899: a retried WRITE
 * could double-apply if the transport failure fired AFTER the server already
 * committed). Under loadgen connection pressure a rotten idle socket threw
 * `fetch failed` / ECONNRESET on this exact call *after* Postgres had already
 * committed the row lock, so the throw escaped before the per-org try/catch in
 * `runOrgQueueScheduler` (the thing that actually clears `locked_at`) —
 * stranding the claimed org in `last_run_status='running'` until the RPC's own
 * 15-minute lock timeout, at which point the next tick reclaimed it and hit the
 * same failure again. Confirmed live: `organization_queue_runs` (the
 * completion-history table) stayed completely empty for the whole soak despite
 * dozens of ticks with due orgs.
 *
 * Unlike a generic RPC write, this one is safe to retry: `claim_due_org_queue_runs`
 * uses `FOR UPDATE SKIP LOCKED`, so a retry can only pick up orgs NOT already
 * locked by a prior (possibly-phantom-committed) attempt — it can never
 * double-claim or cause `processBatchAnchors` to run twice for the same org
 * from a single scheduler pass. One bounded retry on a fresh socket, exactly
 * mirroring the read-path pattern in db.ts's `createResilientFetch`.
 */
async function claimDueOrganizations(
  deps: ReturnType<typeof getDeps>,
  limit: number,
): Promise<{ rows: Array<{ org_id: string; last_run_at: string | null }>; quarantined: number }> {
  const now = deps.now();
  const params = {
    p_now: now.toISOString(),
    p_worker_id: deps.workerId,
    p_limit: limit,
  };

  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await deps.db.rpc('claim_due_org_queue_runs', params));
  } catch (err) {
    if (!isTransientConnectionError(err)) throw err;
    deps.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'claim_due_org_queue_runs transport failure — retrying once on a fresh socket (safe: FOR UPDATE SKIP LOCKED)',
    );
    ({ data, error } = await deps.db.rpc('claim_due_org_queue_runs', params));
  }

  if (error && isTransientConnectionError(error)) {
    deps.logger.warn(
      { err: (error as { message?: string }).message ?? String(error) },
      'claim_due_org_queue_runs transport failure — retrying once on a fresh socket (safe: FOR UPDATE SKIP LOCKED)',
    );
    ({ data, error } = await deps.db.rpc('claim_due_org_queue_runs', params));
  }

  if (error) {
    throw new Error(`claim_due_org_queue_runs failed: ${(error as { message?: string }).message ?? 'unknown error'}`);
  }

  // BUG-2026-08-12-003 / FD-15: per-row, NOT `z.array(...).safeParse`. The
  // wholesale parse threw on the first bad row, so one malformed value denied
  // service to every other org in the claim batch — the entire scheduler pass
  // returned INTERNAL. A bad row is now quarantined and logged loudly; the rest
  // of the batch still runs. A non-array payload still throws: that is a broken
  // query contract, not one poison row, and there is nothing to salvage.
  const { rows, quarantined } = parseDbRows(ClaimedOrgSchema, data ?? [], {
    source: 'claim_due_org_queue_runs',
    logger: deps.logger,
  });

  return {
    rows: rows.map((row) => ({
      org_id: row.org_id,
      last_run_at: row.last_run_at ?? null,
    })),
    quarantined,
  };
}

export async function runOrgQueueScheduler(
  opts: { limit?: number } = {},
  injected: SchedulerDeps = {},
): Promise<OrgQueueSchedulerResult> {
  const deps = getDeps(injected);
  const result: OrgQueueSchedulerResult = {
    claimed: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    processed: 0,
    quarantined: 0,
  };

  if (deps.env.ENABLE_ORG_QUEUE_SCHEDULER === 'false') {
    deps.logger.info('Org queue scheduler disabled via ENABLE_ORG_QUEUE_SCHEDULER=false');
    return result;
  }

  const limit = Math.max(1, Math.min(opts.limit ?? CLAIM_LIMIT_DEFAULT, 100));
  const { rows: claimed, quarantined } = await claimDueOrganizations(deps, limit);
  result.claimed = claimed.length;
  result.quarantined = quarantined;
  if (claimed.length === 0) {
    if (quarantined > 0) deps.logger.info(result, 'Org queue scheduler pass complete');
    return result;
  }

  for (const row of claimed) {
    const startedAt = deps.now();
    try {
      const batch = await deps.processBatchAnchors({ force: true, orgId: row.org_id });

      // SCRUM-3031: the drain never ran — another instance holds the batch run
      // lease. Release the claim so this org is immediately re-claimable, but
      // do NOT write run evidence: `recordOrgQueueRunResult` sets `last_run_at`,
      // and `claim_due_org_queue_runs` only re-offers an org 24 hours after
      // that. Recording a refusal as a run would defer a real drain by a day
      // and file an `organization_queue_runs` row saying it succeeded.
      if (batch.skipped) {
        result.skipped += 1;
        await releaseOrgQueueClaim(row.org_id, deps);
        continue;
      }

      const finishedAt = deps.now();
      // BUG-2026-08-01-F9: processBatchAnchors does NOT throw on a definitive
      // broadcast rejection (e.g. UTXO contention with a concurrently-running
      // org's batch) — by design, that outcome is resolved and self-healing,
      // not an exception. Without this check, `batch.processed === 0` from a
      // rejection was indistinguishable from "nothing was due" and got
      // recorded status='succeeded' — exactly what happened live in prod
      // 2026-08-01T18:49:31Z for org 40383eb2-f1cd-4a85-8099-afafff95e5cf.
      // `rejectedReason` is only ever set on a fully-unwound definitive
      // reject (batch-anchor.ts), so this is a precise signal, not a guess
      // from `processed === 0` (which is also the ambiguous HOLD/DEFER shape).
      const rejected = typeof batch.rejectedReason === 'string' && batch.rejectedReason.length > 0;
      if (rejected) {
        result.failed += 1;
        deps.logger.warn(
          { orgId: row.org_id, reason: batch.rejectedReason },
          'scheduled org queue run: batch broadcast definitively rejected — recording as failed (self-healing, expected to clear on next drain)',
        );
      } else {
        result.succeeded += 1;
      }
      result.processed += batch.processed;
      await recordOrgQueueRunResult(
        {
          orgId: row.org_id,
          trigger: 'scheduled',
          status: rejected ? 'failed' : 'succeeded',
          startedAt,
          finishedAt,
          processed: batch.processed,
          batchId: batch.batchId,
          merkleRoot: batch.merkleRoot,
          txId: batch.txId,
          workerId: deps.workerId,
          error: rejected ? (batch.rejectedReason ?? null) : null,
        },
        deps,
      );

      if (!rejected && batch.processed > 0) {
        await deps.emitOrgAdminNotifications({
          type: 'queue_run_completed',
          organizationId: row.org_id,
          payload: {
            trigger: 'scheduled',
            processed: batch.processed,
            batchId: batch.batchId,
            txId: batch.txId,
            merkleRoot: batch.merkleRoot,
          },
        });
      }
    } catch (err) {
      const finishedAt = deps.now();
      result.failed += 1;
      const error = err instanceof Error ? err.message : 'scheduled org queue run failed';
      await recordOrgQueueRunResult(
        {
          orgId: row.org_id,
          trigger: 'scheduled',
          status: 'failed',
          startedAt,
          finishedAt,
          processed: 0,
          batchId: null,
          merkleRoot: null,
          txId: null,
          workerId: deps.workerId,
          error,
        },
        deps,
      );
      deps.logger.error({ error: err, orgId: row.org_id }, 'scheduled org queue run failed');
    }
  }

  deps.logger.info(result, 'Org queue scheduler pass complete');
  return result;
}

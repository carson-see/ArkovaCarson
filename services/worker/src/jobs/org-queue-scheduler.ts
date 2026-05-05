/**
 * Durable 24-hour organization queue scheduler (SCRUM-1130).
 *
 * Claims due organizations via a Postgres RPC, then runs the existing
 * org-scoped batch path. This module intentionally does not anchor directly;
 * processBatchAnchors({ force: true, orgId }) remains the single worker-owned
 * execution path for queue runs.
 */
import { z } from 'zod';
import { db } from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { processBatchAnchors, type BatchAnchorResult } from './batch-anchor.js';
import { emitOrgAdminNotifications } from '../notifications/dispatcher.js';

const CLAIM_LIMIT_DEFAULT = 25;

const ClaimedOrgSchema = z.object({
  org_id: z.string().uuid(),
  last_run_at: z.string().nullable().optional(),
});

type QueueRunTrigger = 'manual' | 'scheduled';
type QueueRunStatus = 'succeeded' | 'failed';

export interface OrgQueueSchedulerResult {
  claimed: number;
  succeeded: number;
  failed: number;
  processed: number;
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

  try {
    const finishedAt = args.finishedAt.toISOString();
    const statePayload = {
      org_id: args.orgId,
      last_run_at: finishedAt,
      ...(args.status === 'succeeded' ? { last_success_at: finishedAt } : {}),
      last_run_status: args.status,
      last_run_trigger: args.trigger,
      last_error: errorText,
      locked_at: null,
      locked_by: null,
      updated_at: finishedAt,
    };

    const { error: stateError } = await actual.db
      .from('organization_queue_run_state')
      .upsert(statePayload, { onConflict: 'org_id' });

    if (stateError) {
      actual.logger.warn(
        { error: stateError, orgId: args.orgId, trigger: args.trigger },
        'org queue run state upsert failed',
      );
    }
  } catch (err) {
    actual.logger.warn(
      { error: err, orgId: args.orgId, trigger: args.trigger },
      'org queue run state upsert threw',
    );
  }
}

async function claimDueOrganizations(
  deps: ReturnType<typeof getDeps>,
  limit: number,
): Promise<Array<{ org_id: string; last_run_at: string | null }>> {
  const now = deps.now();
  const { data, error } = await deps.db.rpc('claim_due_org_queue_runs', {
    p_now: now.toISOString(),
    p_worker_id: deps.workerId,
    p_limit: limit,
  });

  if (error) {
    throw new Error(`claim_due_org_queue_runs failed: ${(error as { message?: string }).message ?? 'unknown error'}`);
  }

  const parsed = z.array(ClaimedOrgSchema).safeParse(data ?? []);
  if (!parsed.success) {
    throw new Error(`claim_due_org_queue_runs returned invalid rows: ${parsed.error.message}`);
  }
  return parsed.data.map((row) => ({
    org_id: row.org_id,
    last_run_at: row.last_run_at ?? null,
  }));
}

export async function runOrgQueueScheduler(
  opts: { limit?: number } = {},
  injected: SchedulerDeps = {},
): Promise<OrgQueueSchedulerResult> {
  const deps = getDeps(injected);
  const result: OrgQueueSchedulerResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    processed: 0,
  };

  if (deps.env.ENABLE_ORG_QUEUE_SCHEDULER === 'false') {
    deps.logger.info('Org queue scheduler disabled via ENABLE_ORG_QUEUE_SCHEDULER=false');
    return result;
  }

  const limit = Math.max(1, Math.min(opts.limit ?? CLAIM_LIMIT_DEFAULT, 100));
  const claimed = await claimDueOrganizations(deps, limit);
  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  for (const row of claimed) {
    const startedAt = deps.now();
    try {
      const batch = await deps.processBatchAnchors({ force: true, orgId: row.org_id });
      const finishedAt = deps.now();
      result.succeeded += 1;
      result.processed += batch.processed;
      await recordOrgQueueRunResult(
        {
          orgId: row.org_id,
          trigger: 'scheduled',
          status: 'succeeded',
          startedAt,
          finishedAt,
          processed: batch.processed,
          batchId: batch.batchId,
          merkleRoot: batch.merkleRoot,
          txId: batch.txId,
          workerId: deps.workerId,
        },
        deps,
      );

      if (batch.processed > 0) {
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

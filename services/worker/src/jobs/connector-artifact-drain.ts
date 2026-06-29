/**
 * QUEUE-06 (SCRUM-2352) — connector_artifact drain consumer (THE LOOP-CLOSER).
 *
 * `connector_artifact` (mig 0343) is the inbox connectors write into via the
 * idempotent `enqueue_connector_artifact` RPC. Enqueue NEVER debits credits;
 * the debit lands here, at SECURING, via the live `debit_and_enqueue_anchor`
 * RPC (mig 0341). This module is the missing consumer that drains those rows.
 *
 * Lifecycle (per row): pending|queued → processing → materialized → anchored,
 * or → failed. Skipped rows are out of scope here (the producer sets them).
 *
 * EXACTLY-ONCE / CONCURRENCY SAFETY (no migration):
 *   The claim is a per-row compare-and-set UPDATE:
 *     UPDATE connector_artifact SET status='processing'
 *       WHERE id = :id AND org_id = :org AND status IN ('pending','queued')
 *       RETURNING id
 *   Postgres evaluates this atomically under a row lock, so two concurrent
 *   drain cycles racing the same row: the winner's UPDATE matches and returns
 *   the row; the loser's UPDATE matches ZERO rows (status already 'processing')
 *   and returns null → it skips. This is the exactly-once guarantee a
 *   `FOR UPDATE SKIP LOCKED` claim gives, achieved without a new migration (the
 *   rule for this story is NO new migration). A row is never claimed — and
 *   therefore never materialized/charged/anchored — twice. The credit debit is
 *   *additionally* idempotent: `debit_and_enqueue_anchor` keys the DEBIT on the
 *   anchor id, so even a crash between claim and debit re-drives the SAME single
 *   charge (never a double-debit).
 *
 * §1.6A: this module handles ONLY the server-computed fingerprint + bounded,
 * PII-scrubbed metadata that already live on the row. It never reads, fetches,
 * logs, or alerts raw document bytes. Alerts carry ids + a bounded reason only.
 *
 * §-credit: the charge is `debitAndEnqueueAnchor` AT SECURING and nowhere else.
 */
import { db as defaultDb } from '../utils/db.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { processBatchAnchors, type BatchAnchorResult } from './batch-anchor.js';
import { callRpc } from '../utils/rpc.js';
import { Sentry } from '../utils/sentry.js';

/** Page size per drain pass per org — bounded so one org can't starve the cycle. */
const DRAIN_LIMIT_DEFAULT = 50;
const DRAIN_LIMIT_MAX = 200;

/** The two pre-claim statuses a row can be drained from. */
const DRAINABLE_STATUSES = ['pending', 'queued'] as const;

/** Shape of a connector_artifact row we read (0343 columns; not yet in head types). */
export interface ConnectorArtifactRow {
  id: string;
  org_id: string;
  status: string;
  fingerprint_sha256: string;
  byte_length: number | null;
  source: string;
  external_ref: string;
  metadata: Record<string, unknown> | null;
  anchor_id: string | null;
  credit_deduction_id: string | null;
}

export interface MaterializedAnchor {
  anchorId: string;
  anchorPublicId: string | null;
}

export interface DebitResult {
  success: boolean;
  error?: string;
}

/** Bounded, PII-scrubbed alert payload (§1.6A — never raw bytes/fingerprint). */
export interface ConnectorArtifactAlert {
  scope: 'row' | 'cycle';
  orgId: string;
  artifactId?: string;
  reason: string;
}

interface DrainLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface DrainDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc?: (...args: unknown[]) => any;
}

export interface ConnectorArtifactDrainDeps {
  db: DrainDb;
  logger: DrainLogger;
  /** Materialize a PENDING anchor from a claimed artifact (fingerprint-only). */
  materializeAnchor: (row: ConnectorArtifactRow) => Promise<MaterializedAnchor>;
  /** Charge AT SECURING via debit_and_enqueue_anchor (mig 0341). */
  debitAndEnqueueAnchor: (args: { orgId: string; anchorId: string }) => Promise<DebitResult>;
  /** The single worker-owned anchoring path (org-scoped). */
  batchAnchor: (opts: { force: true; orgId: string }) => Promise<BatchAnchorResult>;
  /** Emit a bounded, PII-scrubbed alert. Never throws into the drain loop. */
  emitAlert: (alert: ConnectorArtifactAlert) => void;
  /** Page size per pass. */
  limit?: number;
}

export interface ConnectorArtifactDrainResult {
  claimed: number;
  anchored: number;
  failed: number;
}

/**
 * Default Sentry-backed alert. Bounded scalar fields only — no row object, no
 * fingerprint, no bytes (§1.6A). A failure to alert is swallowed so it never
 * aborts the drain.
 */
function defaultEmitAlert(alert: ConnectorArtifactAlert): void {
  try {
    Sentry.captureMessage(`connector-artifact-drain ${alert.scope} failure`, {
      level: 'error',
      tags: { job: 'connector-artifact-drain', scope: alert.scope },
      extra: {
        org_id: alert.orgId,
        artifact_id: alert.artifactId,
        reason: alert.reason,
      },
    });
  } catch {
    /* alerting is best-effort — never fail the drain on a telemetry hiccup */
  }
}

/** Safely read a string field from the artifact's bounded `metadata` JSON. */
function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
  if (metadata && typeof metadata === 'object') {
    const v = metadata[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Resolve an org owner/admin actor user_id for the anchor's required `user_id`
 * column. Mirrors `rule-action-dispatcher.resolveAnchorActorUserId`: an anchor
 * must be owned by a real org member, and a connector row has no inherent user.
 * Owner-inclusive: prefers `owner`, then `admin`.
 */
async function resolveOrgActorUserId(
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
  orgId: string,
): Promise<string> {
  const { data, error } = await deps.db
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .in('role', ['owner', 'admin'])
    .order('role', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`actor lookup failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  }
  const userId = (data as { user_id?: string } | null)?.user_id;
  if (!userId) throw new Error('no org owner/admin actor for connector artifact');
  return userId;
}

/**
 * Default materializer: insert a PENDING anchor from the artifact's
 * server-computed fingerprint (§1.6A — fingerprint only, never bytes). The
 * anchor schema requires `user_id` (resolved to an org owner/admin actor) and
 * `filename`; `credential_type` is CONTRACT_POSTSIGNING (the connector-sourced
 * credential type, matching the DocuSign rules-engine path). Idempotent on the
 * `(user_id, fingerprint) WHERE deleted_at IS NULL` unique index: a 23505 means
 * an earlier pass already created the anchor, so we resolve and reuse it rather
 * than failing the row.
 */
async function defaultMaterializeAnchor(
  row: ConnectorArtifactRow,
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<MaterializedAnchor> {
  const userId = await resolveOrgActorUserId(deps, row.org_id);
  const filename =
    metadataString(row.metadata, 'filename') ??
    metadataString(row.metadata, 'external_filename') ??
    `${row.source}:${row.external_ref}`.slice(0, 255);

  const insertPayload = {
    fingerprint: row.fingerprint_sha256,
    status: 'PENDING' as const,
    org_id: row.org_id,
    user_id: userId,
    filename,
    credential_type: 'CONTRACT_POSTSIGNING' as const,
    metadata: {
      connector_source: row.source,
      connector_artifact_id: row.id,
      external_ref: row.external_ref,
      ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
    },
  };

  const { data, error } = await deps.db
    .from('anchors')
    .insert(insertPayload)
    .select('id, public_id')
    .single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const { data: existing, error: lookupError } = await deps.db
        .from('anchors')
        .select('id, public_id')
        .eq('org_id', row.org_id)
        .eq('user_id', userId)
        .eq('fingerprint', row.fingerprint_sha256)
        .is('deleted_at', null)
        .neq('status', 'REVOKED')
        .maybeSingle();
      if (lookupError || !existing) {
        throw new Error(
          `materialize duplicate-resolve failed: ${(lookupError as { message?: string })?.message ?? 'no row'}`,
        );
      }
      return { anchorId: existing.id as string, anchorPublicId: (existing.public_id as string) ?? null };
    }
    throw new Error(`materialize anchor failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  }

  return { anchorId: data.id as string, anchorPublicId: (data.public_id as string) ?? null };
}

/**
 * Default debit at SECURING via the live mig-0341 RPC. The RPC atomically
 * debits one credit AND transitions the anchor PENDING → BROADCASTING in one
 * txn; idempotent on the anchor id (a replay re-drives the same single charge).
 */
async function defaultDebitAndEnqueueAnchor(
  args: { orgId: string; anchorId: string },
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<DebitResult> {
  const { data, error } = await callRpc<{ success: boolean; error?: string }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.db as any,
    'debit_and_enqueue_anchor',
    {
      p_org_id: args.orgId,
      p_anchor_id: args.anchorId,
      p_amount: 1,
      p_reason: 'anchor.secure',
      p_target_status: 'BROADCASTING',
      p_expected_status: 'PENDING',
    },
  );
  if (error) return { success: false, error: error.message ?? 'debit rpc error' };
  const result = data as { success?: boolean; error?: string } | null;
  if (!result?.success) return { success: false, error: result?.error ?? 'debit failed' };
  return { success: true };
}

function getDeps(injected: Partial<ConnectorArtifactDrainDeps>): ConnectorArtifactDrainDeps {
  const db = injected.db ?? (defaultDb as unknown as DrainDb);
  return {
    db,
    logger: injected.logger ?? (defaultLogger as unknown as DrainLogger),
    materializeAnchor: injected.materializeAnchor ?? ((row) => defaultMaterializeAnchor(row, { db })),
    debitAndEnqueueAnchor: injected.debitAndEnqueueAnchor ?? ((args) => defaultDebitAndEnqueueAnchor(args, { db })),
    batchAnchor: injected.batchAnchor ?? ((opts) => processBatchAnchors(opts)),
    emitAlert: injected.emitAlert ?? defaultEmitAlert,
    limit: injected.limit,
  };
}

/**
 * Claim a single row with a compare-and-set UPDATE. Returns true only if THIS
 * call transitioned it pending|queued → processing. A concurrent winner leaves
 * the loser's UPDATE matching zero rows → false (skip, never double-anchor).
 */
async function claimRow(deps: ConnectorArtifactDrainDeps, orgId: string, id: string): Promise<boolean> {
  const { data, error } = await deps.db
    .from('connector_artifact')
    .update({ status: 'processing', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId)
    .in('status', DRAINABLE_STATUSES as unknown as string[])
    .select('id')
    .maybeSingle();

  if (error) {
    deps.logger.warn({ error, artifactId: id, orgId }, 'connector-artifact claim failed');
    return false;
  }
  return data != null;
}

/**
 * Drain `connector_artifact` rows for ONE org. Strictly org-scoped: every read,
 * claim, and write filters on `org_id`, so draining one org never touches
 * another's rows (cross-org isolation).
 */
export async function drainConnectorArtifactsForOrg(
  orgId: string,
  injected: Partial<ConnectorArtifactDrainDeps> = {},
): Promise<ConnectorArtifactDrainResult> {
  const deps = getDeps(injected);
  const limit = Math.max(1, Math.min(deps.limit ?? DRAIN_LIMIT_DEFAULT, DRAIN_LIMIT_MAX));
  const result: ConnectorArtifactDrainResult = { claimed: 0, anchored: 0, failed: 0 };

  // Candidate rows for THIS org only.
  const { data: candidates, error: selectError } = await deps.db
    .from('connector_artifact')
    .select('id, org_id, status, fingerprint_sha256, byte_length, source, external_ref, metadata, anchor_id, credit_deduction_id')
    .eq('org_id', orgId)
    .in('status', DRAINABLE_STATUSES as unknown as string[])
    .order('created_at', { ascending: true })
    .limit(limit);

  if (selectError) {
    // Cycle-level failure: log + alert, then surface so the caller (cron route)
    // returns non-200 and Cloud Scheduler retries. NO silent drop.
    deps.emitAlert({ scope: 'cycle', orgId, reason: `select failed: ${(selectError as { message?: string }).message ?? 'unknown'}` });
    throw new Error(`connector-artifact select failed for org ${orgId}`);
  }

  const rows = (candidates ?? []) as ConnectorArtifactRow[];
  if (rows.length === 0) return result;

  for (const row of rows) {
    // Concurrency-safe claim. A loser (already 'processing') skips silently —
    // it is NOT a failure, it's the exactly-once guarantee working.
    const claimed = await claimRow(deps, orgId, row.id);
    if (!claimed) continue;
    result.claimed += 1;

    try {
      // 1) Materialize a PENDING anchor (fingerprint-only, §1.6A).
      const { anchorId } = await deps.materializeAnchor(row);
      await markStatus(deps, orgId, row.id, 'materialized', { anchor_id: anchorId });

      // 2) Charge AT SECURING — and ONLY here. Never at enqueue/claim.
      const debit = await deps.debitAndEnqueueAnchor({ orgId, anchorId });
      if (!debit.success) {
        // Insufficient credits / debit failure → mark failed + bounded alert.
        // No batch-anchor, no silent drop. The row is reviewable; the producer
        // can be re-driven once credits land.
        await markFailed(deps, orgId, row.id, debit.error ?? 'debit_failed');
        deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: debit.error ?? 'debit_failed' });
        result.failed += 1;
        continue;
      }

      // 3) Batch-anchor through the single worker-owned org-scoped path.
      const batch = await deps.batchAnchor({ force: true, orgId });

      // 4) Terminal: mark the artifact anchored + backlink the anchor.
      await markStatus(deps, orgId, row.id, 'anchored', { anchor_id: anchorId });
      result.anchored += 1;
      deps.logger.info(
        { orgId, artifactId: row.id, anchorId, batchId: batch.batchId, processed: batch.processed },
        'connector-artifact anchored',
      );
    } catch (err) {
      // Per-row failure isolation: this row fails, the loop continues.
      const reason = err instanceof Error ? err.message : 'drain row failed';
      await markFailed(deps, orgId, row.id, reason);
      deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason });
      deps.logger.error({ error: err, orgId, artifactId: row.id }, 'connector-artifact row drain failed');
      result.failed += 1;
    }
  }

  deps.logger.info({ orgId, ...result }, 'connector-artifact drain pass complete');
  return result;
}

async function markStatus(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  id: string,
  status: 'materialized' | 'anchored',
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await deps.db
    .from('connector_artifact')
    .update({ status, updated_at: new Date().toISOString(), ...extra })
    .eq('id', id)
    .eq('org_id', orgId);
  if (error) {
    deps.logger.warn({ error, orgId, artifactId: id, status }, `connector-artifact mark-${status} failed`);
  }
}

async function markFailed(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await deps.db
    .from('connector_artifact')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId);
  if (error) {
    // A row stuck in 'processing' because we couldn't even mark it failed is the
    // ONE thing we must never hide — log loudly.
    deps.logger.error({ error, orgId, artifactId: id, reason }, 'connector-artifact mark-failed failed (row stuck processing)');
  }
}

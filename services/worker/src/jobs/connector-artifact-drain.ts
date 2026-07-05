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
import { z } from 'zod';
import { db as defaultDb } from '../utils/db.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { processBatchAnchors, type BatchAnchorResult } from './batch-anchor.js';
import { callRpc } from '../utils/rpc.js';
import { Sentry } from '../utils/sentry.js';
import { config } from '../config.js';

/**
 * Strict Zod schema for the `anchors` insert this job persists (CLAUDE.md §1.2:
 * Zod on every write path). The `metadata` carries semi-external artifact fields,
 * so validate the whole row shape before insert — a malformed fingerprint /
 * empty filename / wrong status is rejected before it reaches Postgres. The
 * status-update writes (claim/markStatus/markFailed/markRequeued) persist
 * server-controlled status LITERALS only, so they don't need a schema.
 */
const AnchorInsertPayload = z
  .object({
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'fingerprint must be 64-hex sha256'),
    status: z.literal('PENDING'),
    org_id: z.string().uuid(),
    user_id: z.string().uuid(),
    filename: z.string().min(1).max(255),
    credential_type: z.literal('CONTRACT_POSTSIGNING'),
    metadata: z.record(z.string(), z.unknown()),
  })
  .strict();

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
  /**
   * Design-C (mig 0353): reset this org's drain-charged-but-never-batch-claimed
   * connector anchors (BROADCASTING, null tx) back to PENDING so `batchAnchor`
   * claims + submits them promptly — closing the submission-latency gap without
   * touching the (already-landed, exactly-once) charge. Returns rows reset.
   */
  resetUnclaimedConnectorBroadcasts: (args: { orgId: string; limit?: number }) => Promise<number>;
  /** The single worker-owned anchoring path (org-scoped). */
  batchAnchor: (opts: { force: true; orgId: string }) => Promise<BatchAnchorResult>;
  /**
   * Re-read the SPECIFIC anchor (org-scoped) to confirm it advanced past PENDING
   * before marking the artifact `anchored`. Returns null if the anchor is gone.
   */
  readAnchorStatus: (args: { orgId: string; anchorId: string }) => Promise<AnchorStatusRow | null>;
  /**
   * List this org's `materialized` artifacts (with an anchor_id) for the
   * CONFIRMATION re-read pass. Bounded by `limit`.
   */
  listMaterializedArtifacts: (args: { orgId: string; limit: number }) => Promise<MaterializedArtifactRef[]>;
  /** Emit a bounded, PII-scrubbed alert. Never throws into the drain loop. */
  emitAlert: (alert: ConnectorArtifactAlert) => void;
  /** Page size per pass. */
  limit?: number;
}

/** A materialized artifact + its anchor, for the confirmation re-read. */
export interface MaterializedArtifactRef {
  id: string;
  anchor_id: string | null;
}

/** Minimal anchor shape read back to confirm the specific anchor advanced. */
export interface AnchorStatusRow {
  id: string;
  status: string;
  chain_tx_id: string | null;
}

/**
 * An anchor is "advanced" — i.e. this artifact's anchoring has IRREVERSIBLY
 * progressed and the artifact may be marked terminally `anchored` — ONLY on a
 * submit/secure signal that the recovery path cannot undo:
 *   - a `chain_tx_id` is recorded (the tx has been broadcast), OR
 *   - status is `SUBMITTED` or `SECURED`.
 *
 * Crucially we do NOT accept bare `BROADCASTING` (with a null `chain_tx_id`).
 * `debit_and_enqueue_anchor` ITSELF moves the anchor PENDING → BROADCASTING, so
 * every successful debit would otherwise instantly satisfy "advanced" and mark
 * the artifact terminal — before the tx is ever broadcast. Worse,
 * `recover_stuck_broadcasts()` resets a stale `BROADCASTING`/null-tx anchor back
 * to PENDING, so BROADCASTING is a REVERSIBLE, not-yet-durable state. A
 * BROADCASTING/null-tx anchor must keep its artifact `materialized` (retryable),
 * to be promoted by the confirmation re-read once it gains a tx / SUBMITTED /
 * SECURED.
 */
const ADVANCED_ANCHOR_STATUSES = new Set(['SUBMITTED', 'SECURED']);
function isAnchorAdvanced(anchor: AnchorStatusRow | null): boolean {
  if (!anchor) return false;
  if (typeof anchor.chain_tx_id === 'string' && anchor.chain_tx_id.length > 0) return true;
  return ADVANCED_ANCHOR_STATUSES.has(anchor.status);
}

/**
 * Whether a `materialized` artifact's anchor is still legitimately IN FLIGHT
 * (debited, broadcasting, awaiting a tx) — so the row must be LEFT materialized
 * for the confirmation re-read, NOT re-queued (a re-queue → re-debit would hit
 * `debit_and_enqueue_anchor`'s `p_expected_status='PENDING'` rejection on an
 * already-BROADCASTING anchor). A null/PENDING anchor is NOT in-flight (it has
 * no forward progress, or was reset by recover_stuck_broadcasts) → it may be
 * re-queued to re-drive the debit.
 */
function isAnchorInFlight(anchor: AnchorStatusRow | null): boolean {
  if (!anchor) return false;
  if (isAnchorAdvanced(anchor)) return true;
  return anchor.status === 'BROADCASTING';
}

export interface ConnectorArtifactDrainResult {
  claimed: number;
  anchored: number;
  failed: number;
  /**
   * Rows promoted materialized → anchored by the CONFIRMATION re-read (an anchor
   * debited on a PRIOR pass that has now gained a tx / SUBMITTED / SECURED). A
   * subset of the work that produced `anchored`; tracked separately so a pass
   * that only confirmed in-flight rows (claimed:0, anchored>0) is legible.
   */
  confirmed: number;
  /**
   * Materialized rows whose anchor lost forward progress (PENDING again, or
   * gone) and were re-queued by the confirmation step to re-drive the debit.
   */
  reconfirmRequeued: number;
}

/**
 * Default Sentry-backed alert. Bounded scalar fields only — no row object, no
 * fingerprint, no bytes (§1.6A). A failure to alert is swallowed so it never
 * aborts the drain.
 */
/** Hard cap on the alert reason length at the sink — reasons can originate from
 * raw DB/RPC/Error messages, so bound them defensively (single line, truncated)
 * before they reach Sentry. Never leak an unbounded upstream payload. */
const MAX_ALERT_REASON_LEN = 200;
function boundReason(reason: string): string {
  const oneLine = String(reason ?? '').replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_ALERT_REASON_LEN ? `${oneLine.slice(0, MAX_ALERT_REASON_LEN)}…` : oneLine;
}

function defaultEmitAlert(alert: ConnectorArtifactAlert): void {
  try {
    Sentry.captureMessage(`connector-artifact-drain ${alert.scope} failure`, {
      level: 'error',
      tags: { job: 'connector-artifact-drain', scope: alert.scope },
      extra: {
        org_id: alert.orgId,
        artifact_id: alert.artifactId,
        reason: boundReason(alert.reason),
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
    // Spread the artifact's own metadata FIRST so the trusted connector fields
    // below always WIN — a (possibly attacker-influenced) metadata key named
    // `connector_source` / `connector_artifact_id` / `external_ref` can never
    // spoof the server-derived provenance fields.
    metadata: {
      ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
      connector_source: row.source,
      connector_artifact_id: row.id,
      external_ref: row.external_ref,
    },
  };

  // Validate the persisted row before insert (§1.2). Parse failures throw into
  // the per-row try/catch → the row is marked failed + alerted, never persisted.
  const validatedPayload = AnchorInsertPayload.parse(insertPayload);

  const { data, error } = await deps.db
    .from('anchors')
    .insert(validatedPayload)
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

/**
 * Default design-C reset via mig-0353 RPC. Resets this org's drain-charged,
 * never-batch-claimed connector anchors (BROADCASTING/null-tx) back to PENDING so
 * `batchAnchor` claims + submits them in the same pass. Best-effort: a failure just
 * leaves the anchors for the generic recover_stuck_broadcasts sweep (the original
 * latency behavior) — it NEVER blocks the drain and NEVER touches the charge.
 * Returns the number of anchors reset (0 on error).
 */
async function defaultResetUnclaimedConnectorBroadcasts(
  args: { orgId: string; limit?: number },
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<number> {
  const { data, error } = await callRpc<Array<{ id: string }>>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deps.db as any,
    'reset_unclaimed_connector_broadcasts',
    { p_org_id: args.orgId, p_limit: args.limit ?? 500 },
  );
  if (error) return 0;
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Default anchor re-read: fetch the SPECIFIC anchor (org-scoped) so the drain
 * can confirm IT advanced past PENDING before marking the artifact `anchored`,
 * rather than trusting the aggregate batch count. Returns null if the row is
 * missing (or on error — the caller treats null as "not confirmed advanced",
 * keeping the artifact retryable rather than terminally-anchored on a flake).
 */
async function defaultReadAnchorStatus(
  args: { orgId: string; anchorId: string },
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<AnchorStatusRow | null> {
  const { data, error } = await deps.db
    .from('anchors')
    .select('id, status, chain_tx_id')
    .eq('id', args.anchorId)
    .eq('org_id', args.orgId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id as string,
    status: data.status as string,
    chain_tx_id: (data.chain_tx_id as string | null) ?? null,
  };
}

/**
 * Default `materialized` artifact enumerator (org-scoped) for the confirmation
 * re-read. Only rows with an anchor_id can be confirmed; a materialized row with
 * a null anchor_id is anomalous and left for the reaper/operator.
 */
async function defaultListMaterializedArtifacts(
  args: { orgId: string; limit: number },
  deps: Pick<ConnectorArtifactDrainDeps, 'db'>,
): Promise<MaterializedArtifactRef[]> {
  const { data, error } = await deps.db
    .from('connector_artifact')
    .select('id, anchor_id')
    .eq('org_id', args.orgId)
    .eq('status', 'materialized')
    .order('updated_at', { ascending: true })
    .limit(args.limit);
  if (error) {
    throw new Error(`materialized enumeration failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  }
  return ((data ?? []) as Array<{ id?: string; anchor_id?: string | null }>)
    .filter((r): r is { id: string; anchor_id: string | null } => typeof r.id === 'string')
    .map((r) => ({ id: r.id, anchor_id: r.anchor_id ?? null }));
}

function getDeps(injected: Partial<ConnectorArtifactDrainDeps>): ConnectorArtifactDrainDeps {
  const db = injected.db ?? (defaultDb as unknown as DrainDb);
  return {
    db,
    logger: injected.logger ?? (defaultLogger as unknown as DrainLogger),
    materializeAnchor: injected.materializeAnchor ?? ((row) => defaultMaterializeAnchor(row, { db })),
    debitAndEnqueueAnchor: injected.debitAndEnqueueAnchor ?? ((args) => defaultDebitAndEnqueueAnchor(args, { db })),
    resetUnclaimedConnectorBroadcasts:
      injected.resetUnclaimedConnectorBroadcasts ?? ((args) => defaultResetUnclaimedConnectorBroadcasts(args, { db })),
    batchAnchor: injected.batchAnchor ?? ((opts) => processBatchAnchors(opts)),
    readAnchorStatus: injected.readAnchorStatus ?? ((args) => defaultReadAnchorStatus(args, { db })),
    listMaterializedArtifacts:
      injected.listMaterializedArtifacts ?? ((args) => defaultListMaterializedArtifacts(args, { db })),
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
 * CONFIRMATION re-read over this org's `materialized` rows. For each, re-read
 * the SPECIFIC anchor and reconcile WITHOUT a re-debit (the anchor is already
 * past PENDING once debited, so a re-debit would be rejected):
 *
 *   - anchor ADVANCED (tx / SUBMITTED / SECURED, irreversible) → promote the
 *     artifact materialized → `anchored` (status-guarded). Counts anchored +
 *     confirmed.
 *   - anchor IN FLIGHT (BROADCASTING, null tx — debited, not yet broadcast) →
 *     LEAVE `materialized`. Re-queuing would force a re-debit the RPC rejects;
 *     the broadcast/recovery path owns advancing it, and the next confirmation
 *     pass promotes it once it gains a tx.
 *   - anchor PENDING (debit never landed, or `recover_stuck_broadcasts` reset a
 *     stale broadcast back to PENDING) or GONE → no forward progress, so
 *     re-queue materialized → `queued` to re-drive the debit (now PENDING-
 *     expected → accepted). Idempotent: materialize resolves the SAME anchor
 *     (fingerprint unique index), debit keys on the anchor id → no double-charge.
 *
 * Org-scoped, status-guarded, never throws into the caller (a confirmation
 * failure is logged/alerted; the new-row drain still proceeds).
 */
async function confirmMaterializedArtifacts(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  limit: number,
  result: ConnectorArtifactDrainResult,
): Promise<void> {
  let materialized: MaterializedArtifactRef[];
  try {
    materialized = await deps.listMaterializedArtifacts({ orgId, limit });
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'materialized enumeration failed';
    deps.emitAlert({ scope: 'cycle', orgId, reason });
    deps.logger.error({ error: err, orgId }, 'connector-artifact confirmation enumeration failed');
    return; // don't abort the new-row drain on a confirmation read failure
  }

  for (const ref of materialized) {
    if (!ref.anchor_id) {
      // A materialized row with no anchor_id is anomalous (we always set it on
      // the processing→materialized transition). Leave it for the operator.
      deps.logger.warn({ orgId, artifactId: ref.id }, 'connector-artifact materialized row missing anchor_id — skipping confirmation');
      continue;
    }
    const anchorId = ref.anchor_id;

    let anchor: AnchorStatusRow | null;
    try {
      anchor = await deps.readAnchorStatus({ orgId, anchorId });
    } catch (err) {
      // Per-row isolation: a read flake leaves the row materialized (retryable).
      deps.logger.warn({ error: err, orgId, artifactId: ref.id, anchorId }, 'connector-artifact confirmation re-read failed — left materialized');
      continue;
    }

    if (isAnchorAdvanced(anchor)) {
      // Irreversibly advanced → promote to terminal anchored (status-guarded).
      if (await markStatus(deps, orgId, ref.id, 'materialized', 'anchored', { anchor_id: anchorId })) {
        result.anchored += 1;
        result.confirmed += 1;
        deps.logger.info({ orgId, artifactId: ref.id, anchorId, anchorStatus: anchor!.status }, 'connector-artifact confirmed anchored');
      } else {
        deps.logger.warn({ orgId, artifactId: ref.id }, 'connector-artifact lost lease at confirmation promote — stopping row');
      }
      continue;
    }

    if (isAnchorInFlight(anchor)) {
      // BROADCASTING/null-tx: still in flight, NOT re-queueable (would re-debit).
      // Leave materialized; a later pass promotes it once it gains a tx.
      deps.logger.info({ orgId, artifactId: ref.id, anchorId }, 'connector-artifact anchor in flight (BROADCASTING) — left materialized for next confirmation');
      continue;
    }

    // Anchor PENDING (reset/never-debited) or gone: no forward progress → re-queue
    // to re-drive the debit (now PENDING-expected). Status-guarded.
    if (await markRequeued(deps, orgId, ref.id)) {
      result.reconfirmRequeued += 1;
      deps.emitAlert({ scope: 'row', orgId, artifactId: ref.id, reason: 'anchor_not_advanced_requeued' });
      deps.logger.warn({ orgId, artifactId: ref.id, anchorId, anchorStatus: anchor?.status ?? 'missing' }, 'connector-artifact anchor lost progress — re-queued to re-debit');
    } else {
      deps.logger.warn({ orgId, artifactId: ref.id }, 'connector-artifact lost lease at confirmation re-queue — stopping row');
    }
  }
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
  const result: ConnectorArtifactDrainResult = {
    claimed: 0,
    anchored: 0,
    failed: 0,
    confirmed: 0,
    reconfirmRequeued: 0,
  };

  // CONFIRMATION PRE-STEP: promote/reconcile prior-pass `materialized` rows
  // BEFORE the new-row drain. An anchor debited last pass is now BROADCASTING;
  // it can only become terminal `anchored` by gaining a tx / SUBMITTED /
  // SECURED — a CONFIRMATION re-read, never a re-debit (the debit RPC expects
  // PENDING and would reject a BROADCASTING anchor).
  await confirmMaterializedArtifacts(deps, orgId, limit, result);

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

    // Track whether the (idempotent) debit already landed: if a LATER step
    // throws after a successful charge, we must NOT mark the artifact terminal
    // `failed` (that would represent a CHARGED anchor as a failed artifact).
    // Instead leave it RETRYABLE so the reaper re-resolves the SAME anchor
    // (debit idempotent on anchorId → no double-charge).
    let debitSucceeded = false;

    try {
      // 1) Materialize a PENDING anchor (fingerprint-only, §1.6A).
      const { anchorId } = await deps.materializeAnchor(row);
      // STATUS-GUARDED processing → materialized. A zero-row match = LOST LEASE
      // (the reaper re-queued the row, or another worker reclaimed it). STOP the
      // row before debiting/anchoring on a stale lease — and DON'T count it.
      if (!(await markStatus(deps, orgId, row.id, 'processing', 'materialized', { anchor_id: anchorId }))) {
        deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease before debit — stopping row');
        continue;
      }

      // 2) Charge AT SECURING — and ONLY here. Never at enqueue/claim.
      const debit = await deps.debitAndEnqueueAnchor({ orgId, anchorId });
      if (!debit.success) {
        if (debit.error === 'insufficient_credits') {
          // Insufficient credits is a TRANSIENT, recoverable condition: the org
          // simply has no balance yet. Marking the row `failed` would strand it
          // permanently — `failed` is NOT a drainable status and enqueue is
          // idempotent (ON CONFLICT DO NOTHING), so it would never re-enter the
          // pipeline. Instead, reset it to a RETRYABLE `queued` state so the next
          // daily drain re-claims it once credits land. The anchor already
          // materialized; debit_and_enqueue_anchor is idempotent on the anchor
          // id, so the retry re-drives the SAME single charge (never a double).
          if (await markRequeued(deps, orgId, row.id)) {
            deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: 'insufficient_credits_requeued' });
            result.failed += 1;
          } else {
            deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease at insufficient-credits requeue — stopping row');
          }
          continue;
        }
        // `anchor_not_in_expected_status` is NOT terminal. It means a concurrent
        // cycle already advanced THIS anchor past PENDING (the drain's own prior
        // debit + broadcast/confirmation). The debit RPC rejects BEFORE charging
        // and is idempotent on anchor id, so NO charge was lost — the securing
        // already happened. Marking the row `failed` here strands a genuinely
        // SECURED/SUBMITTED anchor as a failed artifact (data-integrity bug found
        // under load: ~12k wrongly-failed rows whose anchors were SECURED/SUBMITTED).
        // Re-read and reconcile — mirroring the confirmation step — instead of failing.
        // The confirmation re-queue path (SITE `isAnchorInFlight`) already guards
        // this on re-debit; the FIRST-pass debit needs the same guard.
        if (debit.error === 'anchor_not_in_expected_status') {
          let advancedAnchor: AnchorStatusRow | null;
          try {
            advancedAnchor = await deps.readAnchorStatus({ orgId, anchorId });
          } catch (err) {
            // Read flake → leave materialized (retryable). Never fail on a transient
            // read after an already-advanced anchor.
            deps.logger.warn({ error: err, orgId, artifactId: row.id, anchorId }, 'connector-artifact advanced-anchor re-read failed — left materialized');
            continue;
          }
          if (isAnchorAdvanced(advancedAnchor)) {
            // Irreversibly advanced → promote to terminal anchored (status-guarded).
            if (await markStatus(deps, orgId, row.id, 'materialized', 'anchored', { anchor_id: anchorId })) {
              result.anchored += 1;
              result.confirmed += 1;
              deps.logger.info({ orgId, artifactId: row.id, anchorId, anchorStatus: advancedAnchor!.status }, 'connector-artifact debit saw advanced anchor — promoted anchored (idempotent, no re-charge)');
            } else {
              deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease at advanced-anchor promote — stopping row');
            }
            continue;
          }
          if (isAnchorInFlight(advancedAnchor)) {
            // BROADCASTING/null-tx → still in flight; leave materialized for the
            // confirmation re-read to promote once it gains a tx. NOT failed.
            deps.logger.info({ orgId, artifactId: row.id, anchorId }, 'connector-artifact debit saw in-flight anchor — left materialized for confirmation');
            continue;
          }
          // Anchor genuinely PENDING/missing despite the rejection is not expected
          // (the RPC only rejects a NON-PENDING anchor) → fall through to terminal.
        }
        // Truly-terminal debit failures → mark failed + bounded alert. No
        // batch-anchor, no silent drop. The row is reviewable. If the guarded
        // mark-failed matched zero rows the lease was lost — stop, don't count.
        if (await markFailed(deps, orgId, row.id, debit.error ?? 'debit_failed')) {
          deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: debit.error ?? 'debit_failed' });
          result.failed += 1;
        } else {
          deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease at hard-debit-fail — stopping row');
        }
        continue;
      }
      debitSucceeded = true;

      // 3a) Design-C (mig 0353): the debit RPC just moved THIS anchor
      // PENDING → BROADCASTING (charged, exactly once). processBatchAnchors claims
      // ONLY status='PENDING', so it would skip the already-BROADCASTING anchor —
      // the submission-latency gap. Reset this org's drain-charged, never-batch-
      // claimed connector anchors back to PENDING so the batch below claims +
      // submits them NOW. The charge lives on the anchor id and PERSISTS across the
      // reset — never refunded, never re-debited — so exactly one charge stands.
      // Best-effort: on failure the anchors just wait for recover_stuck_broadcasts.
      const resetCount = await deps.resetUnclaimedConnectorBroadcasts({ orgId });
      if (resetCount > 0) {
        deps.logger.info({ orgId, resetCount }, 'connector-artifact reset stuck broadcasts → PENDING for prompt batch submit');
      }

      // 3b) Batch-anchor through the single worker-owned org-scoped path. It now
      // claims the just-reset PENDING connector anchors (leased via
      // claim_pending_anchors → no double-submit) and submits them. May still
      // return {processed:0} if a batch trigger/size gate defers — so the aggregate
      // count is NOT proof this artifact's anchor advanced (the confirm re-read is).
      const batch = await deps.batchAnchor({ force: true, orgId });

      // 4) Confirm the SPECIFIC anchor advanced IRREVERSIBLY (tx / SUBMITTED /
      // SECURED) by re-reading it — never the aggregate batch count, and never
      // bare BROADCASTING (which the debit itself produces and which
      // recover_stuck_broadcasts can reset to PENDING). Only then is the
      // artifact terminal.
      const anchor = await deps.readAnchorStatus({ orgId, anchorId });
      if (!isAnchorAdvanced(anchor)) {
        // Debit succeeded (anchor now BROADCASTING, charged) but it has not yet
        // irreversibly advanced. LEAVE the artifact `materialized` (retryable) —
        // do NOT re-queue (that would force a re-debit the RPC rejects on a
        // BROADCASTING anchor). The CONFIRMATION step on a later pass promotes it
        // once it gains a tx / SUBMITTED / SECURED (or re-queues it if the anchor
        // is reset to PENDING). Do NOT count anchored.
        deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: 'anchor_pending_confirmation' });
        deps.logger.info(
          { orgId, artifactId: row.id, anchorId, anchorStatus: anchor?.status ?? 'missing' },
          'connector-artifact debit ok, anchor not yet irreversibly advanced — left materialized for confirmation',
        );
        continue;
      }

      // STATUS-GUARDED materialized → anchored. A zero-row match = LOST LEASE
      // (reaper/another worker took it) → stop, don't count anchored.
      if (!(await markStatus(deps, orgId, row.id, 'materialized', 'anchored', { anchor_id: anchorId }))) {
        deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease before mark-anchored — stopping row');
        continue;
      }
      result.anchored += 1;
      deps.logger.info(
        { orgId, artifactId: row.id, anchorId, batchId: batch.batchId, processed: batch.processed, anchorStatus: anchor!.status },
        'connector-artifact anchored',
      );
    } catch (err) {
      // Per-row failure isolation: this row fails, the loop continues.
      const reason = err instanceof Error ? err.message : 'drain row failed';
      deps.logger.error({ error: err, orgId, artifactId: row.id }, 'connector-artifact row drain failed');

      if (debitSucceeded) {
        // The charge already landed and the anchor is BROADCASTING. A post-debit
        // throw (e.g. batch step) must NOT mark the artifact terminal `failed` (a
        // CHARGED anchor as failed), and must NOT re-queue it (a re-queue → re-
        // debit would hit the RPC's PENDING-expected rejection on a BROADCASTING
        // anchor). LEAVE it `materialized`: the CONFIRMATION step owns it from
        // here — it promotes to anchored once the anchor advances, or re-queues
        // only if the anchor is reset to PENDING. No re-write, no double-charge.
        deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason: 'post_debit_error_left_materialized' });
        deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact post-debit error — left materialized for confirmation');
        continue;
      }

      // Pre-debit failure → terminal `failed`. The guarded mark-failed matching
      // zero rows = lost lease → stop, don't count.
      if (await markFailed(deps, orgId, row.id, reason)) {
        deps.emitAlert({ scope: 'row', orgId, artifactId: row.id, reason });
        result.failed += 1;
      } else {
        deps.logger.warn({ orgId, artifactId: row.id }, 'connector-artifact lost lease at catch-mark-failed — stopping row');
      }
    }
  }

  deps.logger.info({ orgId, ...result }, 'connector-artifact drain pass complete');
  return result;
}

/**
 * STATUS-GUARDED transition that RETURNS whether a row actually matched.
 * `.eq('status', from)` means a row the reaper has already re-queued (or another
 * worker reclaimed/anchored) is NOT clobbered by a slow/zombie worker finishing
 * its old pass — the UPDATE matches zero rows. `.select('id').maybeSingle()`
 * surfaces that zero-row case as `false` (a LOST LEASE), so the caller can STOP
 * the row instead of pressing on with a stale lease. A DB error is also `false`
 * (fail-closed — don't proceed on an unconfirmed transition).
 */
async function markStatus(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  id: string,
  from: 'processing' | 'materialized',
  to: 'materialized' | 'anchored',
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const { data, error } = await deps.db
    .from('connector_artifact')
    .update({ status: to, updated_at: new Date().toISOString(), ...extra })
    .eq('id', id)
    .eq('org_id', orgId)
    .eq('status', from)
    .select('id')
    .maybeSingle();
  if (error) {
    deps.logger.warn({ error, orgId, artifactId: id, from, to }, `connector-artifact mark-${to} failed`);
    return false;
  }
  return data != null;
}

/**
 * RETRYABLE requeue: reset a row back to 'queued' so the next daily drain
 * re-claims it. Used for insufficient_credits — a transient condition, not a
 * hard failure. STATUS-GUARDED on the in-flight `materialized` status (the row
 * is materialized by step 1 before the debit runs), consistent with the
 * `markStatus` pattern: if the reaper has already re-queued the row (or another
 * worker reclaimed it), this matches zero rows and does NOT clobber it.
 */
/**
 * RETRYABLE requeue: reset a row back to 'queued' so the next daily drain
 * re-claims it. Used for insufficient_credits — a transient condition, not a
 * hard failure. STATUS-GUARDED on the in-flight `materialized` status (the row
 * is materialized by step 1 before the debit runs) and RETURNS whether a row
 * matched: a zero-row update means the reaper/another worker already took the
 * row (LOST LEASE) → the caller must NOT also count it.
 */
async function markRequeued(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  id: string,
): Promise<boolean> {
  const { data, error } = await deps.db
    .from('connector_artifact')
    .update({ status: 'queued', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId)
    .eq('status', 'materialized')
    .select('id')
    .maybeSingle();
  if (error) {
    deps.logger.warn({ error, orgId, artifactId: id }, 'connector-artifact mark-requeued failed');
    return false;
  }
  return data != null;
}

/**
 * Terminal `failed` transition — STATUS-GUARDED and RETURNS whether a row
 * matched. The guard is `status IN ('processing','materialized')` (the only
 * in-flight statuses this worker holds a lease in): a row the reaper already
 * re-queued ('queued') or another worker already anchored ('anchored') will NOT
 * be flipped back to 'failed' — the LOST-LEASE case matches zero rows and the
 * caller stops the row without counting it.
 */
async function markFailed(
  deps: ConnectorArtifactDrainDeps,
  orgId: string,
  id: string,
  reason: string,
): Promise<boolean> {
  const { data, error } = await deps.db
    .from('connector_artifact')
    .update({ status: 'failed', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId)
    .in('status', ['processing', 'materialized'])
    .select('id')
    .maybeSingle();
  if (error) {
    // A row stuck in-flight because we couldn't even mark it failed is the ONE
    // thing we must never hide — log loudly.
    deps.logger.error({ error, orgId, artifactId: id, reason }, 'connector-artifact mark-failed failed (row stuck in-flight)');
    return false;
  }
  return data != null;
}

// ── F-1 stuck-row reaper (liveness) ──────────────────────────────────────────

/**
 * Lease / visibility-timeout for stranded `processing` rows. A row stuck in
 * `processing` past this lease is presumed STRANDED — the worker crashed between
 * the claim and the processing→materialized transition (the claim CAS gives
 * exactly-once but NOT liveness; nothing re-drains a `processing` row since only
 * pending|queued are drainable). Generous (>> any real drain pass) so a live
 * worker is never reaped.
 *
 * The reaper re-queues ONLY `processing` rows. A `processing` row has NOT been
 * debited (the debit only runs AFTER the processing→materialized transition), so
 * its anchor (if materialize even created one before the crash) is still PENDING
 * — a re-drive is SAFE (materialize idempotent on the (user_id,fingerprint)
 * unique index; debit re-drives the SAME single charge — never a double).
 *
 * Crucially the reaper does NOT touch `materialized` rows: those may hold an
 * already-debited, in-flight BROADCASTING anchor, and re-queuing one would force
 * a re-debit the RPC rejects (`p_expected_status='PENDING'`). `materialized`
 * rows are owned by the anchor-aware CONFIRMATION step
 * (`confirmMaterializedArtifacts`), which promotes them once advanced or
 * re-queues them only when the anchor has lost forward progress (PENDING/gone).
 */
export const STALE_INFLIGHT_MS = 15 * 60 * 1000; // 15 min

export interface ReapStaleResult {
  reaped: number;
}

/**
 * Reset rows stranded in `processing` past the lease back to 'queued' so the
 * next drain pass re-claims them. This is the F-1 liveness guarantee the claim
 * CAS alone does not provide. Global (all orgs); runs at the head of each drain
 * pass. A reaper failure alerts but NEVER aborts the drain.
 */
export async function reapStaleInFlightArtifacts(
  injected: Partial<Pick<ConnectorArtifactDrainDeps, 'db' | 'logger' | 'emitAlert'>> & { thresholdMs?: number } = {},
): Promise<ReapStaleResult> {
  const db = injected.db ?? (defaultDb as unknown as DrainDb);
  const logger = injected.logger ?? (defaultLogger as unknown as DrainLogger);
  const emitAlert = injected.emitAlert ?? defaultEmitAlert;
  const cutoff = new Date(Date.now() - (injected.thresholdMs ?? STALE_INFLIGHT_MS)).toISOString();

  const { data, error } = await db
    .from('connector_artifact')
    .update({ status: 'queued', updated_at: new Date().toISOString() })
    .eq('status', 'processing')
    .lt('updated_at', cutoff)
    .select('id, org_id');

  if (error) {
    emitAlert({ scope: 'cycle', orgId: 'ALL', reason: `reaper failed: ${(error as { message?: string }).message ?? 'unknown'}` });
    logger.error({ error }, 'connector-artifact reaper failed');
    return { reaped: 0 };
  }

  const rows = (data ?? []) as Array<{ id: string; org_id: string }>;
  for (const r of rows) {
    // A stranded row is a real liveness incident — alert (bounded ids only, §1.6A).
    emitAlert({ scope: 'row', orgId: r.org_id, artifactId: r.id, reason: 'stale_inflight_requeued' });
  }
  if (rows.length > 0) {
    logger.warn({ reaped: rows.length }, 'connector-artifact reaper re-queued stranded in-flight rows');
  }
  return { reaped: rows.length };
}

// ── Cron entrypoint ──────────────────────────────────────────────────────────

export interface ConnectorArtifactDrainCronResult {
  skipped: boolean;
  reason?: string;
  orgsProcessed: number;
  orgsFailed: number;
  reaped: number;
  claimed: number;
  anchored: number;
  failed: number;
  /** Materialized rows promoted to anchored by the confirmation re-read. */
  confirmed: number;
  /** Materialized rows re-queued by confirmation (anchor lost forward progress). */
  reconfirmRequeued: number;
}

export interface ConnectorArtifactDrainCronDeps {
  /** Feature gate. Defaults to `config.enableConnectorArtifactDrain`. */
  enabled?: boolean;
  /** List distinct org_ids that currently have drainable (pending|queued) rows. */
  listDrainableOrgIds?: () => Promise<string[]>;
  /** Drain a single org (defaults to `drainConnectorArtifactsForOrg`). */
  drainForOrg?: (orgId: string) => Promise<ConnectorArtifactDrainResult>;
  /** Reap stranded in-flight rows (defaults to `reapStaleInFlightArtifacts`). */
  reapStale?: () => Promise<ReapStaleResult>;
  /** Bounded, PII-scrubbed alert sink. */
  emitAlert?: (alert: ConnectorArtifactAlert) => void;
  logger?: DrainLogger;
}

/**
 * Statuses that mean an org has WORK for a drain pass: `pending|queued` (new
 * rows to claim/anchor) PLUS `materialized` (prior-pass rows awaiting the
 * CONFIRMATION re-read). An org with ONLY materialized rows (all anchors
 * in-flight, no new rows) must still be enumerated so its confirmation runs —
 * otherwise an in-flight anchor would never be promoted to `anchored`.
 */
const WORK_STATUSES = [...DRAINABLE_STATUSES, 'materialized'] as const;

/**
 * Default org enumerator: distinct org_ids with at least one row that needs a
 * drain pass (drainable OR materialized-awaiting-confirmation). Bounded scan
 * over the (org_id, status) index. Returns a de-duplicated list.
 */
async function defaultListDrainableOrgIds(db: DrainDb): Promise<string[]> {
  const { data, error } = await db
    .from('connector_artifact')
    .select('org_id')
    .in('status', WORK_STATUSES as unknown as string[])
    .limit(5000);
  if (error) {
    throw new Error(`connector-artifact org enumeration failed: ${(error as { message?: string }).message ?? 'unknown'}`);
  }
  const seen = new Set<string>();
  for (const row of (data ?? []) as Array<{ org_id?: string }>) {
    if (row.org_id) seen.add(row.org_id);
  }
  return [...seen];
}

/**
 * Cron entrypoint (QUEUE-06). Cloud Scheduler → `POST /jobs/drain-connector-artifacts`.
 *
 * In-process node-cron is dormant under Cloud Run CPU throttling (proven by the
 * PROOF-03 soak), so prod drives this via HTTP. No-ops (`skipped:true`) when the
 * flag is off. Per-org drains are isolated: one org throwing alerts (scope=cycle)
 * and the remaining orgs still drain — no silent drop.
 */
export async function runConnectorArtifactDrain(
  injected: ConnectorArtifactDrainCronDeps = {},
): Promise<ConnectorArtifactDrainCronResult> {
  const logger = injected.logger ?? (defaultLogger as unknown as DrainLogger);
  const enabled = injected.enabled ?? config.enableConnectorArtifactDrain;
  const base: ConnectorArtifactDrainCronResult = {
    skipped: false,
    orgsProcessed: 0,
    orgsFailed: 0,
    reaped: 0,
    claimed: 0,
    anchored: 0,
    failed: 0,
    confirmed: 0,
    reconfirmRequeued: 0,
  };

  if (!enabled) {
    return { ...base, skipped: true, reason: 'ENABLE_CONNECTOR_ARTIFACT_DRAIN is false' };
  }

  const db = defaultDb as unknown as DrainDb;
  const listDrainableOrgIds = injected.listDrainableOrgIds ?? (() => defaultListDrainableOrgIds(db));
  const drainForOrg = injected.drainForOrg ?? ((orgId: string) => drainConnectorArtifactsForOrg(orgId));
  const emitAlert = injected.emitAlert ?? defaultEmitAlert;

  // F-1: reap stranded in-flight rows FIRST (presumed-crashed workers) so this
  // pass re-claims them. Then they reappear in the per-org drainable scan below.
  const reapStale = injected.reapStale ?? (() => reapStaleInFlightArtifacts({ db, logger, emitAlert }));
  base.reaped = (await reapStale()).reaped;

  const orgIds = await listDrainableOrgIds();
  for (const orgId of orgIds) {
    base.orgsProcessed += 1;
    try {
      const r = await drainForOrg(orgId);
      base.claimed += r.claimed;
      base.anchored += r.anchored;
      base.failed += r.failed;
      base.confirmed += r.confirmed;
      base.reconfirmRequeued += r.reconfirmRequeued;
    } catch (err) {
      // Per-org isolation: surface as a cycle alert, keep draining other orgs.
      base.orgsFailed += 1;
      const reason = err instanceof Error ? err.message : 'org drain failed';
      emitAlert({ scope: 'cycle', orgId, reason });
      logger.error({ error: err, orgId }, 'connector-artifact org drain failed');
    }
  }

  logger.info({ ...base }, 'connector-artifact drain cron pass complete');
  return base;
}

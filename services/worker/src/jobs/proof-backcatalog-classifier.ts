/**
 * Back-catalogue proof-completeness CLASSIFIER (S3-A / PROOF-BACKCATALOG).
 *
 * Prod's ~2.97M SECURED anchors are DIRECT-anchored — one tx per anchor, the
 * OP_RETURN commits the fingerprint itself, there is NO Merkle tree. This job
 * CLASSIFIES the back catalogue honestly so the 0340 GUC-gated
 * "SECURED ⇒ proof complete" trigger can eventually be enabled with full
 * knowledge of what the catalogue actually contains. It NEVER fabricates a
 * Merkle path, NEVER synthesizes a single-leaf/degenerate branch, and NEVER
 * touches the existing proof columns.
 *
 * ── The state model ──────────────────────────────────────────────────────────
 *   already_complete : anchor_proofs row with merkle_root AND proof_path both
 *                      present — the exact predicate the 0340 trigger checks.
 *                      (Covers post-FIX-1 single-leaf rows whose proof_path is
 *                      the honest empty branch `[]`, and recovered batches.)
 *   direct_anchored  : the anchor's tx carries exactly this one anchor (tx
 *                      cardinality 1) and the stored proof data does not
 *                      contradict a direct commit (no row at all — the
 *                      pre-FIX-1 catalogue —, a receipt-only row, or a
 *                      single-leaf root == fingerprint with no branch).
 *                      Merkle-path fields are LEFT EMPTY — that emptiness is
 *                      the honest truth of a direct anchor.
 *   batch_provable   : stored merkle_root + batch_id — membership and root are
 *                      on record, so the branch is reconstructable by the
 *                      self-validating SCRUM-2471 job (proof-branch-backfill).
 *   ambiguous        : every contradictory or unprovable shape (see
 *                      AmbiguityReason). Write mode HALTS if any exist.
 *
 * ── Division of labour (do not duplicate) ────────────────────────────────────
 *   - backfillProofCompleteness.ts (SCRUM-2491 foundation, PR #1281) owns
 *     RECONSTRUCTION of the 0340 chain-data columns (block_hash, block_header,
 *     op_return_payload) via an injected chain source.
 *   - proof-branch-backfill.ts (FIX-1) owns branch REBUILDS with
 *     root-equality self-validation.
 *   - THIS job owns the honest CENSUS + (once 0354 lands) persisting the
 *     class label. It performs zero chain calls and zero reconstruction.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *   - DRY-RUN BY DEFAULT: emits the per-class plan, writes NOTHING.
 *   - HARD EXECUTE GUARD: write mode needs BOTH options.execute===true AND
 *     PROOF_CLASSIFIER_CONFIRM='EXECUTE' (mirrors the SCRUM-2491 foundation).
 *   - GUC GUARD: checked at run start AND on every resume (every invocation).
 *     Refuses to run when arkova.proof_enforce_secured_complete is ON; write
 *     mode additionally fail-closes when the state cannot be confirmed.
 *   - HALT-ON-AMBIGUOUS: write mode refuses while ambiguous > 0.
 *   - READ-ONLY ENFORCEMENT: the write-set builder structurally cannot emit
 *     merkle_root / proof_path / merkle_index / block_hash / block_header /
 *     op_return_payload / batch_id / receipt_id (see
 *     CLASSIFIER_READ_ONLY_COLUMNS + tests).
 *   - 0354 SCHEMA GAP (honest stop): 0340 has NO column that can carry the
 *     class label. Persisting {direct_anchored | batch_provable} needs
 *     `anchor_proofs.proof_completeness_class` — that is Carson's 0354
 *     decision. Until then write mode refuses with `schema_gap_0354` and
 *     performs ZERO writes. This module does NOT claim the 0354 prefix.
 *
 * ── Resumable ────────────────────────────────────────────────────────────────
 *   Durable checkpoint row in `job_queue` (type
 *   'proof-backcatalog-classifier:checkpoint', terminal status 'completed' so
 *   it is never claimable by claim_next_job, never counted by getQueueDepth's
 *   pending/failed/dead monitors, and never retried). Payload carries the
 *   last-processed anchor id cursor + cumulative counts. A worker restart
 *   resumes from the cursor — never from zero. `restart: true` starts a fresh
 *   census (new checkpoint row; the old one remains as an audit trail).
 *
 * Constitution refs: §1.4 (service_role only; nothing secret logged), §1.5
 * (states what is measured vs NOT asserted — ambiguous is a first-class
 * outcome, not a guess), §1.12 (T3 surface; prod execution is Carson-gated).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { config } from '../config.js';
import { runWithConcurrency } from '../utils/concurrency.js';

// ── Tunables ─────────────────────────────────────────────────────────────────

export const DEFAULT_BATCH_SIZE = 500;
const MIN_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 2_000;

/** Default number of page-batches processed per invocation (bounded HTTP run). */
export const DEFAULT_MAX_BATCHES_PER_INVOCATION = 20;

/** Bounded fan-out for tx-cardinality count probes. */
const CARDINALITY_CONCURRENCY = 8;

/** `.in()` filters are chunked to stay inside PostgREST query-string limits. */
const IN_FILTER_CHUNK = 100;

/** Cap on ambiguous samples carried in the checkpoint/summary (bounded payload). */
const AMBIGUOUS_SAMPLE_CAP = 25;

/** Env confirmation token (PROOF_CLASSIFIER_CONFIRM) required for write mode. */
export const EXECUTE_CONFIRM_TOKEN = 'EXECUTE';
const EXECUTE_CONFIRM_ENV = 'PROOF_CLASSIFIER_CONFIRM';

/** Durable checkpoint rows live in job_queue under this type. */
export const CHECKPOINT_JOB_TYPE = 'proof-backcatalog-classifier:checkpoint';

// ── Types ────────────────────────────────────────────────────────────────────

export type BackCatalogClass =
  | 'direct_anchored'
  | 'batch_provable'
  | 'already_complete'
  | 'ambiguous';

export type AmbiguityReason =
  | 'secured_without_tx'
  | 'batch_member_without_root'
  | 'fingerprint_root_shared_tx'
  | 'unbatched_root_shared_tx'
  | 'solo_tx_foreign_root'
  | 'tx_cardinality_unknown';

/** Minimal logger surface (matches the worker `logger`). */
export interface ClassifierLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

/** The anchors columns the scan reads (nothing more). */
export interface ScanAnchorRow {
  id: string;
  org_id: string | null;
  fingerprint: string;
  chain_tx_id: string | null;
}

/** The anchor_proofs columns classification reads (nothing more). */
export interface ClassifierProofRow {
  anchor_id: string;
  merkle_root: string | null;
  proof_path: unknown;
  batch_id: string | null;
}

export type GucState = 'on' | 'off' | 'unknown';

/**
 * Injectable reader for `arkova.proof_enforce_secured_complete`.
 *
 * NOTE (honest gap): PostgREST cannot read a GUC without a SQL function, and
 * no `get_proof_enforcement_guc()` RPC exists on prod today — 0340 shipped the
 * trigger, not a reader. `createDbGucReader` therefore returns 'unknown' in
 * prod until the reader RPC ships (bundle it with the 0354 migration). The
 * run fail-closes on 'unknown' for write mode and proceeds loudly for the
 * zero-write dry-run census.
 */
export interface GucReader {
  getProofEnforcementGuc(): Promise<GucState>;
}

export interface ClassifierDeps {
  client: SupabaseClient;
  guc: GucReader;
  logger: ClassifierLogger;
  /** Override for the env confirmation (testing). Defaults to typed config. */
  confirmToken?: string;
}

export interface ClassifierOptions {
  /** Must be paired with PROOF_CLASSIFIER_CONFIRM=EXECUTE to enter write mode. */
  execute?: boolean;
  /** Restrict the census to one org (tx-cardinality probes stay global). */
  orgId?: string;
  batchSize?: number;
  /** Page-batches per invocation (Cloud Run HTTP runs are bounded; resume continues). */
  maxBatches?: number;
  /** Start a fresh census instead of resuming/returning the stored one. */
  restart?: boolean;
}

export interface PlanCounts {
  direct_anchored: number;
  batch_provable: number;
  already_complete: number;
  ambiguous: number;
}

export interface SchemaGap {
  table: string;
  neededColumn: string;
  reason: string;
  decision: string;
}

export interface ClassifierSummary {
  mode: 'dry-run' | 'write';
  /** True when the run refused (GUC on/unknown, ambiguity, or schema gap). */
  refused: boolean;
  refusalReason:
    | 'guc_enforcement_on'
    | 'guc_state_unknown'
    | 'ambiguous_rows_present'
    | 'schema_gap_0354'
    | null;
  /** Set when execute was requested but the confirm guard downgraded to dry-run. */
  executeRefusalReason: string | null;
  schemaGap: SchemaGap | null;
  gucState: GucState;
  scope: string;
  runComplete: boolean;
  resumed: boolean;
  batchesProcessed: number;
  /** Cumulative rows classified across resumes (from the checkpoint). */
  rowsScanned: number;
  plan: PlanCounts;
  ambiguousReasons: Partial<Record<AmbiguityReason, number>>;
  ambiguousSamples: Array<{ anchor_id: string; reason: AmbiguityReason }>;
  /** Always 0 this wave — see the 0354 schema gap. */
  writesApplied: number;
  /** Last-processed anchor id (the durable resume cursor). */
  cursor: string | null;
  /**
   * Honesty caveat: count of soft-deleted SECURED anchors excluded from the
   * census (they are out of the servable proof catalogue but still exist).
   * 'unknown' when the best-effort count query failed.
   */
  softDeletedExcluded: number | 'unknown';
}

// ── Read-only enforcement ────────────────────────────────────────────────────

/**
 * Existing proof columns the classifier may NEVER write — enforced here (the
 * write-set builder cannot emit them) and asserted structurally in tests.
 * This includes the 0340 chain-data columns: reconstructing those is the
 * SCRUM-2491 backfill's mandate, not classification.
 */
export const CLASSIFIER_READ_ONLY_COLUMNS = [
  'merkle_root',
  'proof_path',
  'merkle_index',
  'block_hash',
  'block_header',
  'op_return_payload',
  'batch_id',
  'receipt_id',
  'block_height',
  'block_timestamp',
  'raw_response',
  'proof_schema_version',
  'anchor_id',
  'id',
  'created_at',
] as const;

/**
 * The exact 0354 decision for Carson: 0340 added completeness DATA columns but
 * no column that can carry the completeness CLASS. Without it, the honest
 * classes {direct_anchored, batch_provable} cannot be persisted (and the 0340
 * trigger predicate `merkle_root + proof_path` would forever reject honest
 * direct-anchored rows that legitimately have no branch).
 */
export const SCHEMA_GAP_0354: SchemaGap = {
  table: 'anchor_proofs',
  neededColumn: 'proof_completeness_class',
  reason:
    'Migration 0340 has no column for the completeness class. Persisting ' +
    '{direct_anchored | batch_provable} needs a class/sub-state column (plus a ' +
    'GUC reader RPC for the worker); until then write mode refuses and only ' +
    'the dry-run census is available.',
  decision: '0354 (Carson-gated — this job does not claim the prefix)',
};

export interface ClassWriteSet {
  /** Column→value map to write, or null when nothing may be written. */
  values: Record<string, unknown> | null;
  /** Populated when the class NEEDS persistence but the schema lacks the column. */
  schemaGap: SchemaGap | null;
}

/**
 * Resolve what write-mode may persist for a class. Structurally incapable of
 * emitting a read-only proof column: the ONLY candidate column is the (absent)
 * class column, so today this returns either "nothing to write" or the 0354
 * schema gap. When 0354 lands, the gap branch becomes
 * `{ values: { proof_completeness_class: cls }, schemaGap: null }` and nothing
 * else changes.
 */
export function buildClassWriteSet(cls: BackCatalogClass): ClassWriteSet {
  switch (cls) {
    case 'already_complete':
      // Complete rows need no label to satisfy the 0340 predicate.
      return { values: null, schemaGap: null };
    case 'ambiguous':
      // Ambiguous rows are never written — write mode halts on them upstream.
      return { values: null, schemaGap: null };
    case 'direct_anchored':
    case 'batch_provable':
      return { values: null, schemaGap: SCHEMA_GAP_0354 };
  }
}

// ── Execute guard ────────────────────────────────────────────────────────────

export function resolveExecuteGuard(
  execute: boolean | undefined,
  confirmToken: string | undefined,
): { permitted: boolean; reason: string | null } {
  if (execute !== true) {
    return {
      permitted: false,
      reason: `DRY-RUN: execute flag not set (pass execute=true AND ${EXECUTE_CONFIRM_ENV}=${EXECUTE_CONFIRM_TOKEN})`,
    };
  }
  if (confirmToken !== EXECUTE_CONFIRM_TOKEN) {
    return {
      permitted: false,
      reason: `DRY-RUN: env confirmation missing — set ${EXECUTE_CONFIRM_ENV}=${EXECUTE_CONFIRM_TOKEN} (execute flag alone is insufficient)`,
    };
  }
  return { permitted: true, reason: null };
}

// ── GUC reader ───────────────────────────────────────────────────────────────

/**
 * Production GUC reader. Calls the (future) `get_proof_enforcement_guc` RPC —
 * a SECURITY DEFINER one-liner over `current_setting('arkova.proof_enforce_
 * secured_complete', true)` that ships with 0354. Until it exists, every call
 * errors → 'unknown' → write mode fail-closes. Zero worker changes needed when
 * the RPC lands.
 */
export function createDbGucReader(client: SupabaseClient): GucReader {
  return {
    async getProofEnforcementGuc(): Promise<GucState> {
      const { data, error } = await (
        client as unknown as {
          rpc(name: string): Promise<{ data: unknown; error: { message?: string } | null }>;
        }
      ).rpc('get_proof_enforcement_guc');
      if (error) return 'unknown';
      const v = typeof data === 'string' ? data.trim().toLowerCase() : data;
      if (v === 'on' || v === true) return 'on';
      if (v === 'off' || v === '' || v === null || v === false) return 'off';
      return 'unknown';
    },
  };
}

// ── Pure classification ──────────────────────────────────────────────────────

function isFilled(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * Classify one SECURED anchor. Pure — all inputs are passed in.
 *
 * @param txCardinality Number of live anchors sharing this anchor's tx
 *   (including itself), or null when it was not / could not be resolved.
 *   Cardinality is only consulted when the stored proof data alone cannot
 *   settle the class; if it is needed but unknown, the row is AMBIGUOUS
 *   (fail-closed) — never guessed.
 */
export function classifyAnchor(
  anchor: ScanAnchorRow,
  proof: ClassifierProofRow | null,
  txCardinality: number | null,
): { cls: BackCatalogClass; reason: AmbiguityReason | null } {
  // 1. The 0340 trigger predicate: root + branch present ⇒ complete.
  //    (A post-FIX-1 single-leaf row's `[]` branch is non-null and counts.)
  if (proof && isFilled(proof.merkle_root) && isFilled(proof.proof_path)) {
    return { cls: 'already_complete', reason: null };
  }

  // 2. A SECURED anchor with no tx is a data-integrity contradiction.
  if (!anchor.chain_tx_id) {
    return { cls: 'ambiguous', reason: 'secured_without_tx' };
  }

  // 3. Root + recorded batch membership ⇒ branch reconstructable by the
  //    self-validating SCRUM-2471 job. No cardinality needed.
  if (proof && isFilled(proof.merkle_root) && isFilled(proof.batch_id)) {
    return { cls: 'batch_provable', reason: null };
  }

  // 4. Everything else needs the tx cardinality to be settled honestly.
  if (txCardinality === null || txCardinality < 1) {
    return { cls: 'ambiguous', reason: 'tx_cardinality_unknown' };
  }

  if (txCardinality > 1) {
    // Shares its tx with other anchors ⇒ it was a batch commit.
    if (!proof || !isFilled(proof.merkle_root)) {
      // Batch member with no persisted root: membership cannot be proven.
      return { cls: 'ambiguous', reason: 'batch_member_without_root' };
    }
    if (proof.merkle_root === anchor.fingerprint) {
      // A single-leaf root on a shared tx is internally contradictory.
      return { cls: 'ambiguous', reason: 'fingerprint_root_shared_tx' };
    }
    // Root present but batch_id missing: plausible batch, membership record
    // incomplete — do not assume.
    return { cls: 'ambiguous', reason: 'unbatched_root_shared_tx' };
  }

  // txCardinality === 1: the tx carries exactly this anchor — DIRECT.
  if (!proof || !isFilled(proof.merkle_root)) {
    // No proof row (the pre-FIX-1 back catalogue) or a receipt-only row:
    // the on-chain commitment is the fingerprint itself. Honest direct.
    return { cls: 'direct_anchored', reason: null };
  }
  if (proof.merkle_root === anchor.fingerprint) {
    // Single-leaf root recorded, branch honestly absent. Direct — and the
    // branch STAYS absent (never synthesize a degenerate `[]` retroactively).
    return { cls: 'direct_anchored', reason: null };
  }
  // Solo tx whose stored root is not this fingerprint: contradictory row.
  return { cls: 'ambiguous', reason: 'solo_tx_foreign_root' };
}

// ── Checkpoint store (job_queue) ─────────────────────────────────────────────

interface CheckpointPayload {
  schemaVersion: 1;
  scope: string;
  mode: 'dry-run' | 'write';
  cursor: string | null;
  rowsScanned: number;
  plan: PlanCounts;
  ambiguousReasons: Partial<Record<AmbiguityReason, number>>;
  ambiguousSamples: Array<{ anchor_id: string; reason: AmbiguityReason }>;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface CheckpointHandle {
  id: string;
  payload: CheckpointPayload;
}

type UntypedDb = {
  from(table: string): {
    select(
      cols: string,
      opts?: { count?: 'exact'; head?: boolean },
    ): {
      eq(col: string, val: unknown): unknown;
      in(col: string, val: string[]): unknown;
      is(col: string, val: unknown): unknown;
      not(col: string, op: string, val: unknown): unknown;
      gt(col: string, val: unknown): unknown;
      order(col: string, opts: { ascending: boolean }): unknown;
      limit(n: number): unknown;
    };
    insert(values: Record<string, unknown>): {
      select(cols: string): {
        single(): Promise<{ data: { id: string } | null; error: { message?: string } | null }>;
      };
    };
    update(values: Record<string, unknown>): {
      eq(col: string, val: unknown): PromiseLike<{ error: { message?: string } | null }>;
    };
  };
};

function emptyPlan(): PlanCounts {
  return { direct_anchored: 0, batch_provable: 0, already_complete: 0, ambiguous: 0 };
}

async function loadCheckpoint(
  db: UntypedDb,
  scope: string,
  mode: 'dry-run' | 'write',
): Promise<CheckpointHandle | null> {
  const q = db
    .from('job_queue')
    .select('id, payload')
    .eq('type', CHECKPOINT_JOB_TYPE) as {
    eq(col: string, val: unknown): {
      eq(col: string, val: unknown): {
        order(
          col: string,
          opts: { ascending: boolean },
        ): {
          limit(n: number): PromiseLike<{
            data: Array<{ id: string; payload: CheckpointPayload }> | null;
            error: { message?: string } | null;
          }>;
        };
      };
    };
  };
  const { data, error } = await q
    .eq('payload->>scope', scope)
    .eq('payload->>mode', mode)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(`classifier checkpoint load failed: ${error.message ?? 'unknown'}`);
  }
  const row = data?.[0];
  return row ? { id: row.id, payload: row.payload } : null;
}

async function createCheckpoint(db: UntypedDb, payload: CheckpointPayload): Promise<CheckpointHandle> {
  // Terminal status 'completed' on purpose: never claimable by claim_next_job
  // (nothing processes this type anyway), never counted as pending/failed/dead
  // by queue monitors, never swept as a stuck job. It is a durable state row,
  // not work.
  const { data, error } = await db
    .from('job_queue')
    .insert({ type: CHECKPOINT_JOB_TYPE, status: 'completed', payload })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`classifier checkpoint create failed: ${error?.message ?? 'no id returned'}`);
  }
  return { id: data.id, payload };
}

async function saveCheckpoint(db: UntypedDb, cp: CheckpointHandle): Promise<void> {
  const { error } = await db
    .from('job_queue')
    .update({ payload: cp.payload, updated_at: new Date().toISOString() })
    .eq('id', cp.id);
  if (error) {
    throw new Error(`classifier checkpoint save failed: ${error.message ?? 'unknown'}`);
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function clampBatchSize(requested: number | undefined): number {
  const n = requested ?? DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(Math.floor(n), MIN_BATCH_SIZE), MAX_BATCH_SIZE);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchScanPage(
  db: UntypedDb,
  opts: { orgId?: string; cursor: string | null; batchSize: number },
): Promise<ScanAnchorRow[]> {
  // Chained shape kept explicit so the narrow test double can mirror it.
  let q = db
    .from('anchors')
    .select('id, org_id, fingerprint, chain_tx_id')
    .eq('status', 'SECURED') as unknown as {
    is(col: string, val: unknown): typeof q;
    eq(col: string, val: unknown): typeof q;
    gt(col: string, val: unknown): typeof q;
    order(col: string, o: { ascending: boolean }): typeof q;
    limit(n: number): PromiseLike<{ data: ScanAnchorRow[] | null; error: { message?: string } | null }>;
  };
  q = q.is('deleted_at', null);
  if (opts.orgId) q = q.eq('org_id', opts.orgId);
  if (opts.cursor) q = q.gt('id', opts.cursor);
  const { data, error } = await q.order('id', { ascending: true }).limit(opts.batchSize);
  if (error) {
    throw new Error(`classifier scan query failed at cursor=${opts.cursor ?? '<start>'}: ${error.message ?? 'unknown'}`);
  }
  return data ?? [];
}

async function fetchProofRows(db: UntypedDb, anchorIds: string[]): Promise<Map<string, ClassifierProofRow>> {
  const map = new Map<string, ClassifierProofRow>();
  for (const ids of chunk(anchorIds, IN_FILTER_CHUNK)) {
    const { data, error } = await (db
      .from('anchor_proofs')
      .select('anchor_id, merkle_root, proof_path, batch_id')
      .in('anchor_id', ids) as unknown as PromiseLike<{
      data: ClassifierProofRow[] | null;
      error: { message?: string } | null;
    }>);
    if (error) {
      throw new Error(`classifier proof-row query failed: ${error.message ?? 'unknown'}`);
    }
    for (const row of data ?? []) map.set(row.anchor_id, row);
  }
  return map;
}

/**
 * Resolve tx cardinality (count of live anchors sharing the tx) for each
 * distinct tx, memoized across the whole invocation. DELIBERATELY GLOBAL —
 * no org filter: a tx shared with another org's anchor is still a batch tx.
 * Uses the partial index idx_anchors_chain_tx_id (deleted_at IS NULL AND
 * chain_tx_id IS NOT NULL) via head-count probes. A probe failure marks that
 * tx 'unknown' → the affected rows classify AMBIGUOUS (fail-closed).
 */
async function resolveCardinalities(
  db: UntypedDb,
  txIds: string[],
  memo: Map<string, number | null>,
  logger: ClassifierLogger,
): Promise<void> {
  const unresolved = [...new Set(txIds)].filter((tx) => !memo.has(tx));
  if (unresolved.length === 0) return;

  const tasks = unresolved.map((tx) => async () => {
    const { count, error } = await (db
      .from('anchors')
      .select('id', { count: 'exact', head: true })
      .eq('chain_tx_id', tx) as unknown as {
      is(col: string, val: unknown): PromiseLike<{ count: number | null; error: { message?: string } | null }>;
    }).is('deleted_at', null);
    if (error || count === null || count === undefined) {
      logger.warn(
        { tx, error: error?.message ?? 'null count' },
        'proof-backcatalog-classifier: cardinality probe failed — rows on this tx will classify AMBIGUOUS',
      );
      memo.set(tx, null);
      return;
    }
    memo.set(tx, count);
  });

  await runWithConcurrency(tasks, CARDINALITY_CONCURRENCY);
}

/** Best-effort census caveat: soft-deleted SECURED anchors excluded from scope. */
async function countSoftDeletedExcluded(
  db: UntypedDb,
  orgId: string | undefined,
): Promise<number | 'unknown'> {
  try {
    let q = db
      .from('anchors')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'SECURED') as unknown as {
      eq(col: string, val: unknown): typeof q;
      not(col: string, op: string, val: unknown): typeof q;
      then: PromiseLike<{ count: number | null; error: { message?: string } | null }>['then'];
    };
    if (orgId) q = q.eq('org_id', orgId);
    const { count, error } = await (q.not('deleted_at', 'is', null) as unknown as PromiseLike<{
      count: number | null;
      error: { message?: string } | null;
    }>);
    if (error || count === null || count === undefined) return 'unknown';
    return count;
  } catch {
    return 'unknown';
  }
}

function summaryFromCheckpoint(
  cp: CheckpointHandle,
  base: Pick<ClassifierSummary, 'mode' | 'gucState' | 'executeRefusalReason' | 'softDeletedExcluded'>,
  extra: Partial<ClassifierSummary> = {},
): ClassifierSummary {
  return {
    mode: base.mode,
    refused: false,
    refusalReason: null,
    executeRefusalReason: base.executeRefusalReason,
    schemaGap: null,
    gucState: base.gucState,
    scope: cp.payload.scope,
    runComplete: cp.payload.completedAt !== null,
    resumed: true,
    batchesProcessed: 0,
    rowsScanned: cp.payload.rowsScanned,
    plan: { ...cp.payload.plan },
    ambiguousReasons: { ...cp.payload.ambiguousReasons },
    ambiguousSamples: [...cp.payload.ambiguousSamples],
    writesApplied: 0,
    cursor: cp.payload.cursor,
    softDeletedExcluded: base.softDeletedExcluded,
    ...extra,
  };
}

// ── The run ──────────────────────────────────────────────────────────────────

export async function runBackCatalogClassifier(
  deps: ClassifierDeps,
  options: ClassifierOptions = {},
): Promise<ClassifierSummary> {
  const { logger } = deps;
  const db = deps.client as unknown as UntypedDb;
  const confirmToken = deps.confirmToken ?? config.proofClassifierConfirm ?? undefined;

  const guard = resolveExecuteGuard(options.execute, confirmToken);
  const mode: 'dry-run' | 'write' = guard.permitted ? 'write' : 'dry-run';
  const executeRefusalReason = options.execute === true && !guard.permitted ? guard.reason : null;
  const scope = options.orgId ?? 'global';
  const batchSize = clampBatchSize(options.batchSize);
  const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES_PER_INVOCATION;

  // ── GUC guard: every invocation is a start or a resume — check both. ──────
  const gucState = await deps.guc.getProofEnforcementGuc();
  if (gucState === 'on') {
    logger.error(
      { scope, mode },
      'proof-backcatalog-classifier: REFUSING — arkova.proof_enforce_secured_complete is ON (the 0340 trigger would reject honest empty-branch rows mid-run)',
    );
    return {
      mode,
      refused: true,
      refusalReason: 'guc_enforcement_on',
      executeRefusalReason,
      schemaGap: null,
      gucState,
      scope,
      runComplete: false,
      resumed: false,
      batchesProcessed: 0,
      rowsScanned: 0,
      plan: emptyPlan(),
      ambiguousReasons: {},
      ambiguousSamples: [],
      writesApplied: 0,
      cursor: null,
      softDeletedExcluded: 'unknown',
    };
  }
  if (mode === 'write' && gucState === 'unknown') {
    logger.error(
      { scope },
      'proof-backcatalog-classifier: REFUSING write mode — GUC state cannot be confirmed (no reader RPC on this database yet; fail-closed)',
    );
    return {
      mode,
      refused: true,
      refusalReason: 'guc_state_unknown',
      executeRefusalReason,
      schemaGap: null,
      gucState,
      scope,
      runComplete: false,
      resumed: false,
      batchesProcessed: 0,
      rowsScanned: 0,
      plan: emptyPlan(),
      ambiguousReasons: {},
      ambiguousSamples: [],
      writesApplied: 0,
      cursor: null,
      softDeletedExcluded: 'unknown',
    };
  }
  if (gucState === 'unknown') {
    logger.warn(
      { scope },
      'proof-backcatalog-classifier: GUC state unknown — proceeding with the zero-write dry-run census only',
    );
  }

  logger.info(
    { scope, mode, batchSize, maxBatches, restart: options.restart === true, gucState },
    mode === 'dry-run'
      ? 'proof-backcatalog-classifier: DRY-RUN census — computing the per-class plan, writing NOTHING'
      : 'proof-backcatalog-classifier: WRITE mode requested — plan first, halt on ambiguity, then apply',
  );

  const softDeletedExcluded = await countSoftDeletedExcluded(db, options.orgId);

  // ── Checkpoint: resume or create. ─────────────────────────────────────────
  let cp = options.restart === true ? null : await loadCheckpoint(db, scope, mode);
  let resumed = cp !== null;

  if (cp && cp.payload.completedAt !== null) {
    // Completed census: return the stored plan (dry-run) or gate on it (write).
    if (mode === 'dry-run') {
      logger.info(
        { scope, completedAt: cp.payload.completedAt },
        'proof-backcatalog-classifier: census already complete — returning the stored plan (pass restart=true for a fresh census)',
      );
      return summaryFromCheckpoint(cp, { mode, gucState, executeRefusalReason, softDeletedExcluded });
    }
    return finalizeWriteMode(cp, {
      mode,
      gucState,
      executeRefusalReason,
      softDeletedExcluded,
      batchesProcessed: 0,
      resumed,
      deps,
    });
  }

  if (!cp) {
    const now = new Date().toISOString();
    cp = await createCheckpoint(db, {
      schemaVersion: 1,
      scope,
      mode,
      cursor: null,
      rowsScanned: 0,
      plan: emptyPlan(),
      ambiguousReasons: {},
      ambiguousSamples: [],
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    });
    resumed = false;
  }

  // ── Scan loop (bounded per invocation; checkpoint after every batch). ─────
  const cardinalityMemo = new Map<string, number | null>();
  let batchesProcessed = 0;

  while (batchesProcessed < maxBatches) {
    const page = await fetchScanPage(db, {
      orgId: options.orgId,
      cursor: cp.payload.cursor,
      batchSize,
    });

    if (page.length === 0) {
      cp.payload.completedAt = new Date().toISOString();
      cp.payload.updatedAt = cp.payload.completedAt;
      await saveCheckpoint(db, cp);
      break;
    }

    const proofMap = await fetchProofRows(db, page.map((a) => a.id));

    // Cardinality is only needed where stored proof data cannot settle the class.
    const txsNeedingCardinality = page
      .filter((a) => {
        if (!a.chain_tx_id) return false;
        const proof = proofMap.get(a.id) ?? null;
        if (proof && isFilled(proof.merkle_root) && isFilled(proof.proof_path)) return false;
        if (proof && isFilled(proof.merkle_root) && isFilled(proof.batch_id)) return false;
        return true;
      })
      .map((a) => a.chain_tx_id as string);
    await resolveCardinalities(db, txsNeedingCardinality, cardinalityMemo, logger);

    for (const a of page) {
      const proof = proofMap.get(a.id) ?? null;
      const cardinality = a.chain_tx_id ? (cardinalityMemo.get(a.chain_tx_id) ?? null) : null;
      const { cls, reason } = classifyAnchor(a, proof, cardinality);
      cp.payload.rowsScanned += 1;
      cp.payload.plan[cls] += 1;
      if (cls === 'ambiguous' && reason) {
        cp.payload.ambiguousReasons[reason] = (cp.payload.ambiguousReasons[reason] ?? 0) + 1;
        if (cp.payload.ambiguousSamples.length < AMBIGUOUS_SAMPLE_CAP) {
          cp.payload.ambiguousSamples.push({ anchor_id: a.id, reason });
        }
      }
    }

    cp.payload.cursor = page[page.length - 1].id;
    cp.payload.updatedAt = new Date().toISOString();
    const isLastPage = page.length < batchSize;
    if (isLastPage) cp.payload.completedAt = cp.payload.updatedAt;
    await saveCheckpoint(db, cp);
    batchesProcessed += 1;

    logger.info(
      {
        scope,
        batch: batchesProcessed,
        rowsScanned: cp.payload.rowsScanned,
        plan: cp.payload.plan,
        cursor: cp.payload.cursor,
      },
      'proof-backcatalog-classifier: batch classified',
    );

    if (isLastPage) break;
  }

  const runComplete = cp.payload.completedAt !== null;

  if (!runComplete) {
    logger.info(
      { scope, cursor: cp.payload.cursor, rowsScanned: cp.payload.rowsScanned },
      'proof-backcatalog-classifier: invocation budget reached — re-invoke to resume from the durable cursor',
    );
    return summaryFromCheckpoint(
      cp,
      { mode, gucState, executeRefusalReason, softDeletedExcluded },
      { resumed, batchesProcessed, runComplete: false },
    );
  }

  logger.warn(
    {
      scope,
      mode,
      rowsScanned: cp.payload.rowsScanned,
      plan: cp.payload.plan,
      ambiguousReasons: cp.payload.ambiguousReasons,
      softDeletedExcluded,
    },
    cp.payload.plan.ambiguous > 0
      ? 'proof-backcatalog-classifier: census COMPLETE — ⚠ ambiguous rows present; write mode is BLOCKED until they are resolved'
      : 'proof-backcatalog-classifier: census COMPLETE — zero ambiguity',
  );

  if (mode === 'dry-run') {
    return summaryFromCheckpoint(
      cp,
      { mode, gucState, executeRefusalReason, softDeletedExcluded },
      { resumed, batchesProcessed },
    );
  }

  return finalizeWriteMode(cp, {
    mode,
    gucState,
    executeRefusalReason,
    softDeletedExcluded,
    batchesProcessed,
    resumed,
    deps,
  });
}

/**
 * Write-mode gate + apply. Reached only with a COMPLETED census.
 * Order: halt-on-ambiguous → GUC re-check → per-class write sets.
 * Today the write sets surface the 0354 schema gap, so this always returns a
 * refusal (or a vacuous success when nothing needs persisting) with ZERO
 * writes — the structure is in place for when 0354 lands.
 */
async function finalizeWriteMode(
  cp: CheckpointHandle,
  ctx: {
    mode: 'write';
    gucState: GucState;
    executeRefusalReason: string | null;
    softDeletedExcluded: number | 'unknown';
    batchesProcessed: number;
    resumed: boolean;
    deps: ClassifierDeps;
  },
): Promise<ClassifierSummary> {
  const { deps } = ctx;
  const base = summaryFromCheckpoint(
    cp,
    {
      mode: ctx.mode,
      gucState: ctx.gucState,
      executeRefusalReason: ctx.executeRefusalReason,
      softDeletedExcluded: ctx.softDeletedExcluded,
    },
    { resumed: ctx.resumed, batchesProcessed: ctx.batchesProcessed },
  );

  // AC: the run must HALT (refuse write mode) if ambiguous > 0.
  if (cp.payload.plan.ambiguous > 0) {
    deps.logger.error(
      { scope: cp.payload.scope, ambiguous: cp.payload.plan.ambiguous, reasons: cp.payload.ambiguousReasons },
      'proof-backcatalog-classifier: WRITE MODE HALTED — ambiguous rows present; resolve them (or re-census) before any write',
    );
    return { ...base, refused: true, refusalReason: 'ambiguous_rows_present' };
  }

  // GUC re-check immediately before any write phase (belt over the per-
  // invocation check — a resume-time flip must not slip through).
  const gucNow = await deps.guc.getProofEnforcementGuc();
  if (gucNow !== 'off') {
    return {
      ...base,
      gucState: gucNow,
      refused: true,
      refusalReason: gucNow === 'on' ? 'guc_enforcement_on' : 'guc_state_unknown',
    };
  }

  // Per-class write sets. Classes that need persistence surface the 0354 gap.
  const classesNeedingWrites = (Object.keys(cp.payload.plan) as BackCatalogClass[]).filter(
    (cls) => cp.payload.plan[cls] > 0,
  );
  for (const cls of classesNeedingWrites) {
    const ws = buildClassWriteSet(cls);
    if (ws.schemaGap) {
      deps.logger.error(
        { scope: cp.payload.scope, cls, rows: cp.payload.plan[cls], schemaGap: ws.schemaGap },
        'proof-backcatalog-classifier: WRITE MODE STOPPED — 0340 lacks the completeness-class column (the 0354 decision); zero writes performed',
      );
      return { ...base, refused: true, refusalReason: 'schema_gap_0354', schemaGap: ws.schemaGap };
    }
    // ws.values non-null would be applied here (0354 future); today the only
    // classes without a schema gap have nothing to persist.
  }

  deps.logger.info(
    { scope: cp.payload.scope, plan: cp.payload.plan },
    'proof-backcatalog-classifier: write mode had nothing to persist (all rows already complete)',
  );
  return base;
}

export const __testing = {
  clampBatchSize,
  chunk,
  DEFAULT_BATCH_SIZE,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  AMBIGUOUS_SAMPLE_CAP,
};

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
 *   - THIS job owns the honest CENSUS + persisting the 0354 class label.
 *     It performs zero chain calls and zero reconstruction.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *   - DRY-RUN BY DEFAULT: emits the per-class plan with zero writes to
 *     anchors/anchor_proofs; durable checkpoint rows in job_queue (dry-run
 *     included). "Zero writes" is scoped to the proof catalogue — the resumable
 *     census still persists its own job_queue checkpoint state in both modes.
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
 *   - 0354 WRITE PATH (UPDATE-only, one column): migration 0354 added
 *     `anchor_proofs.proof_completeness_class` + the `get_proof_enforcement_
 *     guc()` reader RPC. Write mode persists EXACTLY that one column on
 *     EXISTING proof rows. It NEVER inserts an anchor_proofs row (anchor_id /
 *     receipt_id are read-only — a row that does not exist cannot honestly be
 *     conjured to carry a label); anchors lacking a proof row are counted in
 *     `classUnpersistedNoProofRow` instead. The apply pass re-classifies each
 *     page fresh and HALTS before writing any page that turns ambiguous.
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

/**
 * Hard bounds on the per-invocation batch budget. `maxBatches` flows straight
 * from the HTTP `max_batches` param; without a clamp a mistyped value would
 * turn one authenticated POST into an unbounded synchronous run. (Mirrors the
 * deliberate bound already applied to `batchSize`.)
 */
const MIN_BATCHES_PER_INVOCATION = 1;
const MAX_BATCHES_PER_INVOCATION = 200;

/** Bounded fan-out for tx-cardinality probes. */
const CARDINALITY_CONCURRENCY = 8;

/**
 * Tx-cardinality probes fetch at most 2 ids: classification only ever needs
 * to distinguish 0 / 1 / ≥2 live anchors on a tx. R0-8 (SCRUM-1254): no
 * exact-count head-counts against the hot anchors table — a LIMIT-2 index
 * probe answers the same question and stops early.
 */
const CARDINALITY_PROBE_LIMIT = 2;

/**
 * Soft-deleted caveat probe cap: the excluded-row count is exact up to this
 * many ids; past the cap the summary reports 'unknown' rather than a
 * truncated number. (R0-8 again: an id fetch bounded by LIMIT, not an
 * exact-count scan over anchors.)
 */
const SOFT_DELETED_PROBE_LIMIT = 1_000;

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

/**
 * F1 concurrency guard. Two concurrent /classify-proof-backcatalog invocations
 * for the same (scope,mode) both read-modify-write the ONE durable job_queue
 * checkpoint row — last-writer-wins REWINDS the census cursor and silently
 * corrupts the per-class plan Carson gates the 2.97M labeling on. This mutex
 * refuses the second invocation.
 *
 * Backed by the existing `try_advisory_lock` / `release_advisory_lock` RPCs
 * (baseline; service_role-granted). Injectable so unit tests exercise the
 * refuse/release paths without a DB. Absent → a permissive no-op (matches
 * chain-maintenance's single-worker no-op assumption); the production cron path
 * injects the real DB locker.
 */
export interface ClassifierLocker {
  /** Try to take the lock. false ⇒ another invocation holds it → skip loudly. */
  acquire(lockId: number): Promise<boolean>;
  /** Best-effort release (safe to call even if the unlock lands on a pooled
   *  backend that never held it — pg_advisory_unlock returns false, no throw). */
  release(lockId: number): Promise<void>;
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
  /** 0354 label already on the row (null = unlabeled). Enables idempotent skip. */
  proof_completeness_class: string | null;
}

export type GucState = 'on' | 'off' | 'unknown';

/**
 * Injectable reader for `arkova.proof_enforce_secured_complete`.
 *
 * The `get_proof_enforcement_guc()` reader RPC ships with migration 0354
 * (service_role-only SECURITY DEFINER over `current_setting(..., true)`).
 * On any database where 0354 is not applied (or the RPC errors),
 * `createDbGucReader` returns 'unknown' — the run fail-closes on 'unknown'
 * for write mode and proceeds loudly for the zero-write dry-run census.
 */
export interface GucReader {
  getProofEnforcementGuc(): Promise<GucState>;
}

export interface ClassifierDeps {
  client: SupabaseClient;
  guc: GucReader;
  logger: ClassifierLogger;
  /**
   * F1 concurrency guard. Absent → a permissive no-op locker (the census still
   * runs — matches the single-worker no-op assumption). The production cron
   * path passes `createDbLocker(db)`.
   */
  locker?: ClassifierLocker;
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
  /** True when the run refused (lock held, GUC on/unknown, ambiguity, or schema gap). */
  refused: boolean;
  refusalReason:
    | 'lock_not_acquired'
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
  /** Cumulative 0354 label updates applied (from the checkpoint). */
  writesApplied: number;
  /** True when the 0354 label apply pass has completed for this checkpoint. */
  applyComplete: boolean;
  /**
   * Honesty caveat: rows whose class needs persisting but which have NO
   * anchor_proofs row to carry it. A missing row is COUNTED, never fabricated
   * (an INSERT would have to write the read-only anchor_id/receipt_id).
   */
  classUnpersistedNoProofRow: number;
  /** Last-processed anchor id (the durable resume cursor). */
  cursor: string | null;
  /**
   * Honesty caveat: count of soft-deleted SECURED anchors excluded from the
   * census (they are out of the servable proof catalogue but still exist).
   * 'unknown' when the best-effort count query failed.
   */
  softDeletedExcluded: number | 'unknown';
  /**
   * Honesty caveat (F3): count of rows classified `already_complete`
   * (merkle_root + proof_path present) that nonetheless carry NO chain_tx_id.
   * That is a self-contradiction — a complete proof with no anchoring tx. The
   * class vocabulary is unchanged (these still count as already_complete); this
   * surfaces the contradiction so the census stays honest (§1.5).
   */
  alreadyCompleteWithoutTx: number;
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

export interface ClassWriteSet {
  /** Column→value map to write, or null when nothing may be written. */
  values: Record<string, unknown> | null;
  /** Populated when the class NEEDS persistence but the schema lacks the column. */
  schemaGap: SchemaGap | null;
}

/**
 * Resolve what write-mode may persist for a class. Structurally incapable of
 * emitting a read-only proof column: the ONLY writable column is the 0354
 * class column (this was the single point that changed when 0354 landed —
 * the former `schema_gap_0354` refusal branch became the one-column write
 * set). The `schemaGap` channel stays wired as a generic fail-honest guard
 * for any FUTURE class that needs a column the schema lacks.
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
      // 0354: persist EXACTLY the class label, nothing else.
      return { values: { proof_completeness_class: cls }, schemaGap: null };
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
 * Production GUC reader. Calls the `get_proof_enforcement_guc` RPC (migration
 * 0354) — a service_role-only SECURITY DEFINER one-liner over
 * `current_setting('arkova.proof_enforce_secured_complete', true)`. On any
 * database without 0354 (or on any RPC error), every call maps to 'unknown'
 * → write mode fail-closes; the zero-write dry-run census proceeds loudly.
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

// ── Advisory lock (F1 concurrency guard) ─────────────────────────────────────

/**
 * Deterministic 53-bit lock id for a (scope, mode) pair. FNV-1a over
 * `${CHECKPOINT_JOB_TYPE}:${scope}:${mode}` folded into the JS safe-integer
 * range (Number.MAX_SAFE_INTEGER, 2^53-1) — well inside Postgres bigint's
 * signed 64-bit domain and safely representable as a JS number end-to-end (no
 * precision loss when it round-trips through supabase-js / PostgREST as JSON).
 * The single-bigint pg_try_advisory_lock namespace is DISTINCT from the
 * two-int form (e.g. baseline's (8675309,1)), so there is no cross-lock
 * collision; chain-maintenance's tiny LOCK_* integers won't collide with a
 * 53-bit hash either.
 */
export function computeClassifierLockId(scope: string, mode: 'dry-run' | 'write'): number {
  const key = `${CHECKPOINT_JOB_TYPE}:${scope}:${mode}`;
  // 64-bit FNV-1a via BigInt, then reduce into the 53-bit safe-integer range.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const char of key) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = (hash * prime) & mask;
  }
  return Number(hash % 9007199254740991n); // % (2^53 - 1) → safe integer
}

/**
 * Production advisory locker over the baseline `try_advisory_lock` /
 * `release_advisory_lock` RPCs (SECURITY DEFINER, service_role-granted).
 *
 * HONEST SCOPE (§1.5): this is a SESSION-level advisory lock reached through
 * PostgREST. It reliably refuses a concurrent invocation while the acquiring
 * backend's session is live, which is the corruption vector we care about (two
 * simultaneous invocations racing the ONE checkpoint row). It is NOT a
 * distributed lock: under connection pooling the `release` RPC may land on a
 * different pooled backend than `acquire` did, in which case the unlock is a
 * no-op and the real lock clears when that backend's session is recycled. The
 * durable job_queue checkpoint (monotonic cursor) remains the source of truth;
 * the lock's job is only to keep two invocations from interleaving their
 * read-modify-write of it. `acquire` fails CLOSED on any RPC error (we do not
 * run the census without the lock).
 */
export function createDbLocker(client: SupabaseClient): ClassifierLocker {
  const rpc = (
    client as unknown as {
      rpc(
        name: string,
        args: Record<string, unknown>,
      ): Promise<{ data: unknown; error: { message?: string } | null }>;
    }
  ).rpc.bind(client);
  return {
    async acquire(lockId: number): Promise<boolean> {
      const { data, error } = await rpc('try_advisory_lock', { lock_id: lockId });
      if (error) return false; // fail-closed
      return data === true;
    },
    async release(lockId: number): Promise<void> {
      // Best-effort: never throw — a failed/no-op unlock must not mask the
      // run's real outcome (and the lock self-heals on session recycle).
      try {
        await rpc('release_advisory_lock', { lock_id: lockId });
      } catch {
        /* swallow — best-effort unlock */
      }
    },
  };
}

/** No-op locker used when none is injected (single-worker no-op assumption). */
const NOOP_LOCKER: ClassifierLocker = {
  async acquire() {
    return true;
  },
  async release() {
    /* no-op */
  },
};

// ── Pure classification ──────────────────────────────────────────────────────

function isFilled(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * Classify one SECURED anchor. Pure — all inputs are passed in.
 *
 * @param txCardinality Number of live anchors sharing this anchor's tx
 *   (including itself), or null when it was not / could not be resolved.
 *   May be CAPPED at 2 by the LIMIT-2 probe (2 stands for "≥2") — this
 *   function only ever distinguishes <1 / 1 / >1, so the cap is lossless.
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
  /** F3 caveat: already_complete rows with no chain_tx_id (cumulative). */
  alreadyCompleteWithoutTx: number;
  ambiguousReasons: Partial<Record<AmbiguityReason, number>>;
  ambiguousSamples: Array<{ anchor_id: string; reason: AmbiguityReason }>;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  // ── 0354 label-apply phase (all optional: pre-0354 checkpoints stay loadable) ──
  /** Last anchor id the apply pass has processed (durable apply resume cursor). */
  applyCursor?: string | null;
  /** Set when the apply pass has covered the whole scope. */
  applyCompletedAt?: string | null;
  /** Cumulative one-column label updates applied. */
  writesApplied?: number;
  /** Cumulative rows whose class had no proof row to carry it (honest caveat). */
  unpersistedNoProofRow?: number;
}

interface CheckpointHandle {
  id: string;
  payload: CheckpointPayload;
}

type UntypedDb = {
  from(table: string): {
    select(cols: string): {
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
      in(
        col: string,
        vals: string[],
      ): {
        select(cols: string): PromiseLike<{
          data: Array<{ anchor_id: string }> | null;
          error: { message?: string } | null;
        }>;
      };
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

function clampMaxBatches(requested: number | undefined): number {
  const n = requested ?? DEFAULT_MAX_BATCHES_PER_INVOCATION;
  if (!Number.isFinite(n)) return DEFAULT_MAX_BATCHES_PER_INVOCATION;
  return Math.min(Math.max(Math.floor(n), MIN_BATCHES_PER_INVOCATION), MAX_BATCHES_PER_INVOCATION);
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
      .select('anchor_id, merkle_root, proof_path, batch_id, proof_completeness_class')
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
 * Resolve tx cardinality (live anchors sharing the tx, CAPPED at 2 — see
 * CARDINALITY_PROBE_LIMIT) for each distinct tx, memoized across the whole
 * invocation. DELIBERATELY GLOBAL — no org filter: a tx shared with another
 * org's anchor is still a batch tx. Uses the partial index
 * idx_anchors_chain_tx_id (deleted_at IS NULL AND chain_tx_id IS NOT NULL)
 * via LIMIT-2 id probes, NOT exact-count head-counts (R0-8 /
 * SCRUM-1254): classification only needs 0 / 1 / ≥2, and the bounded probe
 * stops as soon as a second row exists. A probe failure marks that tx
 * 'unknown' → the affected rows classify AMBIGUOUS (fail-closed).
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
    const { data, error } = await (
      db.from('anchors').select('id').eq('chain_tx_id', tx) as unknown as {
        is(col: string, val: unknown): {
          limit(n: number): PromiseLike<{
            data: Array<{ id: string }> | null;
            error: { message?: string } | null;
          }>;
        };
      }
    )
      .is('deleted_at', null)
      .limit(CARDINALITY_PROBE_LIMIT);
    if (error || !data) {
      logger.warn(
        { tx, error: error?.message ?? 'null rows' },
        'proof-backcatalog-classifier: cardinality probe failed — rows on this tx will classify AMBIGUOUS',
      );
      memo.set(tx, null);
      return;
    }
    // data.length is 0, 1, or 2 — 2 stands for "≥2", which is everything
    // classifyAnchor ever distinguishes (<1 ⇒ ambiguous, 1 ⇒ direct, >1 ⇒ shared).
    memo.set(tx, data.length);
  });

  await runWithConcurrency(tasks, CARDINALITY_CONCURRENCY);
}

/**
 * Best-effort census caveat: soft-deleted SECURED anchors excluded from scope.
 * Counted via a LIMIT-capped id fetch, NOT an exact count (R0-8 /
 * SCRUM-1254 — no exact-count scans on the hot anchors table). Exact up to
 * SOFT_DELETED_PROBE_LIMIT rows; past the cap the summary reports 'unknown'
 * (with a warn) rather than a silently truncated number.
 */
async function countSoftDeletedExcluded(
  db: UntypedDb,
  orgId: string | undefined,
  logger: ClassifierLogger,
): Promise<number | 'unknown'> {
  try {
    let q = db.from('anchors').select('id').eq('status', 'SECURED') as unknown as {
      eq(col: string, val: unknown): typeof q;
      not(col: string, op: string, val: unknown): {
        limit(n: number): PromiseLike<{
          data: Array<{ id: string }> | null;
          error: { message?: string } | null;
        }>;
      };
    };
    if (orgId) q = q.eq('org_id', orgId);
    const { data, error } = await q.not('deleted_at', 'is', null).limit(SOFT_DELETED_PROBE_LIMIT);
    if (error || !data) return 'unknown';
    if (data.length >= SOFT_DELETED_PROBE_LIMIT) {
      logger.warn(
        { cap: SOFT_DELETED_PROBE_LIMIT, orgId: orgId ?? 'global' },
        'proof-backcatalog-classifier: soft-deleted caveat probe hit its cap — reporting unknown, not a truncated count',
      );
      return 'unknown';
    }
    return data.length;
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
    writesApplied: cp.payload.writesApplied ?? 0,
    applyComplete: (cp.payload.applyCompletedAt ?? null) !== null,
    classUnpersistedNoProofRow: cp.payload.unpersistedNoProofRow ?? 0,
    cursor: cp.payload.cursor,
    softDeletedExcluded: base.softDeletedExcluded,
    // Defensive default: a checkpoint written before F3 lacks this field.
    alreadyCompleteWithoutTx: cp.payload.alreadyCompleteWithoutTx ?? 0,
    ...extra,
  };
}

/**
 * The empty refused-before-scanning summary (GUC gate refusals). Shared by
 * the two refusal paths so they cannot drift apart.
 */
function buildEmptyRefusal(args: {
  mode: 'dry-run' | 'write';
  refusalReason: NonNullable<ClassifierSummary['refusalReason']>;
  executeRefusalReason: string | null;
  gucState: GucState;
  scope: string;
}): ClassifierSummary {
  return {
    mode: args.mode,
    refused: true,
    refusalReason: args.refusalReason,
    executeRefusalReason: args.executeRefusalReason,
    schemaGap: null,
    gucState: args.gucState,
    scope: args.scope,
    runComplete: false,
    resumed: false,
    batchesProcessed: 0,
    rowsScanned: 0,
    plan: emptyPlan(),
    ambiguousReasons: {},
    ambiguousSamples: [],
    writesApplied: 0,
    applyComplete: false,
    classUnpersistedNoProofRow: 0,
    cursor: null,
    softDeletedExcluded: 'unknown',
    alreadyCompleteWithoutTx: 0,
  };
}

/**
 * GUC gate for one invocation (start or resume both pass through here).
 * Returns the refusal reason, or null when the run may proceed. Dry-run may
 * proceed under 'unknown' (loudly); write mode fail-closes on anything but a
 * confirmed 'off'.
 */
function resolveGucGate(
  gucState: GucState,
  mode: 'dry-run' | 'write',
  scope: string,
  logger: ClassifierLogger,
): 'guc_enforcement_on' | 'guc_state_unknown' | null {
  if (gucState === 'on') {
    logger.error(
      { scope, mode },
      'proof-backcatalog-classifier: REFUSING — arkova.proof_enforce_secured_complete is ON (the 0340 trigger would reject honest empty-branch rows mid-run)',
    );
    return 'guc_enforcement_on';
  }
  if (gucState === 'unknown') {
    if (mode === 'write') {
      logger.error(
        { scope },
        'proof-backcatalog-classifier: REFUSING write mode — GUC state cannot be confirmed (no reader RPC on this database yet; fail-closed)',
      );
      return 'guc_state_unknown';
    }
    logger.warn(
      { scope },
      'proof-backcatalog-classifier: GUC state unknown — proceeding with the zero-write dry-run census only',
    );
  }
  return null;
}

/** Which txs still need a cardinality probe (stored proof data cannot settle them). */
function txsNeedingCardinality(
  page: ScanAnchorRow[],
  proofMap: Map<string, ClassifierProofRow>,
): string[] {
  return page
    .filter((a) => {
      if (!a.chain_tx_id) return false;
      const proof = proofMap.get(a.id) ?? null;
      if (proof && isFilled(proof.merkle_root) && isFilled(proof.proof_path)) return false;
      if (proof && isFilled(proof.merkle_root) && isFilled(proof.batch_id)) return false;
      return true;
    })
    .map((a) => a.chain_tx_id as string);
}

/** Classify one page into the checkpoint's cumulative counts (mutates cp.payload). */
function classifyPageIntoCheckpoint(
  page: ScanAnchorRow[],
  proofMap: Map<string, ClassifierProofRow>,
  cardinalityMemo: Map<string, number | null>,
  cp: CheckpointHandle,
): void {
  for (const a of page) {
    const proof = proofMap.get(a.id) ?? null;
    const cardinality = a.chain_tx_id ? (cardinalityMemo.get(a.chain_tx_id) ?? null) : null;
    const { cls, reason } = classifyAnchor(a, proof, cardinality);
    cp.payload.rowsScanned += 1;
    cp.payload.plan[cls] += 1;
    // F3 caveat: a complete proof (root+path) with no anchoring tx is a
    // contradiction. Vocabulary is unchanged — it still counts as
    // already_complete above — but the count is surfaced.
    if (cls === 'already_complete' && !a.chain_tx_id) {
      cp.payload.alreadyCompleteWithoutTx = (cp.payload.alreadyCompleteWithoutTx ?? 0) + 1;
    }
    if (cls === 'ambiguous' && reason) {
      cp.payload.ambiguousReasons[reason] = (cp.payload.ambiguousReasons[reason] ?? 0) + 1;
      if (cp.payload.ambiguousSamples.length < AMBIGUOUS_SAMPLE_CAP) {
        cp.payload.ambiguousSamples.push({ anchor_id: a.id, reason });
      }
    }
  }
}

/**
 * The bounded scan loop: classify up to `maxBatches` pages, checkpointing
 * after every page. Returns the number of batches processed; completion is
 * recorded on the checkpoint itself (payload.completedAt).
 */
async function runCensusScan(
  db: UntypedDb,
  cp: CheckpointHandle,
  opts: { orgId?: string; batchSize: number; maxBatches: number; scope: string },
  logger: ClassifierLogger,
): Promise<number> {
  const cardinalityMemo = new Map<string, number | null>();
  let batchesProcessed = 0;

  while (batchesProcessed < opts.maxBatches) {
    const page = await fetchScanPage(db, {
      orgId: opts.orgId,
      cursor: cp.payload.cursor,
      batchSize: opts.batchSize,
    });

    if (page.length === 0) {
      cp.payload.completedAt = new Date().toISOString();
      cp.payload.updatedAt = cp.payload.completedAt;
      await saveCheckpoint(db, cp);
      break;
    }

    const proofMap = await fetchProofRows(db, page.map((a) => a.id));
    await resolveCardinalities(db, txsNeedingCardinality(page, proofMap), cardinalityMemo, logger);
    classifyPageIntoCheckpoint(page, proofMap, cardinalityMemo, cp);

    cp.payload.cursor = page.at(-1)?.id ?? cp.payload.cursor;
    cp.payload.updatedAt = new Date().toISOString();
    const isLastPage = page.length < opts.batchSize;
    if (isLastPage) cp.payload.completedAt = cp.payload.updatedAt;
    await saveCheckpoint(db, cp);
    batchesProcessed += 1;

    logger.info(
      {
        scope: opts.scope,
        batch: batchesProcessed,
        rowsScanned: cp.payload.rowsScanned,
        plan: cp.payload.plan,
        cursor: cp.payload.cursor,
      },
      'proof-backcatalog-classifier: batch classified',
    );

    if (isLastPage) break;
  }

  return batchesProcessed;
}

// ── The run ──────────────────────────────────────────────────────────────────

export async function runBackCatalogClassifier(
  deps: ClassifierDeps,
  options: ClassifierOptions = {},
): Promise<ClassifierSummary> {
  const { logger } = deps;
  const confirmToken = deps.confirmToken ?? config.proofClassifierConfirm ?? undefined;

  const guard = resolveExecuteGuard(options.execute, confirmToken);
  const mode: 'dry-run' | 'write' = guard.permitted ? 'write' : 'dry-run';
  const executeRefusalReason = options.execute === true && !guard.permitted ? guard.reason : null;
  const scope = options.orgId ?? 'global';

  // ── F1 concurrency guard: refuse a second concurrent invocation for the
  //    same (scope,mode). Two concurrent runs share the ONE durable checkpoint
  //    row → last-writer-wins rewinds the cursor. Acquire BEFORE any checkpoint
  //    / scan work; release in `finally` on EVERY path (success or throw). ────
  const locker = deps.locker ?? NOOP_LOCKER;
  const lockId = computeClassifierLockId(scope, mode);
  const acquired = await locker.acquire(lockId);
  if (!acquired) {
    logger.warn(
      { scope, mode, lockId },
      'proof-backcatalog-classifier: REFUSING — another invocation for this (scope,mode) holds the advisory lock; skipping to avoid checkpoint-cursor corruption',
    );
    return buildEmptyRefusal({
      mode,
      refusalReason: 'lock_not_acquired',
      executeRefusalReason,
      gucState: 'unknown',
      scope,
    });
  }
  try {
    return await runCensusUnderLock(deps, options, { mode, executeRefusalReason, scope });
  } finally {
    await locker.release(lockId);
  }
}

/**
 * The census body, run while the (scope,mode) advisory lock is HELD. Extracted
 * from `runBackCatalogClassifier` so the lock's acquire/finally-release wraps
 * every return and throw path.
 */
async function runCensusUnderLock(
  deps: ClassifierDeps,
  options: ClassifierOptions,
  pre: {
    mode: 'dry-run' | 'write';
    executeRefusalReason: string | null;
    scope: string;
  },
): Promise<ClassifierSummary> {
  const { logger } = deps;
  const db = deps.client as unknown as UntypedDb;
  const { mode, executeRefusalReason, scope } = pre;
  const batchSize = clampBatchSize(options.batchSize);
  const maxBatches = clampMaxBatches(options.maxBatches);

  // ── GUC guard: every invocation is a start or a resume — check both. ──────
  const gucState = await deps.guc.getProofEnforcementGuc();
  const gucRefusal = resolveGucGate(gucState, mode, scope, logger);
  if (gucRefusal) {
    return buildEmptyRefusal({ mode, refusalReason: gucRefusal, executeRefusalReason, gucState, scope });
  }

  logger.info(
    { scope, mode, batchSize, maxBatches, restart: options.restart === true, gucState },
    mode === 'dry-run'
      ? 'proof-backcatalog-classifier: DRY-RUN census — computing the per-class plan, writing NOTHING'
      : 'proof-backcatalog-classifier: WRITE mode requested — plan first, halt on ambiguity, then apply',
  );

  const softDeletedExcluded = await countSoftDeletedExcluded(db, options.orgId, logger);

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
      orgId: options.orgId,
      batchSize,
      maxBatches,
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
      alreadyCompleteWithoutTx: 0,
      ambiguousReasons: {},
      ambiguousSamples: [],
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    });
    resumed = false;
  }

  // ── Scan loop (bounded per invocation; checkpoint after every batch). ─────
  const batchesProcessed = await runCensusScan(
    db,
    cp,
    { orgId: options.orgId, batchSize, maxBatches, scope },
    logger,
  );

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
    orgId: options.orgId,
    batchSize,
    maxBatches,
  });
}

/**
 * The 0354 label apply: a second bounded, resumable pass over the census
 * scope that persists `proof_completeness_class` — UPDATE-only against
 * EXISTING anchor_proofs rows, exactly one column per write. It NEVER inserts
 * a proof row (anchor_id/receipt_id are read-only; a missing row is counted
 * in unpersistedNoProofRow, not conjured). Every page is RE-classified fresh
 * at apply time and the pass HALTS before writing any page containing an
 * ambiguous row (the census's zero-ambiguity gate is re-proven per page —
 * data may have changed since the census). Idempotent: rows whose stored
 * label already matches are skipped, so a re-run applies zero writes.
 */
async function runLabelApply(
  db: UntypedDb,
  cp: CheckpointHandle,
  opts: { orgId?: string; batchSize: number; maxBatches: number },
  logger: ClassifierLogger,
): Promise<{ halted: boolean }> {
  const cardinalityMemo = new Map<string, number | null>();
  let batches = 0;

  while (batches < opts.maxBatches) {
    const page = await fetchScanPage(db, {
      orgId: opts.orgId,
      cursor: cp.payload.applyCursor ?? null,
      batchSize: opts.batchSize,
    });

    if (page.length === 0) {
      cp.payload.applyCompletedAt = new Date().toISOString();
      cp.payload.updatedAt = cp.payload.applyCompletedAt;
      await saveCheckpoint(db, cp);
      break;
    }

    const proofMap = await fetchProofRows(db, page.map((a) => a.id));
    await resolveCardinalities(db, txsNeedingCardinality(page, proofMap), cardinalityMemo, logger);

    // Classify the WHOLE page first: any ambiguity halts BEFORE any write.
    const idsByClass = new Map<BackCatalogClass, string[]>();
    let unpersisted = 0;
    for (const a of page) {
      const proof = proofMap.get(a.id) ?? null;
      const cardinality = a.chain_tx_id ? (cardinalityMemo.get(a.chain_tx_id) ?? null) : null;
      const { cls, reason } = classifyAnchor(a, proof, cardinality);
      if (cls === 'ambiguous') {
        logger.error(
          { anchorId: a.id, reason, applyCursor: cp.payload.applyCursor ?? null, scope: cp.payload.scope },
          'proof-backcatalog-classifier: APPLY HALTED — row classifies ambiguous at apply time (data changed since the census); no labels written for this page',
        );
        cp.payload.updatedAt = new Date().toISOString();
        await saveCheckpoint(db, cp); // progress so far stays durable; cursor NOT advanced past this page
        return { halted: true };
      }
      const ws = buildClassWriteSet(cls);
      if (!ws.values) continue; // already_complete: nothing to persist
      if (!proof) {
        unpersisted += 1; // honest: no proof row to carry the label — NEVER insert one
        continue;
      }
      if (proof.proof_completeness_class === cls) continue; // idempotent skip
      const list = idsByClass.get(cls) ?? [];
      list.push(a.id);
      idsByClass.set(cls, list);
    }

    // Apply per-class one-column updates, chunked for PostgREST limits.
    for (const [cls, ids] of idsByClass) {
      const ws = buildClassWriteSet(cls);
      if (!ws.values) continue;
      for (const chunkIds of chunk(ids, IN_FILTER_CHUNK)) {
        const { data, error } = await db
          .from('anchor_proofs')
          .update(ws.values)
          .in('anchor_id', chunkIds)
          .select('anchor_id');
        if (error) {
          throw new Error(
            `classifier label update failed (class=${cls}): ${error.message ?? 'unknown'}`,
          );
        }
        const affected = data?.length ?? 0;
        cp.payload.writesApplied = (cp.payload.writesApplied ?? 0) + affected;
        if (affected < chunkIds.length) {
          // A proof row vanished between read and write: count it honestly.
          unpersisted += chunkIds.length - affected;
          logger.warn(
            { cls, targeted: chunkIds.length, affected, scope: cp.payload.scope },
            'proof-backcatalog-classifier: label update affected fewer rows than targeted — counting the difference as unpersisted',
          );
        }
      }
    }

    cp.payload.unpersistedNoProofRow = (cp.payload.unpersistedNoProofRow ?? 0) + unpersisted;
    cp.payload.applyCursor = page[page.length - 1].id;
    cp.payload.updatedAt = new Date().toISOString();
    const isLastPage = page.length < opts.batchSize;
    if (isLastPage) cp.payload.applyCompletedAt = cp.payload.updatedAt;
    await saveCheckpoint(db, cp);
    batches += 1;

    logger.info(
      {
        scope: cp.payload.scope,
        applyBatch: batches,
        writesApplied: cp.payload.writesApplied ?? 0,
        unpersistedNoProofRow: cp.payload.unpersistedNoProofRow ?? 0,
        applyCursor: cp.payload.applyCursor,
      },
      'proof-backcatalog-classifier: apply page labeled',
    );

    if (isLastPage) break;
  }

  return { halted: false };
}

/**
 * Write-mode gate + apply. Reached only with a COMPLETED census.
 * Order: halt-on-ambiguous → GUC re-check (fail-closed) → generic schema-gap
 * guard → 0354 label apply (bounded + resumable; re-invoke to continue).
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
    orgId?: string;
    batchSize: number;
    maxBatches: number;
  },
): Promise<ClassifierSummary> {
  const { deps } = ctx;
  const buildBase = () =>
    summaryFromCheckpoint(
      cp,
      {
        mode: ctx.mode,
        gucState: ctx.gucState,
        executeRefusalReason: ctx.executeRefusalReason,
        softDeletedExcluded: ctx.softDeletedExcluded,
      },
      { resumed: ctx.resumed, batchesProcessed: ctx.batchesProcessed },
    );
  const base = buildBase();

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

  // Generic fail-honest guard: any FUTURE class whose write set names a
  // column the schema lacks stops here (the original 0354 gap mechanism,
  // kept armed even though every current class now resolves).
  const classesInPlan = (Object.keys(cp.payload.plan) as BackCatalogClass[]).filter(
    (cls) => cp.payload.plan[cls] > 0,
  );
  for (const cls of classesInPlan) {
    const ws = buildClassWriteSet(cls);
    if (ws.schemaGap) {
      deps.logger.error(
        { scope: cp.payload.scope, cls, rows: cp.payload.plan[cls], schemaGap: ws.schemaGap },
        'proof-backcatalog-classifier: WRITE MODE STOPPED — schema lacks the column this class needs; zero writes performed',
      );
      return { ...base, refused: true, refusalReason: 'schema_gap_0354', schemaGap: ws.schemaGap };
    }
  }

  // Idempotent short-circuit: this checkpoint's apply pass already finished.
  if ((cp.payload.applyCompletedAt ?? null) !== null) {
    deps.logger.info(
      { scope: cp.payload.scope, writesApplied: cp.payload.writesApplied ?? 0 },
      'proof-backcatalog-classifier: label apply already complete for this census — nothing further to write (restart=true for a fresh census)',
    );
    return base;
  }

  const needsApply = classesInPlan.some((cls) => buildClassWriteSet(cls).values !== null);
  const db = deps.client as unknown as UntypedDb;

  if (!needsApply) {
    // Vacuous success: nothing in the plan needs a label.
    cp.payload.applyCompletedAt = new Date().toISOString();
    cp.payload.updatedAt = cp.payload.applyCompletedAt;
    await saveCheckpoint(db, cp);
    deps.logger.info(
      { scope: cp.payload.scope, plan: cp.payload.plan },
      'proof-backcatalog-classifier: write mode had nothing to persist (all rows already complete)',
    );
    return buildBase();
  }

  const { halted } = await runLabelApply(
    db,
    cp,
    { orgId: ctx.orgId, batchSize: ctx.batchSize, maxBatches: ctx.maxBatches },
    deps.logger,
  );
  const after = buildBase();
  if (halted) {
    return { ...after, refused: true, refusalReason: 'ambiguous_rows_present' };
  }
  if ((cp.payload.applyCompletedAt ?? null) === null) {
    deps.logger.info(
      { scope: cp.payload.scope, applyCursor: cp.payload.applyCursor ?? null },
      'proof-backcatalog-classifier: apply budget reached — re-invoke to resume labeling from the durable apply cursor',
    );
  }
  return after;
}

export const __testing = {
  clampBatchSize,
  clampMaxBatches,
  chunk,
  DEFAULT_BATCH_SIZE,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
  MIN_BATCHES_PER_INVOCATION,
  MAX_BATCHES_PER_INVOCATION,
  CARDINALITY_PROBE_LIMIT,
  SOFT_DELETED_PROBE_LIMIT,
  AMBIGUOUS_SAMPLE_CAP,
};

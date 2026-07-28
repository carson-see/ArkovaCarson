/**
 * Direct-anchor proof MATERIALIZER (SCRUM-2917, CTO ruling Confluence
 * 110198785) — the INSERT-capable counterpart to the back-catalogue
 * classifier.
 *
 * Prod's ~2.97M SECURED direct anchors mostly have NO anchor_proofs row at
 * all (pre-FIX-1 catalogue). This job INSERTs an honest SKELETON row for each
 * classifier-`direct_anchored` anchor that lacks one:
 *
 *   { anchor_id, receipt_id := anchors.chain_tx_id,
 *     proof_completeness_class = 'direct_anchored',
 *     materialize_run_id = <run uuid> }
 *
 * and NOTHING else. `receipt_id` semantically IS the chain tx id (matching
 * batch-anchor.ts `receiptId: prepared.txId`). merkle_root / proof_path /
 * op_return_payload stay EMPTY — that emptiness is the honest truth of a
 * direct anchor. This job NEVER synthesizes a degenerate single-leaf Merkle
 * branch and NEVER fabricates op_return_payload; header/payload fill is
 * deferred to the chain-sourced SCRUM-2491 job (NO chain calls here).
 *
 * ── Division of labour (do not duplicate) ────────────────────────────────────
 *   - proof-backcatalog-classifier.ts owns the honest CENSUS + the 0354
 *     class-label UPDATE on EXISTING rows (it never inserts).
 *   - backfillProofCompleteness.ts (SCRUM-2491 foundation) owns
 *     RECONSTRUCTION of the 0340 chain-data columns (block_hash,
 *     block_header, op_return_payload) via an injected chain source.
 *   - proof-branch-backfill.ts (FIX-1) owns branch REBUILDS with
 *     root-equality self-validation.
 *   - THIS job owns skeleton-row CREATION for direct anchors with no row.
 *     It performs zero chain calls, zero reconstruction, zero UPDATEs.
 *
 * ── §1.4 forge note ─────────────────────────────────────────────────────────
 *   The 0360 hardened SECURED-proof predicate requires op_return_payload —
 *   so these skeleton rows do NOT satisfy the SECURED gate until SCRUM-2491
 *   fills op_return_payload from the chain. BY DESIGN: a skeleton is a
 *   receipt-bearing placeholder, never a passable forged proof.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *   - DRY-RUN BY DEFAULT: emits the plan (skeletons that WOULD be inserted +
 *     per-class skip counts) with zero writes to anchor_proofs; the durable
 *     job_queue checkpoint is still persisted in both modes.
 *   - DUAL EXECUTE GUARD: write mode needs BOTH options.execute===true AND
 *     PROOF_MATERIALIZER_CONFIRM='EXECUTE' (deps.confirmToken; prod passes
 *     config.proofMaterializerConfirm).
 *   - GUC GUARD: refuses when arkova.proof_enforce_secured_complete is 'on';
 *     write mode fail-closes on 'unknown' (same as the classifier).
 *   - ELIGIBILITY: recomputed FRESH page-by-page at write time via the
 *     classifier's exported pure `classifyAnchor`. Only `direct_anchored`
 *     anchors with NO existing proof row are inserted; batch_provable /
 *     already_complete / existing-row anchors are skipped + counted. Any
 *     ambiguous row on a page HALTS the run BEFORE any write on that page
 *     (mirrors the classifier's runLabelApply halt; dry-run halts at the same
 *     point so it stays a faithful rehearsal of the write path).
 *   - IDEMPOTENT: `INSERT ... ON CONFLICT (anchor_id) DO NOTHING` via
 *     `.upsert(rows, { onConflict: 'anchor_id', ignoreDuplicates: true })`
 *     (constraint anchor_proofs_anchor_unique) + `.select('anchor_id')` to
 *     count actual inserts vs conflict-skips honestly.
 *   - CONCURRENCY: advisory lock keyed on the materializer's OWN job-type
 *     string (cannot collide with a concurrent classifier run); refuses when
 *     not acquired; fail-closed on lock RPC error (createDbLocker).
 *
 * ── Resumable ────────────────────────────────────────────────────────────────
 *   Durable checkpoint row in job_queue (type 'proof-materializer:checkpoint',
 *   terminal status 'completed' so it is never claimable / retried / counted
 *   by queue monitors). `runId` is a uuid minted ONCE per checkpoint at
 *   creation (crypto.randomUUID) and stamped on EVERY inserted row across all
 *   resumes of that checkpoint — it is the per-run rollback key.
 *
 * ── Rollback contract ────────────────────────────────────────────────────────
 *   DELETE FROM anchor_proofs
 *   WHERE materialize_run_id = $1
 *     AND merkle_root IS NULL AND proof_path IS NULL
 *     AND op_return_payload IS NULL;
 *   — removes only that run's still-untouched skeletons; a row later enriched
 *   by SCRUM-2491/FIX-1 stops matching and is never deleted (0359 comment).
 *
 *   Count-reconciliation caveat (§1.5): rows are stamped with the runId at
 *   insert time, but the checkpoint's cumulative `inserted` is saved only
 *   after the whole page. A crash between the two means the resume re-counts
 *   those rows as `skippedExisting` — so the summary's `inserted` can
 *   UNDER-count after a mid-page crash. The authoritative per-run figure is
 *   always `SELECT count(*) FROM anchor_proofs WHERE materialize_run_id = $1`
 *   (small partial-indexed set), not the checkpoint counter. Rollback
 *   semantics are unaffected (every inserted row carries the runId).
 *
 * Constitution refs: §1.4 (service_role only; nothing secret logged), §1.5
 * (every skip/halt counted, nothing guessed), §1.12 (T3 surface; prod
 * execution is Carson-gated).
 */

import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { config } from '../config.js';
import {
  classifyAnchor,
  computeClassifierLockId,
  type AmbiguityReason,
  type ClassifierLocker,
  type ClassifierLogger,
  type ClassifierProofRow,
  type GucReader,
  type GucState,
  type ScanAnchorRow,
} from './proof-backcatalog-classifier.js';
import {
  createCheckpointStore,
  type CheckpointHandle as SharedCheckpointHandle,
} from './proofJobCheckpoint.js';
import {
  chunk,
  clampBound,
  fetchProofRows as sharedFetchProofRows,
  fetchScanPage as sharedFetchScanPage,
  resolveCardinalities as sharedResolveCardinalities,
} from './proofJobScan.js';

// Re-exported for route wiring convenience: the prod cron path builds deps
// with the classifier's shared read-only primitives (safe to share — the
// WRITE paths of the two jobs stay fully separate).
export { createDbGucReader, createDbLocker } from './proof-backcatalog-classifier.js';

// ── Tunables (mirror the classifier's bounds) ────────────────────────────────

export const DEFAULT_BATCH_SIZE = 500;
const MIN_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 2_000;

export const DEFAULT_MAX_BATCHES_PER_INVOCATION = 20;
const MIN_BATCHES_PER_INVOCATION = 1;
const MAX_BATCHES_PER_INVOCATION = 200;

// Bounded fan-out for tx-cardinality probes now lives with the shared probe
// itself (CARDINALITY_CONCURRENCY in proofJobScan.ts).

/**
 * LIMIT-2 probe: eligibility only distinguishes 0 / 1 / ≥2 live anchors on a
 * tx (R0-8 / SCRUM-1254 — no exact-count head-counts on the hot anchors table).
 */
const CARDINALITY_PROBE_LIMIT = 2;

// `.in()` read-filter chunking now lives with the shared proof-row fetch
// (IN_FILTER_CHUNK in proofJobScan.ts).

/** Skeleton upserts travel in the request BODY; 500 mirrors utils/anchorProofs.ts. */
const INSERT_CHUNK = 500;

/**
 * Env confirmation (PROOF_MATERIALIZER_CONFIRM) required for write mode.
 * Named MATERIALIZER_* so route files importing both jobs' tokens don't clash.
 */
export const MATERIALIZER_EXECUTE_CONFIRM_TOKEN = 'EXECUTE';
const EXECUTE_CONFIRM_ENV = 'PROOF_MATERIALIZER_CONFIRM';

/** Durable checkpoint rows live in job_queue under this type. */
export const MATERIALIZER_CHECKPOINT_JOB_TYPE = 'proof-materializer:checkpoint';

// ── The skeleton row: structurally incapable of forging a proof ──────────────

/**
 * The ONLY columns a skeleton insert may carry (CTO ruling, Confluence
 * 110198785). Everything else on anchor_proofs stays NULL/default.
 */
export const SKELETON_INSERT_COLUMNS = [
  'anchor_id',
  'receipt_id',
  'proof_completeness_class',
  'materialize_run_id',
] as const;

/**
 * Columns a forged/degenerate proof would need — asserted absent from every
 * insert payload, structurally here and in tests (mirrors the classifier's
 * CLASSIFIER_READ_ONLY_COLUMNS enforcement).
 */
export const SKELETON_FORBIDDEN_COLUMNS = [
  'merkle_root',
  'proof_path',
  'merkle_index',
  'op_return_payload',
  'block_hash',
  'block_header',
  'block_height',
  'block_timestamp',
  'batch_id',
  'raw_response',
  'proof_schema_version',
  'id',
  'created_at',
] as const;

export interface SkeletonRow {
  anchor_id: string;
  receipt_id: string;
  proof_completeness_class: 'direct_anchored';
  materialize_run_id: string;
}

/**
 * Build one skeleton row. Pure and total over its inputs — the return type
 * (exact interface, no index signature) plus the structural tests make it
 * impossible for a Merkle/chain column to ride along.
 */
export function buildSkeletonRow(
  anchor: { id: string; chain_tx_id: string },
  runId: string,
): SkeletonRow {
  return {
    anchor_id: anchor.id,
    // receipt_id semantically IS the chain tx id (batch-anchor.ts
    // `receiptId: prepared.txId`) — text NOT NULL on anchor_proofs.
    receipt_id: anchor.chain_tx_id,
    proof_completeness_class: 'direct_anchored',
    materialize_run_id: runId,
  };
}

// ── Execute guard ────────────────────────────────────────────────────────────

/**
 * LOCAL copy of the classifier's resolveExecuteGuard, NOT an import: the two
 * jobs' WRITE paths must stay decoupled (sharing the guard would let a
 * refactor of one job's arming semantics silently re-arm the other, and the
 * refusal messages must name THIS job's env var). Only pure READ-ONLY
 * primitives (classifyAnchor, the GUC reader, the locker) are shared.
 */
export function resolveMaterializerExecuteGuard(
  execute: boolean | undefined,
  confirmToken: string | undefined,
): { permitted: boolean; reason: string | null } {
  if (execute !== true) {
    return {
      permitted: false,
      reason: `DRY-RUN: execute flag not set (pass execute=true AND ${EXECUTE_CONFIRM_ENV}=${MATERIALIZER_EXECUTE_CONFIRM_TOKEN})`,
    };
  }
  if (confirmToken !== MATERIALIZER_EXECUTE_CONFIRM_TOKEN) {
    return {
      permitted: false,
      reason: `DRY-RUN: env confirmation missing — set ${EXECUTE_CONFIRM_ENV}=${MATERIALIZER_EXECUTE_CONFIRM_TOKEN} (execute flag alone is insufficient)`,
    };
  }
  return { permitted: true, reason: null };
}

// ── Advisory lock key ────────────────────────────────────────────────────────

/**
 * Lock id for a (scope, mode) pair, on the materializer's OWN key string so a
 * concurrent classifier run can never collide with it. Reuses the
 * classifier's exported FNV-1a hasher by namespacing the scope with the
 * materializer job type: the effective hashed key is
 * `<classifier-type>:<materializer-type>:<scope>:<mode>`, which can never
 * equal any classifier key (classifier scopes are 'global' or an org uuid,
 * never a string containing the materializer job type).
 */
export function computeMaterializerLockId(scope: string, mode: 'dry-run' | 'write'): number {
  return computeClassifierLockId(`${MATERIALIZER_CHECKPOINT_JOB_TYPE}:${scope}`, mode);
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

// ── Types ────────────────────────────────────────────────────────────────────

export interface MaterializerDeps {
  client: SupabaseClient;
  guc: GucReader;
  logger: ClassifierLogger;
  /** Absent → permissive no-op locker; the prod cron path passes createDbLocker(db). */
  locker?: ClassifierLocker;
  /** Override for the env confirmation (testing). Defaults to typed config. */
  confirmToken?: string;
}

export interface MaterializerOptions {
  /** Must be paired with PROOF_MATERIALIZER_CONFIRM=EXECUTE to enter write mode. */
  execute?: boolean;
  /** Restrict the run to one org (tx-cardinality probes stay global). */
  orgId?: string;
  batchSize?: number;
  /** Page-batches per invocation (bounded HTTP run; re-invoke to resume). */
  maxBatches?: number;
  /** Start a fresh run (new checkpoint + NEW runId; old row stays as audit trail). */
  restart?: boolean;
}

export interface MaterializerPlan {
  /** Skeletons inserted (write) or that WOULD be inserted (dry-run). */
  toInsert: number;
  /** direct_anchored anchors that already have a proof row — never re-inserted. */
  skippedExisting: number;
  skippedBatchProvable: number;
  skippedAlreadyComplete: number;
}

export interface MaterializerSummary {
  mode: 'dry-run' | 'write';
  refused: boolean;
  refusalReason:
    | 'lock_not_acquired'
    | 'guc_enforcement_on'
    | 'guc_state_unknown'
    | 'ambiguous_rows_present'
    | null;
  /** Set when execute was requested but the confirm guard downgraded to dry-run. */
  executeRefusalReason: string | null;
  gucState: GucState;
  scope: string;
  /** The per-run rollback key (uuid) — null when the run refused before starting. */
  runId: string | null;
  runComplete: boolean;
  resumed: boolean;
  batchesProcessed: number;
  /** Cumulative rows scanned across resumes (from the checkpoint). */
  rowsScanned: number;
  planned: MaterializerPlan;
  /** Cumulative rows actually inserted (counted via .select() on the upsert). */
  inserted: number;
  /** Rows skipped by ON CONFLICT (anchor_id) DO NOTHING — a concurrent writer won. */
  conflictSkipped: number;
  /**
   * Belt-and-braces: direct_anchored candidates with a NULL chain_tx_id
   * (cannot honestly carry a receipt_id). classifyAnchor already returns
   * ambiguous for secured_without_tx, so this stays 0 on the honest path.
   */
  skippedNoTx: number;
  /** Ambiguous rows on the most recent halting page (0 when never halted). */
  haltedAmbiguous: number;
  ambiguousReasons: Partial<Record<AmbiguityReason, number>>;
  /** Last cursor the run advanced past (the durable resume point). */
  cursor: string | null;
}

// ── Checkpoint store (job_queue) ─────────────────────────────────────────────

interface CheckpointPayload {
  schemaVersion: 1;
  scope: string;
  mode: 'dry-run' | 'write';
  /** Minted ONCE at checkpoint creation; the per-run rollback key. */
  runId: string;
  cursor: string | null;
  rowsScanned: number;
  /** Dry-run: skeletons that WOULD be inserted. Write: candidates targeted. */
  plannedToInsert: number;
  inserted: number;
  conflictSkipped: number;
  skippedExisting: number;
  skippedNotDirect: { batch_provable: number; already_complete: number };
  skippedNoTx: number;
  /**
   * Ambiguity on the MOST RECENT halting page (overwritten, not accumulated —
   * a re-invocation re-classifies the same page, so a cumulative count would
   * double-count the same rows across retries).
   */
  haltedAmbiguous: number;
  ambiguousReasons: Partial<Record<AmbiguityReason, number>>;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

type CheckpointHandle = SharedCheckpointHandle<CheckpointPayload>;

type UntypedDb = {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: unknown): unknown;
      in(col: string, val: string[]): unknown;
      is(col: string, val: unknown): unknown;
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
    upsert(
      rows: Array<Record<string, unknown>>,
      opts: { onConflict: string; ignoreDuplicates: boolean },
    ): {
      select(cols: string): PromiseLike<{
        data: Array<{ anchor_id: string }> | null;
        error: { message?: string } | null;
      }>;
    };
  };
};

// Checkpoint load/create/save is shared with proof-backcatalog-classifier —
// see proofJobCheckpoint.ts. These thin wrappers keep the call sites below
// unchanged.
function checkpointStore(db: UntypedDb) {
  return createCheckpointStore<CheckpointPayload>(
    db,
    MATERIALIZER_CHECKPOINT_JOB_TYPE,
    'materializer',
  );
}

// ── Internals ────────────────────────────────────────────────────────────────
//
// Checkpoint persistence (proofJobCheckpoint.ts), the page scan / proof-row
// fetch / cardinality probes and the option clamps (proofJobScan.ts) are all
// shared with proof-backcatalog-classifier.ts. This job calls them DIRECTLY
// with its own label rather than through local wrappers — wrappers would just
// re-introduce the duplication the extraction removed.

const BATCH_SIZE_BOUNDS = {
  fallback: DEFAULT_BATCH_SIZE,
  min: MIN_BATCH_SIZE,
  max: MAX_BATCH_SIZE,
};
const MAX_BATCHES_BOUNDS = {
  fallback: DEFAULT_MAX_BATCHES_PER_INVOCATION,
  min: MIN_BATCHES_PER_INVOCATION,
  max: MAX_BATCHES_PER_INVOCATION,
};
const clampBatchSize = (n: number | undefined): number => clampBound(n, BATCH_SIZE_BOUNDS);
const clampMaxBatches = (n: number | undefined): number => clampBound(n, MAX_BATCHES_BOUNDS);

function isFilled(value: unknown): boolean {
  return value !== null && value !== undefined;
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

// ── Summaries ────────────────────────────────────────────────────────────────

function emptyPlan(): MaterializerPlan {
  return { toInsert: 0, skippedExisting: 0, skippedBatchProvable: 0, skippedAlreadyComplete: 0 };
}

function buildEmptyRefusal(args: {
  mode: 'dry-run' | 'write';
  refusalReason: NonNullable<MaterializerSummary['refusalReason']>;
  executeRefusalReason: string | null;
  gucState: GucState;
  scope: string;
}): MaterializerSummary {
  return {
    mode: args.mode,
    refused: true,
    refusalReason: args.refusalReason,
    executeRefusalReason: args.executeRefusalReason,
    gucState: args.gucState,
    scope: args.scope,
    runId: null,
    runComplete: false,
    resumed: false,
    batchesProcessed: 0,
    rowsScanned: 0,
    planned: emptyPlan(),
    inserted: 0,
    conflictSkipped: 0,
    skippedNoTx: 0,
    haltedAmbiguous: 0,
    ambiguousReasons: {},
    cursor: null,
  };
}

function summaryFromCheckpoint(
  cp: CheckpointHandle,
  base: Pick<MaterializerSummary, 'mode' | 'gucState' | 'executeRefusalReason'>,
  extra: Partial<MaterializerSummary> = {},
): MaterializerSummary {
  return {
    mode: base.mode,
    refused: false,
    refusalReason: null,
    executeRefusalReason: base.executeRefusalReason,
    gucState: base.gucState,
    scope: cp.payload.scope,
    runId: cp.payload.runId,
    runComplete: cp.payload.completedAt !== null,
    resumed: true,
    batchesProcessed: 0,
    rowsScanned: cp.payload.rowsScanned,
    planned: {
      toInsert: cp.payload.plannedToInsert,
      skippedExisting: cp.payload.skippedExisting,
      skippedBatchProvable: cp.payload.skippedNotDirect.batch_provable,
      skippedAlreadyComplete: cp.payload.skippedNotDirect.already_complete,
    },
    inserted: cp.payload.inserted,
    conflictSkipped: cp.payload.conflictSkipped,
    skippedNoTx: cp.payload.skippedNoTx,
    haltedAmbiguous: cp.payload.haltedAmbiguous,
    ambiguousReasons: { ...cp.payload.ambiguousReasons },
    cursor: cp.payload.cursor,
    ...extra,
  };
}

/**
 * GUC gate for one invocation (start or resume both pass through here; same
 * semantics as the classifier's resolveGucGate).
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
      'proof-materializer: REFUSING — arkova.proof_enforce_secured_complete is ON (skeleton rows without op_return_payload would trip the 0360 predicate mid-run)',
    );
    return 'guc_enforcement_on';
  }
  if (gucState === 'unknown') {
    if (mode === 'write') {
      logger.error(
        { scope },
        'proof-materializer: REFUSING write mode — GUC state cannot be confirmed (fail-closed)',
      );
      return 'guc_state_unknown';
    }
    logger.warn(
      { scope },
      'proof-materializer: GUC state unknown — proceeding with the zero-write dry-run rehearsal only',
    );
  }
  return null;
}

// ── Page processing ──────────────────────────────────────────────────────────

interface PageOutcome {
  halted: boolean;
}

/**
 * Classify one page fresh, then (write mode) insert skeletons for the
 * eligible candidates. HALTS before ANY insert on the page if a single row
 * classifies ambiguous — mirrors runLabelApply's per-page halt semantics.
 */
async function processPage(
  db: UntypedDb,
  page: ScanAnchorRow[],
  cp: CheckpointHandle,
  cardinalityMemo: Map<string, number | null>,
  writeEnabled: boolean,
  logger: ClassifierLogger,
): Promise<PageOutcome> {
  const proofMap = await sharedFetchProofRows(db, page.map((a) => a.id), 'materializer');
  await sharedResolveCardinalities(
    db,
    txsNeedingCardinality(page, proofMap),
    cardinalityMemo,
    logger,
    'proof-materializer',
  );

  // Pass 1: classify the WHOLE page. Any ambiguity halts before any write.
  const candidates: Array<{ id: string; chain_tx_id: string }> = [];
  const pageAmbiguous: Partial<Record<AmbiguityReason, number>> = {};
  let ambiguousCount = 0;
  const tally = { existing: 0, batchProvable: 0, alreadyComplete: 0, noTx: 0 };

  for (const a of page) {
    const proof = proofMap.get(a.id) ?? null;
    const cardinality = a.chain_tx_id ? (cardinalityMemo.get(a.chain_tx_id) ?? null) : null;
    const { cls, reason } = classifyAnchor(a, proof, cardinality);
    if (cls === 'ambiguous') {
      ambiguousCount += 1;
      if (reason) pageAmbiguous[reason] = (pageAmbiguous[reason] ?? 0) + 1;
      continue; // keep tallying the page for an honest halt report
    }
    if (cls === 'batch_provable') {
      tally.batchProvable += 1;
      continue;
    }
    if (cls === 'already_complete') {
      tally.alreadyComplete += 1;
      continue;
    }
    // direct_anchored:
    if (proof) {
      tally.existing += 1; // a row exists — the skeleton would conflict; skip honestly
      continue;
    }
    if (!a.chain_tx_id) {
      // Belt-and-braces: classifyAnchor returns ambiguous for secured_without_tx,
      // so this branch is unreachable on the honest path — counted, never inserted.
      tally.noTx += 1;
      continue;
    }
    candidates.push({ id: a.id, chain_tx_id: a.chain_tx_id });
  }

  if (ambiguousCount > 0) {
    logger.error(
      {
        scope: cp.payload.scope,
        cursor: cp.payload.cursor,
        ambiguous: ambiguousCount,
        reasons: pageAmbiguous,
      },
      'proof-materializer: PAGE HALTED — ambiguous rows present; NO skeletons inserted for this page (cursor not advanced)',
    );
    // Most-recent-halting-page semantics (overwrite, don't accumulate — a
    // retry re-classifies the same rows).
    cp.payload.haltedAmbiguous = ambiguousCount;
    cp.payload.ambiguousReasons = pageAmbiguous;
    cp.payload.updatedAt = new Date().toISOString();
    await checkpointStore(db).save(cp); // progress so far stays durable
    return { halted: true };
  }

  // Pass 2 (write mode only): chunked idempotent skeleton inserts.
  if (writeEnabled && candidates.length > 0) {
    for (const chunkRows of chunk(candidates, INSERT_CHUNK)) {
      const rows = chunkRows.map((c) => ({ ...buildSkeletonRow(c, cp.payload.runId) }));
      const { data, error } = await db
        .from('anchor_proofs')
        // INSERT ... ON CONFLICT (anchor_id) DO NOTHING (anchor_proofs_anchor_unique).
        .upsert(rows, { onConflict: 'anchor_id', ignoreDuplicates: true })
        .select('anchor_id');
      if (error) {
        throw new Error(`materializer skeleton insert failed: ${error.message ?? 'unknown'}`);
      }
      const affected = data?.length ?? 0;
      cp.payload.inserted += affected;
      // Conflict-skips (a concurrent writer won the race) are counted, never
      // retried with different data — the existing row wins.
      cp.payload.conflictSkipped += rows.length - affected;
    }
  }

  // Cumulative accounting (both modes plan; only write inserts).
  cp.payload.rowsScanned += page.length;
  cp.payload.plannedToInsert += candidates.length;
  cp.payload.skippedExisting += tally.existing;
  cp.payload.skippedNotDirect.batch_provable += tally.batchProvable;
  cp.payload.skippedNotDirect.already_complete += tally.alreadyComplete;
  cp.payload.skippedNoTx += tally.noTx;
  cp.payload.haltedAmbiguous = 0; // this page is clean; clear any stale halt report
  cp.payload.ambiguousReasons = {};

  return { halted: false };
}

// ── The run ──────────────────────────────────────────────────────────────────

export async function runProofMaterializer(
  deps: MaterializerDeps,
  options: MaterializerOptions = {},
): Promise<MaterializerSummary> {
  const { logger } = deps;
  const confirmToken = deps.confirmToken ?? config.proofMaterializerConfirm ?? undefined;

  const guard = resolveMaterializerExecuteGuard(options.execute, confirmToken);
  const mode: 'dry-run' | 'write' = guard.permitted ? 'write' : 'dry-run';
  const executeRefusalReason = options.execute === true && !guard.permitted ? guard.reason : null;
  const scope = options.orgId ?? 'global';

  // Concurrency guard on the materializer's OWN key — refuse when the lock is
  // held (or the lock RPC errors: createDbLocker fails closed). Acquire BEFORE
  // any checkpoint/scan work; release in finally on EVERY path.
  const locker = deps.locker ?? NOOP_LOCKER;
  const lockId = computeMaterializerLockId(scope, mode);
  const acquired = await locker.acquire(lockId);
  if (!acquired) {
    logger.warn(
      { scope, mode, lockId },
      'proof-materializer: REFUSING — another invocation for this (scope,mode) holds the advisory lock; skipping to avoid checkpoint-cursor corruption',
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
    return await runUnderLock(deps, options, { mode, executeRefusalReason, scope });
  } finally {
    await locker.release(lockId);
  }
}

async function runUnderLock(
  deps: MaterializerDeps,
  options: MaterializerOptions,
  pre: { mode: 'dry-run' | 'write'; executeRefusalReason: string | null; scope: string },
): Promise<MaterializerSummary> {
  const { logger } = deps;
  const db = deps.client as unknown as UntypedDb;
  const { mode, executeRefusalReason, scope } = pre;
  const batchSize = clampBatchSize(options.batchSize);
  const maxBatches = clampMaxBatches(options.maxBatches);

  // GUC guard: every invocation is a start or a resume — check both.
  const gucState = await deps.guc.getProofEnforcementGuc();
  const gucRefusal = resolveGucGate(gucState, mode, scope, logger);
  if (gucRefusal) {
    return buildEmptyRefusal({
      mode,
      refusalReason: gucRefusal,
      executeRefusalReason,
      gucState,
      scope,
    });
  }

  logger.info(
    { scope, mode, batchSize, maxBatches, restart: options.restart === true, gucState },
    mode === 'dry-run'
      ? 'proof-materializer: DRY-RUN — planning skeleton inserts, writing NOTHING to anchor_proofs'
      : 'proof-materializer: WRITE mode — inserting honest 4-column skeletons (halt on any ambiguity)',
  );

  // Checkpoint: resume or create. runId is minted exactly once, here.
  let cp = options.restart === true ? null : await checkpointStore(db).load(scope, mode);
  let resumed = cp !== null;

  if (cp && cp.payload.completedAt !== null) {
    logger.info(
      { scope, mode, completedAt: cp.payload.completedAt, runId: cp.payload.runId },
      'proof-materializer: run already complete — returning the stored summary (pass restart=true for a fresh run)',
    );
    return summaryFromCheckpoint(cp, { mode, gucState, executeRefusalReason });
  }

  if (!cp) {
    const now = new Date().toISOString();
    cp = await checkpointStore(db).create({
      schemaVersion: 1,
      scope,
      mode,
      runId: randomUUID(), // the per-run rollback key — stable across resumes
      cursor: null,
      rowsScanned: 0,
      plannedToInsert: 0,
      inserted: 0,
      conflictSkipped: 0,
      skippedExisting: 0,
      skippedNotDirect: { batch_provable: 0, already_complete: 0 },
      skippedNoTx: 0,
      haltedAmbiguous: 0,
      ambiguousReasons: {},
      startedAt: now,
      updatedAt: now,
      completedAt: null,
    });
    resumed = false;
  }

  // Bounded scan/insert loop; checkpoint after every page.
  const cardinalityMemo = new Map<string, number | null>();
  const writeEnabled = mode === 'write';
  let batchesProcessed = 0;
  let halted = false;

  while (batchesProcessed < maxBatches) {
    const page = await sharedFetchScanPage(
      db,
      { orgId: options.orgId, cursor: cp.payload.cursor, batchSize },
      'materializer',
    );

    if (page.length === 0) {
      cp.payload.completedAt = new Date().toISOString();
      cp.payload.updatedAt = cp.payload.completedAt;
      await checkpointStore(db).save(cp);
      break;
    }

    const outcome = await processPage(db, page, cp, cardinalityMemo, writeEnabled, logger);
    if (outcome.halted) {
      halted = true;
      break; // cursor NOT advanced past the halting page
    }

    cp.payload.cursor = page.at(-1)?.id ?? cp.payload.cursor;
    cp.payload.updatedAt = new Date().toISOString();
    const isLastPage = page.length < batchSize;
    if (isLastPage) cp.payload.completedAt = cp.payload.updatedAt;
    await checkpointStore(db).save(cp);
    batchesProcessed += 1;

    logger.info(
      {
        scope,
        mode,
        batch: batchesProcessed,
        rowsScanned: cp.payload.rowsScanned,
        plannedToInsert: cp.payload.plannedToInsert,
        inserted: cp.payload.inserted,
        conflictSkipped: cp.payload.conflictSkipped,
        cursor: cp.payload.cursor,
        runId: cp.payload.runId,
      },
      'proof-materializer: page processed',
    );

    if (isLastPage) break;
  }

  const base = summaryFromCheckpoint(
    cp,
    { mode, gucState, executeRefusalReason },
    { resumed, batchesProcessed },
  );

  if (halted) {
    return { ...base, refused: true, refusalReason: 'ambiguous_rows_present' };
  }

  if (!base.runComplete) {
    logger.info(
      { scope, cursor: cp.payload.cursor, rowsScanned: cp.payload.rowsScanned },
      'proof-materializer: invocation budget reached — re-invoke to resume from the durable cursor (same runId)',
    );
    return base;
  }

  logger.warn(
    {
      scope,
      mode,
      runId: cp.payload.runId,
      rowsScanned: cp.payload.rowsScanned,
      plannedToInsert: cp.payload.plannedToInsert,
      inserted: cp.payload.inserted,
      conflictSkipped: cp.payload.conflictSkipped,
      skippedExisting: cp.payload.skippedExisting,
      skippedNotDirect: cp.payload.skippedNotDirect,
      skippedNoTx: cp.payload.skippedNoTx,
    },
    mode === 'write'
      ? 'proof-materializer: run COMPLETE — skeletons inserted (rollback key = runId; see header rollback contract)'
      : 'proof-materializer: DRY-RUN COMPLETE — plan emitted, zero anchor_proofs writes',
  );

  return base;
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
  INSERT_CHUNK,
};

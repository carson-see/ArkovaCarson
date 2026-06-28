/**
 * Back-catalogue proof-completeness backfill job (SCRUM-2335 PROOF-02 / SCRUM-2471).
 *
 * Populates migration 0340's proof-completeness columns on `anchor_proofs`
 * for the ~2.97M EXISTING SECURED anchors, so the GUC-gated
 * `arkova.proof_enforce_secured_complete` enforcement trigger (added inert by
 * 0340) can later be flipped ON without rejecting legitimate historical rows.
 *
 * 0340 columns this job targets:
 *   - block_hash            text   (confirmed block hash, 64-hex)
 *   - block_header          bytea  (80-byte raw block header)
 *   - op_return_payload     bytea  (raw OP_RETURN payload)
 *   - merkle_index          integer (leaf index in the original batch tree)
 *   - proof_schema_version  smallint (current schema version = 1)
 *
 * ── RECONSTRUCTABILITY (the crux — see DESIGN NOTE in the PR body) ──────────
 *   - block_hash / block_header : reconstructable VIA CHAIN FETCH, keyed on the
 *       already-stored `anchors.chain_tx_id`. A header source resolves tx → block
 *       hash → 80-byte header. (No real chain calls in this build; injected.)
 *   - op_return_payload         : reconstructable FROM STORED DATA for batch
 *       anchors — the historical on-chain payload is `ARKV` + merkle_root (the
 *       batch root IS what was submitted to the chain). NOTE: this is the
 *       HISTORICAL payload shape (no PROOF-01 version byte); 0340's comment
 *       describes the forward "ARKV+version+root" target, which differs.
 *   - merkle_index / proof branch : *** NOT RECONSTRUCTABLE *** for old batches.
 *       `batch-anchor.ts` historically DISCARDED `tree.proofs` (SCRUM-2471) and
 *       `submit_batch_anchors` never persisted leaf ordering. The leaf index was
 *       the in-memory claim order, which is gone. Without re-deriving the
 *       original ordered batch tree (data we do not have), merkle_index cannot
 *       be filled. Those rows are TALLIED as `unreconstructable` and SKIPPED for
 *       that column — never written with a guessed value.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────
 *   - DRY-RUN BY DEFAULT. Logs what it WOULD write; writes nothing.
 *   - HARD EXECUTE GUARD: writes occur only when BOTH `options.execute === true`
 *     AND the env confirmation `PROOF_BACKFILL_CONFIRM === 'EXECUTE'` are set.
 *     Either alone refuses (returns dryRun with a loud refusal reason).
 *   - IDEMPOTENT: only touches rows whose completeness columns are still NULL;
 *     re-running is safe and a no-op once a row is filled.
 *   - RESUMABLE: created_at cursor advances each batch; a mid-loop crash resumes
 *     from the last batch boundary on re-run.
 *
 * Gated behind: #1255 on main (the 0340 columns must exist in prod) + a staging
 * rehearsal. THIS PR BUILDS + TESTS ONLY — it is never executed here.
 *
 * Constitution refs: §1.4 (secrets never logged; service_role only),
 * §1.6/§1.6A (no document bytes — only fingerprints/chain data flow), §1.12 (T3).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { config } from '../config.js';

/**
 * Current proof-bundle schema version. Mirrors 0340's
 * `anchor_proofs.proof_schema_version` DEFAULT (1 = plain double-SHA256
 * app-tree). Kept as a named constant so a future tagged-hash format bumps it
 * in exactly one place.
 */
export const PROOF_SCHEMA_VERSION = 1 as const;

/** Default rows fetched per batch. Overridable (bounded) via options. */
export const DEFAULT_BATCH_SIZE = 1_000;
const MIN_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 5_000;

/** Env confirmation token that must equal this to permit writes. */
export const EXECUTE_CONFIRM_TOKEN = 'EXECUTE';
const EXECUTE_CONFIRM_ENV = 'PROOF_BACKFILL_CONFIRM';

/** Minimal logger surface (matches the worker `logger`). */
export interface BackfillLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
}

/**
 * Narrow, injectable chain-header source. Resolves an already-confirmed
 * transaction id to its block hash + raw 80-byte header.
 *
 * Deliberately NOT the full `ChainClient` — the base interface exposes no
 * block-header method, and the job must stay decoupled from any specific
 * provider (mempool.space / GetBlock). At execute time a real implementation
 * is wired in; in this build + all tests it is mocked. Returns null when the
 * tx/header cannot be resolved (the row is then skipped, not failed).
 */
export interface ChainHeaderSource {
  getBlockHeaderForTx(
    txId: string,
  ): Promise<{ blockHash: string; blockHeader: Buffer } | null>;
}

/** A back-catalogue anchor_proofs row joined to its anchor's chain data. */
export interface BackfillCandidateRow {
  anchor_id: string;
  /** anchors.chain_tx_id — the confirmed tx carrying the batch merkle root. */
  chain_tx_id: string | null;
  /** anchor_proofs.merkle_root — the batch root committed on-chain. */
  merkle_root: string | null;
  /** Existing 0340 columns; non-null means already backfilled (idempotency). */
  block_hash: string | null;
  block_header: string | Buffer | null;
  op_return_payload: string | Buffer | null;
  merkle_index: number | null;
  proof_schema_version: number | null;
  created_at: string;
}

/** What the job WOULD (dry-run) or DID (execute) write for one row. */
export interface PlannedUpdate {
  anchor_id: string;
  set: {
    block_hash?: string;
    block_header?: Buffer;
    op_return_payload?: Buffer;
    merkle_index?: number;
    proof_schema_version: number;
  };
  /** Columns that could NOT be reconstructed for this row (e.g. merkle_index). */
  unreconstructableColumns: string[];
}

export interface BackfillSummary {
  /** True when no writes were performed (default, or guard refused). */
  dryRun: boolean;
  /** Populated when the execute guard refused; explains why nothing was written. */
  refusalReason: string | null;
  batchesProcessed: number;
  rowsScanned: number;
  /** Rows for which at least one column was (or would be) written. */
  wouldUpdate: number;
  /** Rows already complete (skipped for idempotency). */
  skippedAlreadyComplete: number;
  /** Rows skipped because no chain_tx_id (cannot fetch header). */
  skippedNoTxId: number;
  /** Per-column tally of values that are NOT reconstructable from any source. */
  unreconstructable: {
    merkleIndex: number;
    blockHashOrHeader: number;
    opReturnPayload: number;
  };
  /**
   * Loud headline count: rows that can NEVER be made fully proof-complete by
   * this backfill alone (because merkle_index/branch is gone). This is the
   * number that decides whether the 0340 trigger can be enabled by backfill
   * alone, or whether the SCRUM-2471 forward-fix + re-anchor path is needed.
   */
  rowsBlockedOnScrum2471: number;
  finalCursor: string | null;
}

export interface RunBackfillOptions {
  /** Must be paired with the env confirmation token to permit any writes. */
  execute?: boolean;
  batchSize?: number;
  /** Resume cursor (exclusive lower bound on created_at). */
  startAfterCreatedAt?: string;
  /** Optional hard cap on batches (testing / staged rehearsal). */
  maxBatches?: number;
}

export interface RunBackfillDeps {
  client: SupabaseClient;
  chain: ChainHeaderSource;
  logger: BackfillLogger;
  /** Override for the env confirmation (testing). Defaults to process.env. */
  confirmToken?: string;
}

function clampBatchSize(requested: number | undefined): number {
  const n = requested ?? DEFAULT_BATCH_SIZE;
  if (!Number.isFinite(n)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(Math.floor(n), MIN_BATCH_SIZE), MAX_BATCH_SIZE);
}

/** A column is considered already-filled when its value is non-null. */
function isFilled(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * The historical on-chain OP_RETURN payload for a BATCH anchor is the batch
 * Merkle root prefixed with the 4-byte `ARKV` tag (the batch root is exactly
 * what `submitFingerprint` sent to the chain). This is the HISTORICAL shape and
 * intentionally carries no PROOF-01 version byte. Returns null when the root is
 * absent or not 32-byte hex (we never write a malformed payload).
 */
const OP_RETURN_TAG = Buffer.from('ARKV');
export function reconstructOpReturnPayload(merkleRoot: string | null): Buffer | null {
  if (!merkleRoot || !/^[0-9a-fA-F]{64}$/.test(merkleRoot)) return null;
  return Buffer.concat([OP_RETURN_TAG, Buffer.from(merkleRoot, 'hex')]);
}

/**
 * Decide, for a single candidate row, what (if anything) to write — without
 * performing any I/O beyond the injected chain header fetch. Pure-ish: the only
 * side effect is the awaited `chain.getBlockHeaderForTx`. Returns null when the
 * row is already complete (nothing to do).
 *
 * Reconstructability is applied here:
 *   - proof_schema_version : always set when missing (constant).
 *   - op_return_payload    : from stored merkle_root (ARKV+root).
 *   - block_hash/header    : via injected chain fetch on chain_tx_id.
 *   - merkle_index         : NEVER reconstructed — always tallied unreconstructable.
 */
export async function planRowUpdate(
  row: BackfillCandidateRow,
  chain: ChainHeaderSource,
): Promise<{ plan: PlannedUpdate | null; skippedNoTxId: boolean }> {
  const set: PlannedUpdate['set'] = { proof_schema_version: PROOF_SCHEMA_VERSION };
  const unreconstructableColumns: string[] = [];
  let touched = false;

  // proof_schema_version — set only if currently missing.
  if (!isFilled(row.proof_schema_version)) {
    touched = true; // set already carries the version
  } else {
    // already has a version; do not re-litigate it.
    delete (set as Partial<PlannedUpdate['set']>).proof_schema_version;
  }

  // op_return_payload — reconstruct from stored merkle_root (no chain call).
  if (!isFilled(row.op_return_payload)) {
    const payload = reconstructOpReturnPayload(row.merkle_root);
    if (payload) {
      set.op_return_payload = payload;
      touched = true;
    } else {
      unreconstructableColumns.push('op_return_payload');
    }
  }

  // block_hash / block_header — reconstruct via chain fetch on chain_tx_id.
  let skippedNoTxId = false;
  const needsBlock = !isFilled(row.block_hash) || !isFilled(row.block_header);
  if (needsBlock) {
    if (!row.chain_tx_id) {
      skippedNoTxId = true;
      unreconstructableColumns.push('block_hash', 'block_header');
    } else {
      const header = await chain.getBlockHeaderForTx(row.chain_tx_id);
      if (header) {
        if (!isFilled(row.block_hash)) {
          set.block_hash = header.blockHash;
          touched = true;
        }
        if (!isFilled(row.block_header)) {
          set.block_header = header.blockHeader;
          touched = true;
        }
      } else {
        unreconstructableColumns.push('block_hash', 'block_header');
      }
    }
  }

  // merkle_index — NEVER reconstructable for the back catalogue (SCRUM-2471:
  // tree.proofs discarded, leaf order not persisted). Tally + skip; never guess.
  if (!isFilled(row.merkle_index)) {
    unreconstructableColumns.push('merkle_index');
  }

  // ensure the version key is present when we are writing anything at all and
  // it was missing (covers the case where only op_return/block were set).
  if (touched && !isFilled(row.proof_schema_version)) {
    set.proof_schema_version = PROOF_SCHEMA_VERSION;
  }

  if (!touched && unreconstructableColumns.length === 0) {
    return { plan: null, skippedNoTxId };
  }

  return {
    plan: { anchor_id: row.anchor_id, set, unreconstructableColumns },
    skippedNoTxId,
  };
}

/**
 * Apply a batch of planned updates to `anchor_proofs`. Each row is updated by
 * `anchor_id` and is guarded so a concurrent fill never clobbers — we only
 * write columns we computed. Uses an untyped cast because the 0340 columns are
 * not yet in the regenerated `database.types.ts` (head 0339 in this build);
 * same escape-hatch pattern as `utils/anchorProofs.ts`.
 */
async function applyUpdates(
  client: SupabaseClient,
  plans: PlannedUpdate[],
  logger: BackfillLogger,
): Promise<number> {
  const dbAny = client as unknown as {
    from(table: string): {
      update(
        values: Record<string, unknown>,
      ): {
        eq(col: string, val: string): Promise<{ error: { message?: string } | null }>;
      };
    };
  };

  let written = 0;
  for (const plan of plans) {
    const values: Record<string, unknown> = {};
    if (plan.set.block_hash !== undefined) values.block_hash = plan.set.block_hash;
    if (plan.set.block_header !== undefined) values.block_header = plan.set.block_header;
    if (plan.set.op_return_payload !== undefined) {
      values.op_return_payload = plan.set.op_return_payload;
    }
    if (plan.set.merkle_index !== undefined) values.merkle_index = plan.set.merkle_index;
    if (plan.set.proof_schema_version !== undefined) {
      values.proof_schema_version = plan.set.proof_schema_version;
    }
    if (Object.keys(values).length === 0) continue;

    const { error } = await dbAny.from('anchor_proofs').update(values).eq('anchor_id', plan.anchor_id);
    if (error) {
      // Never abort the loop — one bad row must not starve the rest (job convention).
      logger.error(
        { anchorId: plan.anchor_id, error: error.message },
        'proof-backfill: row update failed — continuing',
      );
      continue;
    }
    written += 1;
  }
  return written;
}

/**
 * Resolve whether writes are permitted. Requires BOTH the explicit
 * `options.execute` flag AND the env confirmation token. Returns the reason
 * string when refused (null when permitted).
 */
export function resolveExecuteGuard(
  execute: boolean | undefined,
  confirmToken: string | undefined,
): { permitted: boolean; reason: string | null } {
  if (execute !== true) {
    return {
      permitted: false,
      reason: `DRY-RUN: execute flag not set (pass options.execute=true AND ${EXECUTE_CONFIRM_ENV}=${EXECUTE_CONFIRM_TOKEN})`,
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

/**
 * Run the back-catalogue proof-completeness backfill.
 *
 * Default (no execute flag / no env token): DRY-RUN — computes the full plan,
 * logs counts, writes NOTHING. With both guards satisfied: applies the planned
 * column writes batch-by-batch, advancing a resumable created_at cursor.
 */
export async function runProofCompletenessBackfill(
  deps: RunBackfillDeps,
  options: RunBackfillOptions = {},
): Promise<BackfillSummary> {
  const { client, chain, logger } = deps;
  // SCRUM-1258: the env confirm token is read via typed config
  // (`config.proofBackfillConfirm` ← PROOF_BACKFILL_CONFIRM), not an ad-hoc
  // dynamic env read keyed by variable. `deps.confirmToken` still wins for tests.
  const confirmToken =
    deps.confirmToken ?? config.proofBackfillConfirm ?? undefined;
  const guard = resolveExecuteGuard(options.execute, confirmToken);
  const dryRun = !guard.permitted;
  const batchSize = clampBatchSize(options.batchSize);

  const summary: BackfillSummary = {
    dryRun,
    refusalReason: options.execute === true ? guard.reason : null,
    batchesProcessed: 0,
    rowsScanned: 0,
    wouldUpdate: 0,
    skippedAlreadyComplete: 0,
    skippedNoTxId: 0,
    unreconstructable: { merkleIndex: 0, blockHashOrHeader: 0, opReturnPayload: 0 },
    rowsBlockedOnScrum2471: 0,
    finalCursor: null,
  };

  logger.warn(
    {
      dryRun,
      batchSize,
      executeRequested: options.execute === true,
      guardReason: guard.reason,
    },
    dryRun
      ? 'proof-backfill: DRY-RUN — computing plan, writing NOTHING'
      : 'proof-backfill: EXECUTE mode — guards satisfied, writes ENABLED',
  );

  // Untyped reader: 0340 columns not in head-0339 types (see applyUpdates note).
  const dbAny = client as unknown as {
    from(table: string): {
      select(cols: string): {
        gt(col: string, val: string): {
          order(
            col: string,
            opts: { ascending: boolean },
          ): {
            limit(
              n: number,
            ): Promise<{ data: BackfillCandidateRow[] | null; error: { message?: string } | null }>;
          };
        };
      };
    };
  };

  const SELECT_COLS =
    'anchor_id, chain_tx_id, merkle_root, block_hash, block_header, op_return_payload, merkle_index, proof_schema_version, created_at';

  let cursor = options.startAfterCreatedAt ?? '1970-01-01T00:00:00.000Z';

  for (;;) {
    if (options.maxBatches !== undefined && summary.batchesProcessed >= options.maxBatches) {
      logger.info({ maxBatches: options.maxBatches }, 'proof-backfill: maxBatches reached — stopping');
      break;
    }

    const { data, error } = await dbAny
      .from('anchor_proofs')
      .select(SELECT_COLS)
      .gt('created_at', cursor)
      .order('created_at', { ascending: true })
      .limit(batchSize);

    if (error) {
      logger.error({ cursor, error: error.message }, 'proof-backfill: source query failed — stopping');
      throw new Error(`proof-backfill source query failed at cursor=${cursor}: ${error.message ?? 'unknown'}`);
    }

    const rows = data ?? [];
    if (rows.length === 0) break;

    const plans: PlannedUpdate[] = [];
    for (const row of rows) {
      summary.rowsScanned += 1;

      const fullyComplete =
        isFilled(row.block_hash) &&
        isFilled(row.block_header) &&
        isFilled(row.op_return_payload) &&
        isFilled(row.merkle_index) &&
        isFilled(row.proof_schema_version);
      if (fullyComplete) {
        summary.skippedAlreadyComplete += 1;
        continue;
      }

      const { plan, skippedNoTxId } = await planRowUpdate(row, chain);
      if (skippedNoTxId) summary.skippedNoTxId += 1;
      if (!plan) {
        // Nothing writable and nothing unreconstructable — treat as complete.
        summary.skippedAlreadyComplete += 1;
        continue;
      }

      // Tally unreconstructable columns.
      const u = plan.unreconstructableColumns;
      if (u.includes('merkle_index')) summary.unreconstructable.merkleIndex += 1;
      if (u.includes('block_hash') || u.includes('block_header')) {
        summary.unreconstructable.blockHashOrHeader += 1;
      }
      if (u.includes('op_return_payload')) summary.unreconstructable.opReturnPayload += 1;
      // merkle_index gone ⇒ this row can never be fully proof-complete via backfill.
      if (u.includes('merkle_index')) summary.rowsBlockedOnScrum2471 += 1;

      const writesSomething = Object.keys(plan.set).length > 0;
      if (writesSomething) {
        summary.wouldUpdate += 1;
        plans.push(plan);
      }
    }

    if (!dryRun && plans.length > 0) {
      const written = await applyUpdates(client, plans, logger);
      logger.info(
        { batch: summary.batchesProcessed, planned: plans.length, written },
        'proof-backfill: batch applied',
      );
    }

    summary.batchesProcessed += 1;
    cursor = rows[rows.length - 1].created_at;
    summary.finalCursor = cursor;

    logger.info(
      {
        batch: summary.batchesProcessed,
        rowsScanned: summary.rowsScanned,
        wouldUpdate: summary.wouldUpdate,
        unreconstructableMerkleIndex: summary.unreconstructable.merkleIndex,
        cursor,
        dryRun,
      },
      'proof-backfill: batch progress',
    );

    if (rows.length < batchSize) break; // source exhausted
  }

  // Loud headline — this is the number that gates 0340 trigger-enable.
  logger.warn(
    {
      dryRun,
      rowsScanned: summary.rowsScanned,
      wouldUpdate: summary.wouldUpdate,
      skippedAlreadyComplete: summary.skippedAlreadyComplete,
      skippedNoTxId: summary.skippedNoTxId,
      unreconstructable: summary.unreconstructable,
      rowsBlockedOnScrum2471: summary.rowsBlockedOnScrum2471,
    },
    summary.rowsBlockedOnScrum2471 > 0
      ? 'proof-backfill: COMPLETE — ⚠ rows BLOCKED on SCRUM-2471 (merkle_index unreconstructable); 0340 trigger CANNOT be enabled by backfill alone'
      : 'proof-backfill: COMPLETE — every scanned row is fully reconstructable',
  );

  return summary;
}

export const __testing = {
  clampBatchSize,
  isFilled,
  DEFAULT_BATCH_SIZE,
  MIN_BATCH_SIZE,
  MAX_BATCH_SIZE,
};

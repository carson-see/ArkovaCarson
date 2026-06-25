/**
 * Resumable proof-branch backfill — FIX-1 (SCRUM-2471).
 *
 * Backfills Merkle branches for EXISTING SECURED customer anchors whose
 * `anchor_proofs` row has a `merkle_root` but no `proof_path` (the rows that
 * pre-date FIX-1, when the customer batch path discarded `tree.proofs`). New
 * anchors get branches inline; this job repairs the back catalogue so
 * PROOF-VERIFY (SCRUM-2490) can produce a cryptographic verdict for them and
 * the PROOF-02 "SECURED ⇒ proof complete" trigger can eventually be enabled.
 *
 * ## Self-validating (never writes a wrong branch)
 *
 * A branch can only be rebuilt from ALL leaves of the same batch tree, in the
 * SAME order the tree was originally built. That order is not perfectly
 * recoverable from the DB for legacy rows, so the job reconstructs the tree
 * from the batch's fingerprints ordered `created_at, id`, recomputes the
 * root, and persists the branches ONLY IF the recomputed root EQUALS the
 * stored `merkle_root`. A batch whose ordering cannot be recovered (root
 * mismatch) is SKIPPED and counted as unrecoverable — it is never written
 * with an incorrect branch. (Unrecoverable batches need re-anchoring or a
 * manual order source; they are reported for follow-up.)
 *
 * ## Resumable
 *
 * The data is the durable watermark: once a batch's branches are persisted,
 * its anchors stop matching the "incomplete" query, so re-running resumes
 * automatically. `startAfterCreatedAt` + `batchLimit` additionally allow
 * chunked manual runs; `lastCursor` is returned so the next chunk can resume.
 *
 * ## NOT a cron / NOT for prod (in this change)
 *
 * Intentionally NOT wired into any scheduler. It is a manual-trigger job. Per
 * the FIX-1 brief it must NOT be run against production in this change — run
 * it on staging/local against a clean mirror first. (CLAUDE.md §1.11 — a
 * prod-bound data backfill is a T3 surface and needs its own soak + operator
 * sign-off before any prod execution.)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';
import { buildMerkleTree } from '../utils/merkle.js';
import { verifyMerkleInclusion } from '../utils/merkle-verify.js';
import { upsertAnchorProofs } from '../utils/anchorProofs.js';

/** A batch that still needs branches. */
export interface IncompleteBatch {
  batch_id: string;
  /** created_at of the earliest anchor in the batch (the cursor boundary). */
  created_at: string;
  merkle_root: string;
}

/** A leaf row for tree reconstruction. */
export interface BatchAnchorRow {
  id: string;
  fingerprint: string;
  merkle_root: string;
}

/** Injectable data access so the job is unit-testable without a live DB. */
export interface ProofBackfillClient {
  listIncompleteBatches(opts: {
    startAfterCreatedAt?: string;
    limit: number;
  }): Promise<IncompleteBatch[]>;
  listBatchAnchors(batchId: string): Promise<BatchAnchorRow[]>;
}

export interface ProofBackfillOptions {
  client?: ProofBackfillClient;
  /** Max batches to process this invocation (chunked manual runs). */
  batchLimit?: number;
  /** Resume cursor — only batches with created_at > this are processed. */
  startAfterCreatedAt?: string;
}

export interface ProofBackfillResult {
  batchesProcessed: number;
  batchesRecovered: number;
  batchesUnrecoverable: number;
  anchorsBackfilled: number;
  /** created_at of the last batch processed — pass as startAfterCreatedAt to resume. */
  lastCursor: string | null;
}

const DEFAULT_BATCH_LIMIT = 50;

/**
 * Real Supabase-backed client. SECURED + customer-owned (org_id NOT NULL)
 * anchors whose anchor_proofs row has merkle_root but a NULL/empty proof_path.
 * Pipeline/public-record anchors already carry branches, so they don't match.
 */
export function createDbProofBackfillClient(db: SupabaseClient): ProofBackfillClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dbAny = db as any;
  return {
    async listIncompleteBatches({ startAfterCreatedAt, limit }) {
      // anchor_proofs rows missing a branch, joined to SECURED customer anchors.
      let q = dbAny
        .from('anchor_proofs')
        .select('batch_id, merkle_root, anchors!inner(created_at, org_id, status)')
        .is('proof_path', null)
        .not('merkle_root', 'is', null)
        .not('batch_id', 'is', null)
        .eq('anchors.status', 'SECURED')
        .not('anchors.org_id', 'is', null)
        .order('anchors(created_at)', { ascending: true })
        .limit(limit * 200); // over-fetch rows; we de-dupe to distinct batches below
      if (startAfterCreatedAt) q = q.gt('anchors.created_at', startAfterCreatedAt);

      const { data, error } = await q;
      if (error) throw error;

      const seen = new Map<string, IncompleteBatch>();
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const batchId = row.batch_id as string;
        const anchor = row.anchors as { created_at: string } | null;
        if (!batchId || !anchor) continue;
        if (!seen.has(batchId)) {
          seen.set(batchId, {
            batch_id: batchId,
            created_at: anchor.created_at,
            merkle_root: row.merkle_root as string,
          });
        }
        if (seen.size >= limit) break;
      }
      return Array.from(seen.values()).sort((a, b) => a.created_at.localeCompare(b.created_at));
    },

    async listBatchAnchors(batchId) {
      const { data, error } = await dbAny
        .from('anchor_proofs')
        .select('merkle_root, anchors!inner(id, fingerprint, created_at)')
        .eq('batch_id', batchId)
        .order('anchors(created_at)', { ascending: true });
      if (error) throw error;
      return ((data ?? []) as Array<Record<string, unknown>>)
        .map((row) => {
          const a = row.anchors as { id: string; fingerprint: string } | null;
          return a ? { id: a.id, fingerprint: a.fingerprint, merkle_root: row.merkle_root as string } : null;
        })
        .filter((r): r is BatchAnchorRow => r !== null)
        .sort((x, y) => x.id.localeCompare(y.id));
    },
  };
}

/**
 * Run the backfill. Returns counters + the resume cursor.
 *
 * @throws never for individual-batch failures (they are logged + counted);
 *         only a hard query failure propagates.
 */
export async function runProofBranchBackfill(
  opts: ProofBackfillOptions = {},
): Promise<ProofBackfillResult> {
  const client = opts.client ?? (await defaultClient());
  const batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT;

  const batches = await client.listIncompleteBatches({
    startAfterCreatedAt: opts.startAfterCreatedAt,
    limit: batchLimit,
  });

  const result: ProofBackfillResult = {
    batchesProcessed: 0,
    batchesRecovered: 0,
    batchesUnrecoverable: 0,
    anchorsBackfilled: 0,
    lastCursor: null,
  };

  for (const batch of batches) {
    result.batchesProcessed += 1;
    result.lastCursor = batch.created_at;

    let rows: BatchAnchorRow[];
    try {
      rows = await client.listBatchAnchors(batch.batch_id);
    } catch (err) {
      logger.error({ error: err, batchId: batch.batch_id }, 'proof-branch-backfill: failed to load batch anchors — skipping');
      result.batchesUnrecoverable += 1;
      continue;
    }

    if (rows.length === 0) {
      result.batchesUnrecoverable += 1;
      continue;
    }

    // Reconstruct the tree from the deterministic (created_at,id) ordering.
    const fingerprints = rows.map((r) => r.fingerprint);
    const tree = buildMerkleTree(fingerprints);

    // SELF-VALIDATION: only persist if the recomputed root matches the
    // stored root. Otherwise the ordering is unknown — never write a guess.
    if (tree.root !== batch.merkle_root) {
      logger.warn(
        { batchId: batch.batch_id, storedRoot: batch.merkle_root, recomputedRoot: tree.root, leaves: rows.length },
        'proof-branch-backfill: reconstructed root != stored root — batch ordering unrecoverable, skipping (needs re-anchor or manual order)',
      );
      result.batchesUnrecoverable += 1;
      continue;
    }

    const proofRows = rows.map((row, index) => ({
      anchorId: row.id,
      // No new chain receipt — the proof row already exists; we only fill the
      // branch + index. receiptId is required by the upsert helper, so reuse
      // the batch_id-derived marker; the on-conflict(anchor_id) upsert merges.
      receiptId: batch.batch_id,
      merkleRoot: tree.root,
      proofPath: tree.proofs.get(row.fingerprint) ?? [],
      merkleIndex: index,
      batchId: batch.batch_id,
    }));

    // Defensive: confirm every reconstructed branch verifies before writing.
    const allValid = proofRows.every((pr, i) =>
      verifyMerkleInclusion(
        rows[i].fingerprint,
        pr.proofPath as { hash: string; position: 'left' | 'right' }[],
        tree.root,
        { leafIndex: pr.merkleIndex },
      ).valid,
    );
    if (!allValid) {
      logger.error({ batchId: batch.batch_id }, 'proof-branch-backfill: reconstructed branch failed self-verification — skipping');
      result.batchesUnrecoverable += 1;
      continue;
    }

    try {
      await upsertAnchorProofs(asSupabase(client), proofRows);
    } catch (err) {
      logger.error({ error: err, batchId: batch.batch_id }, 'proof-branch-backfill: upsert failed — batch left incomplete, will retry next run');
      result.batchesUnrecoverable += 1;
      continue;
    }

    result.batchesRecovered += 1;
    result.anchorsBackfilled += proofRows.length;
    logger.info(
      { batchId: batch.batch_id, anchors: proofRows.length, root: tree.root },
      'proof-branch-backfill: batch recovered',
    );
  }

  logger.info(
    {
      batchesProcessed: result.batchesProcessed,
      batchesRecovered: result.batchesRecovered,
      batchesUnrecoverable: result.batchesUnrecoverable,
      anchorsBackfilled: result.anchorsBackfilled,
      lastCursor: result.lastCursor,
    },
    'proof-branch-backfill: run complete',
  );
  return result;
}

// upsertAnchorProofs needs a SupabaseClient; in production the injected
// client wraps `db`, so we re-import it lazily for the default path.
let _db: SupabaseClient | null = null;
async function defaultClient(): Promise<ProofBackfillClient> {
  const { db } = await import('../utils/db.js');
  _db = db as unknown as SupabaseClient;
  return createDbProofBackfillClient(_db);
}

/**
 * The upsert helper writes via `client.from('anchor_proofs')`. The test
 * injects a ProofBackfillClient that has no `.from`, but mocks
 * upsertAnchorProofs, so the argument is never dereferenced in tests. In
 * production we pass the real `db` captured by defaultClient(). Guard so a
 * caller-injected client without a backing db still has something to pass.
 */
function asSupabase(client: ProofBackfillClient): SupabaseClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (_db ?? (client as any)) as SupabaseClient;
}

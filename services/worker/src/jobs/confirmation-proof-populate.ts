/**
 * Confirmation-proof population (PROOF-03 / SCRUM-2336).
 *
 * After an anchor's tx is SECURED, fetch the block header + Merkle inclusion
 * path (via the GetBlock RPC client) and persist them onto the existing
 * `anchor_proofs` row (`block_header` + `block_hash`, the PROOF-02/0340
 * bitcoin-tree columns). The app-tree branch (`merkle_root` / `proof_path` /
 * `merkle_index`) was already written by FIX-1 at broadcast time — this only
 * adds the layer-2 confirmation evidence and never touches the app-tree.
 *
 * FAN-OUT (per the brief): anchors in a Merkle batch share ONE tx, so the
 * expensive RPC work (getblockheader + gettxoutproof) is done ONCE per unique
 * `chain_tx_id`, then the resulting proof is written to every anchor of that
 * tx. A run that touches 10k anchors across, say, 3 merkle txs makes 3 proof
 * fetches — never 10k. Unique-tx fetches run through `runWithConcurrency` with
 * a small cap so we don't blast the RPC node.
 *
 * Constitution refs:
 *   - §1.4 No secrets logged; only the txid/blockhash (already public) appear.
 *   - §1.7 Provider is injected so tests use a mock — NO real Bitcoin API.
 *   - §1.9 Real fetch is gated by ENABLE_PROD_NETWORK_ANCHORING in the wiring.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import {
  fetchConfirmationProof,
  type ConfirmationProof,
} from '../chain/confirmation-proof.js';
import type { ConfirmationProofProvider } from '../chain/utxo-provider.js';
import {
  updateAnchorConfirmationProofs,
  type AnchorConfirmationUpdateRow,
} from '../utils/anchorProofs.js';

/** Concurrency for parallel inclusion-proof RPC fetches (per unique tx). */
const DEFAULT_PROOF_FETCH_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.CONFIRMATION_PROOF_FETCH_CONCURRENCY ?? '8', 10) || 8,
);

/** One anchor awaiting a confirmation proof. */
export interface ConfirmationProofCandidate {
  anchorId: string;
  chainTxId: string;
  blockHeight?: number | null;
  /** Previously-recorded block hash (for reorg detection), if known. */
  expectedBlockHash?: string | null;
}

export interface PopulateConfirmationProofsOptions {
  /** Min confirmations before fetching a full proof (default 1; mainnet caller passes 6). */
  minConfirmations?: number;
  /** Concurrency for unique-tx RPC fetches. */
  concurrency?: number;
}

export interface PopulateConfirmationProofsResult {
  /** Unique transactions a proof fetch was attempted for. */
  txAttempted: number;
  /** Transactions whose proof came back `confirmed`. */
  txConfirmed: number;
  /** Transactions whose proof was `pending` (not yet confirmed / no capable provider). */
  txPending: number;
  /** Transactions whose proof was `stale` (reorg / missing / malformed). */
  txStale: number;
  /** Anchor rows whose `block_header`/`block_hash` were written. */
  anchorsUpdated: number;
  /** Anchor rows that had no `anchor_proofs` row to update (skipped, not created). */
  anchorsMissing: number;
}

/**
 * Group candidates by `chain_tx_id`, fetch one confirmation proof per unique
 * tx, and persist the `confirmed` ones to every anchor of that tx.
 *
 * `pending` proofs are left for a future tick (the anchor_proofs row keeps
 * `block_header = NULL`); `stale` proofs are logged and NOT written (we never
 * persist a branch under a block that no longer contains the tx).
 *
 * The function NEVER throws on a per-tx fetch failure — failures are counted
 * and the run continues (the proof is recoverable on the next tick). It only
 * propagates a hard DB write error from the persistence helper.
 */
export async function populateConfirmationProofs(
  client: SupabaseClient,
  provider: ConfirmationProofProvider,
  candidates: ConfirmationProofCandidate[],
  options: PopulateConfirmationProofsOptions = {},
): Promise<PopulateConfirmationProofsResult> {
  const result: PopulateConfirmationProofsResult = {
    txAttempted: 0,
    txConfirmed: 0,
    txPending: 0,
    txStale: 0,
    anchorsUpdated: 0,
    anchorsMissing: 0,
  };
  if (candidates.length === 0) return result;

  const minConfirmations = options.minConfirmations ?? 1;
  const concurrency = options.concurrency ?? DEFAULT_PROOF_FETCH_CONCURRENCY;

  // ── Group anchors by their shared tx (merkle batch ⇒ one tx, many anchors) ──
  const byTx = new Map<string, ConfirmationProofCandidate[]>();
  for (const c of candidates) {
    if (!c.chainTxId) continue;
    const list = byTx.get(c.chainTxId);
    if (list) list.push(c);
    else byTx.set(c.chainTxId, [c]);
  }

  const uniqueTxIds = [...byTx.keys()];
  result.txAttempted = uniqueTxIds.length;

  // ── One proof fetch per unique tx, capped concurrency ──
  const fetchTasks = uniqueTxIds.map((txId) => async (): Promise<{ txId: string; proof: ConfirmationProof }> => {
    const group = byTx.get(txId)!;
    // Use the first candidate's recorded block hash/height as the reorg anchor;
    // all anchors in a tx share the same block.
    const expectedBlockHash = group.find((g) => g.expectedBlockHash)?.expectedBlockHash ?? null;
    const blockHeight = group.find((g) => g.blockHeight != null)?.blockHeight ?? null;
    const proof = await fetchConfirmationProof(provider, {
      chainTxId: txId,
      blockHeight,
      expectedBlockHash,
      minConfirmations,
    });
    return { txId, proof };
  });

  const fetchOutcome = await runWithConcurrency(fetchTasks, concurrency);

  // ── Build the per-anchor update set from confirmed proofs ──
  const updates: AnchorConfirmationUpdateRow[] = [];
  for (const { txId, proof } of fetchOutcome.fulfilled) {
    if (proof.status === 'confirmed' && proof.blockHeader && proof.blockHash) {
      result.txConfirmed += 1;
      const group = byTx.get(txId)!;
      for (const anchor of group) {
        updates.push({
          anchorId: anchor.anchorId,
          blockHeader: proof.blockHeader,
          blockHash: proof.blockHash,
          blockHeight: anchor.blockHeight ?? null,
        });
      }
    } else if (proof.status === 'pending') {
      result.txPending += 1;
      logger.debug({ txId, reason: proof.reason }, 'confirmation-proof: tx pending — will retry next tick');
    } else {
      result.txStale += 1;
      logger.warn({ txId, reason: proof.reason }, 'confirmation-proof: tx stale (reorg/missing) — NOT persisting a branch');
    }
  }

  // Fetch rejections (provider threw despite fetchConfirmationProof's guards —
  // should be rare) count as pending so they retry.
  if (fetchOutcome.rejected.length > 0) {
    result.txPending += fetchOutcome.rejected.length;
    for (const r of fetchOutcome.rejected) {
      logger.warn({ index: r.index, reason: errMsg(r.reason) }, 'confirmation-proof: unique-tx fetch rejected — retry next tick');
    }
  }

  // ── Persist (non-destructive UPDATE of bitcoin-tree columns only) ──
  if (updates.length > 0) {
    const persistResult = await updateAnchorConfirmationProofs(client, updates);
    result.anchorsUpdated = persistResult.updated;
    result.anchorsMissing = persistResult.missing;
    if (persistResult.missing > 0) {
      logger.warn(
        { missing: persistResult.missing, updated: persistResult.updated },
        'confirmation-proof: some anchors had no anchor_proofs row to update (app-tree branch never written?) — skipped, not created header-only',
      );
    }
  }

  logger.info(
    {
      txAttempted: result.txAttempted,
      txConfirmed: result.txConfirmed,
      txPending: result.txPending,
      txStale: result.txStale,
      anchorsUpdated: result.anchorsUpdated,
      anchorsMissing: result.anchorsMissing,
    },
    'confirmation-proof population complete',
  );

  return result;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── Production scan + wiring ───────────────────────────────────────────────

/** Max anchor rows to populate per cron run (bounds RPC + DB work). */
const MAX_CONFIRMATION_PROOF_ROWS_PER_RUN = Math.max(
  1,
  Number.parseInt(process.env.CONFIRMATION_PROOF_MAX_ROWS_PER_RUN ?? '2000', 10) || 2000,
);

/** Shape of an `anchor_proofs` row joined to its `anchors` parent for the scan. */
interface ProofScanRow {
  anchor_id: string;
  receipt_id: string | null;
  block_height: number | null;
  anchors: {
    chain_tx_id: string | null;
    chain_block_height: number | null;
    status: string | null;
  } | null;
}

/**
 * Find SECURED anchors whose app-tree proof is complete (`merkle_root`
 * present) but whose bitcoin-tree confirmation evidence is missing
 * (`block_header IS NULL`), and populate it.
 *
 * This is the cron entrypoint. It is deliberately SEPARATE from the hot
 * `check-confirmations.ts` bulk-drain path: that path is latency-critical
 * (10k-row drains under a 60s statement timeout) and already re-soaked; adding
 * a header fetch inline would re-open it. Instead this runs as its own bounded
 * pass — a SECURED anchor gets its app-tree branch at broadcast (FIX-1), then
 * this fills the header/branch shortly after on the next pass. The `anchor_proofs`
 * data itself is the watermark (a populated `block_header` stops matching the
 * scan), so it is naturally resumable + idempotent.
 *
 * Gated by the chain client: in mock/non-prod mode the injected provider is the
 * mock, so this is a no-op-ish pass (mock getRawTransaction returns no block).
 *
 * @param provider injected for tests; production callers pass the GetBlock-backed provider.
 */
export async function populateConfirmationProofsForSecuredAnchors(
  client: SupabaseClient,
  provider: ConfirmationProofProvider,
  options: PopulateConfirmationProofsOptions & { maxRows?: number } = {},
): Promise<PopulateConfirmationProofsResult & { scanned: number }> {
  const maxRows = options.maxRows ?? MAX_CONFIRMATION_PROOF_ROWS_PER_RUN;

  // Scan anchor_proofs for app-tree-complete-but-confirmation-missing rows,
  // joined to anchors to confirm SECURED + recover the recorded block hash.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested select shape pending types regen
  const { data, error } = await (client as any)
    .from('anchor_proofs')
    .select('anchor_id, receipt_id, block_height, anchors!inner(chain_tx_id, chain_block_height, status)')
    .not('merkle_root', 'is', null)
    .is('block_header', null)
    .eq('anchors.status', 'SECURED')
    .not('anchors.chain_tx_id', 'is', null)
    .limit(maxRows);

  if (error) {
    // LOW-2: log the message string, not the raw error object — keeps the log
    // shape consistent and avoids any future coupling of provider/rpcUrl/token
    // fields that might ride along on a richer error object.
    logger.error({ err: errMsg(error) }, 'confirmation-proof scan failed');
    return {
      scanned: 0,
      txAttempted: 0,
      txConfirmed: 0,
      txPending: 0,
      txStale: 0,
      anchorsUpdated: 0,
      anchorsMissing: 0,
    };
  }

  const rows = (data ?? []) as ProofScanRow[];
  const candidates: ConfirmationProofCandidate[] = rows
    .map((row): ConfirmationProofCandidate | null => {
      const txId = row.anchors?.chain_tx_id;
      if (!txId) return null;
      return {
        anchorId: row.anchor_id,
        chainTxId: txId,
        blockHeight: row.block_height ?? row.anchors?.chain_block_height ?? null,
        // No expectedBlockHash recorded on anchor_proofs yet (this run is what
        // populates it). Reorg detection on a FIRST population is handled by
        // gettxoutproof being pinned to the tx's CURRENT block: if the proof
        // doesn't contain the tx, fetchConfirmationProof returns stale.
        expectedBlockHash: null,
      };
    })
    .filter((c): c is ConfirmationProofCandidate => c !== null);

  const populateResult = await populateConfirmationProofs(client, provider, candidates, options);
  return { scanned: rows.length, ...populateResult };
}

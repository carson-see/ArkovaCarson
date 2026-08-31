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
  blockHashFromHeaderHex,
  fetchConfirmationProof,
  type ConfirmationProof,
} from '../chain/confirmation-proof.js';
import { fromByteaHex } from '../utils/anchorProofs.js';
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
  /**
   * H2: the raw 80-byte header (160-hex) already stored on the proof row, if
   * any. A header IDENTIFIES its own block, so when `expectedBlockHash` is null
   * — a schema-permitted state, and the one that used to disarm both reorg
   * gates — this still tells us which block the row describes.
   */
  expectedBlockHeader?: string | null;
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
  /**
   * K1: anchors dropped from the write set because the block hash ALREADY
   * recorded on their proof row is not the block the tx was just found in.
   * Counted rather than silently skipped — a non-zero value here is a reorg (or
   * a corrupted row) and must be visible in the cron result, not inferred from
   * a gap between `txConfirmed` and `anchorsUpdated`.
   */
  anchorsBlockMismatch: number;
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
    anchorsBlockMismatch: 0,
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
    // B1: the group-level reorg guard arms ONLY on UNANIMOUS agreement.
    //
    // This used to be `group.find((g) => g.expectedBlockHash)` — the FIRST
    // non-null recorded hash in the group, decided by heap order. That made one
    // row's recorded block binding on every other anchor sharing the tx (up to
    // 10,000 in a merkle batch): if that row was stale, `fetchConfirmationProof`
    // returned `stale`, the `confirmed` branch never ran, and NOTHING was
    // written for the whole group — on every tick, forever, with
    // `anchorsBlockMismatch` stuck at 0 because the per-anchor guard below was
    // never reached. A row that has no recorded hash yet (the common case on a
    // first population) was starved by a neighbour's stale one.
    //
    // The group-level guard is an OPTIMISATION — it saves an inclusion-proof
    // fetch when the whole group has demonstrably moved. The per-anchor K1 gate
    // in the write-set build is the SAFETY property, and it is strictly
    // stronger: it re-checks every row against the block the proof actually came
    // from. So arm the cheap guard only when the group speaks with one voice,
    // and otherwise hand the decision to the per-anchor gate, which resolves it
    // row by row instead of collectively.
    const expectedBlockHash = unanimousBlockHash(group);
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
    // H4: the precondition must name EVERY value this write is supposed to
    // persist. It used to check only the header + hash, while `merkleBranch`
    // and `txIndex` are independently optional on `ConfirmationProof` — so a
    // conforming producer could return `confirmed` with no inclusion evidence
    // and we would write a header-only row that the scan then re-selects
    // forever (its `tx_inclusion_branch` is still null) without ever being able
    // to complete it. Today's `fetchConfirmationProof` always carries all four
    // together; this makes that a checked precondition rather than a habit.
    const hasInclusionEvidence = proof.merkleBranch !== undefined && proof.txIndex !== undefined;
    if (proof.status === 'confirmed' && proof.blockHeader && proof.blockHash && !hasInclusionEvidence) {
      // Not stale (nothing has moved) and not a normal pending — the provider
      // answered `confirmed` without the evidence the column exists to hold.
      // Counted as pending so the row stays in the scan and retries, but logged
      // loudly because a silent retry loop is how this would hide.
      result.txPending += 1;
      logger.warn(
        { txId },
        'confirmation-proof: proof came back confirmed WITHOUT an inclusion branch/index — refusing a header-only write that could never complete',
      );
      continue;
    }
    if (proof.status === 'confirmed' && proof.blockHeader && proof.blockHash) {
      result.txConfirmed += 1;
      const group = byTx.get(txId)!;
      for (const anchor of group) {
        // ── K1: SECOND reorg gate, at the write set ──
        // `fetchConfirmationProof` already refuses to return `confirmed` when
        // the tx has moved blocks — but it is handed ONE expectedBlockHash for
        // the whole group (anchors of a merkle batch share a tx, so normally
        // they agree). If they DISAGREE — a partially-reorged group, a
        // half-finished earlier pass, a corrupted row — the group-level guard
        // can only arm for one of them, and the rest would silently receive a
        // branch derived under a block their own row does not name. Re-check
        // per anchor so a branch is only ever written onto a row whose recorded
        // block still matches the block the branch came from.
        //
        // H2: the block this row already describes is `block_hash` if it has
        // one — and OTHERWISE the block its stored `block_header` hashes to. A
        // header-present / hash-null row is schema-permitted (`upsertAnchorProofs`
        // and `backfillProofCompleteness` both write the two columns
        // independently), and while the guard tested only `expectedBlockHash`
        // for truthiness such a row disarmed BOTH gates: the job fetched the
        // tx's CURRENT block and overwrote the stored 80-byte header with a
        // DIFFERENT block's, publishing a header for a block that never
        // contained the commitment — and counting it as a success. A header
        // identifies its own block, so that blind spot was never necessary.
        // A stored header we cannot interpret (not 160-hex) yields null here
        // and is handled by the guard below: unreadable is not permission.
        const recordedBlock =
          anchor.expectedBlockHash ?? blockHashFromHeaderHex(anchor.expectedBlockHeader);
        const headerUnreadable =
          !anchor.expectedBlockHash &&
          anchor.expectedBlockHeader != null &&
          recordedBlock === null;
        if (
          headerUnreadable ||
          (recordedBlock && recordedBlock.toLowerCase() !== proof.blockHash.toLowerCase())
        ) {
          result.anchorsBlockMismatch += 1;
          logger.warn(
            { txId, anchorId: anchor.anchorId, headerUnreadable },
            'confirmation-proof: anchor row records a different block than the tx is in — NOT writing a branch from another block',
          );
          continue;
        }
        updates.push({
          anchorId: anchor.anchorId,
          blockHeader: proof.blockHeader,
          blockHash: proof.blockHash,
          blockHeight: anchor.blockHeight ?? null,
          // R1: the bitcoin-tree inclusion evidence this job used to compute
          // and discard. Written in the SAME row UPDATE as the header it was
          // derived under, so header and branch can never disagree about which
          // block they describe. `fetchConfirmationProof` only ever returns
          // these on `confirmed` and never fabricates them, so an undefined
          // here omits the column rather than nulling a populated one.
          txInclusionBranch: proof.merkleBranch,
          txBlockIndex: proof.txIndex,
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
      anchorsBlockMismatch: result.anchorsBlockMismatch,
    },
    'confirmation-proof population complete',
  );

  return result;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * B1: the group-level reorg hash, or `null` when the group does not agree.
 *
 * Returns a hash ONLY when EVERY anchor of the tx records the SAME block
 * (case-insensitively) — a genuine "this whole group has moved" signal that is
 * safe to short-circuit on. Any disagreement, and any anchor with no recorded
 * block at all, returns `null`: the group-level guard stays disarmed and the
 * per-anchor K1 gate decides each row on its own recorded hash. That gate is
 * strictly stronger, so disarming here loses no safety — it only stops one row
 * from speaking for all the others.
 */
function unanimousBlockHash(group: ConfirmationProofCandidate[]): string | null {
  let agreed: string | null = null;
  for (const c of group) {
    if (!c.expectedBlockHash) return null; // a row with nothing recorded ⇒ no consensus
    const lower = c.expectedBlockHash.toLowerCase();
    if (agreed === null) agreed = lower;
    else if (agreed !== lower) return null; // rows disagree ⇒ no consensus
  }
  return agreed;
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
  /**
   * K1: the block hash a PREVIOUS pass recorded for this proof. Null on a
   * first population. Threaded into the fetch as `expectedBlockHash` so a
   * backfill can never overwrite evidence recorded under a block the tx has
   * since left.
   */
  block_hash: string | null;
  /**
   * H2: the header a previous pass recorded, as PostgREST returns `bytea`
   * (`\x`-prefixed hex). A header identifies its own block, so this is the
   * reorg guard's answer for the schema-permitted header-present / hash-null
   * row that used to disarm it. Selected for that reason and no other — it is
   * never re-published from here.
   */
  block_header: string | null;
  anchors: {
    chain_tx_id: string | null;
    chain_block_height: number | null;
    status: string | null;
  } | null;
}

/**
 * H1: rotating sweep cursor over `anchor_proofs.anchor_id`.
 *
 * The scan is a bounded `LIMIT maxRows` over ~667k candidate rows. With no
 * ORDER BY, Postgres returns them in heap order — which is STABLE — so any row
 * that cannot be completed (a stale/pending tx, or one the per-anchor reorg
 * gate skips) keeps its position and comes back first on every single run.
 * Once `maxRows` such rows accumulate the window is full of them permanently:
 * the backfill stops advancing AND newly-SECURED anchors stop receiving even
 * `block_header`, which they previously got reliably. Raising the budget or
 * the timeout would only move the number at which that happens, so neither is
 * a fix.
 *
 * The fix is a total order plus a cursor that advances past whatever was just
 * scanned, whether or not it succeeded. `anchor_id` is UNIQUE (it is the
 * upsert conflict target) and carries a btree index, so it gives a strict total
 * order the database can walk cheaply — unlike `created_at`, which is unindexed
 * here and not unique.
 *
 * WHAT THIS GUARANTEES, precisely: within one worker process, consecutive runs
 * sweep forward and wrap at the end, so every candidate row is visited once per
 * ⌈candidates / maxRows⌉ runs and no set of rows can occupy the window forever.
 * WHAT IT DOES NOT: this is in-process state, so a restart (or a second Cloud
 * Run instance) restarts its own sweep from the beginning of the keyspace. That
 * is still forward progress and still bounded — it is not a durable checkpoint,
 * and callers that need one pass `startAfterAnchorId` explicitly.
 */
let scanCursorAnchorId = '';

/** Reset the rotating sweep cursor (tests only — see {@link scanCursorAnchorId}). */
export function __resetConfirmationScanCursorForTests(): void {
  scanCursorAnchorId = '';
}

/**
 * Find SECURED anchors whose app-tree proof is complete (`merkle_root`
 * present) but whose bitcoin-tree confirmation evidence is INCOMPLETE, and
 * populate it.
 *
 * K3 — THE WATERMARK IS A SET OF COLUMNS, NOT ONE COLUMN. This scan used
 * `block_header IS NULL` alone. That was correct while the header was the only
 * bitcoin-tree column: a populated header meant a finished row. The moment
 * `tx_inclusion_branch` / `tx_block_index` (migration 0427) joined it, that
 * predicate became a trap — every row a previous pass had already given a
 * header was permanently invisible to the scan, so the new columns could only
 * ever be filled for anchors confirmed AFTER the deploy and the entire existing
 * population would never be backfilled. The watermark is now an OR across the
 * bitcoin-tree columns: a row is a candidate while ANY of them is null, and
 * drops out only once they are all populated. Rows that are already complete
 * still match nothing, so this does not re-fetch finished work.
 *
 * This is the cron entrypoint. It is deliberately SEPARATE from the hot
 * `check-confirmations.ts` bulk-drain path: that path is latency-critical
 * (10k-row drains under a 60s statement timeout) and already re-soaked; adding
 * a header fetch inline would re-open it. Instead this runs as its own bounded
 * pass — a SECURED anchor gets its app-tree branch at broadcast (FIX-1), then
 * this fills the header/branch shortly after on the next pass. The `anchor_proofs`
 * data itself is the watermark (a row whose bitcoin-tree columns are ALL
 * populated stops matching the scan), so it is naturally resumable + idempotent.
 *
 * Gated by the chain client: in mock/non-prod mode the injected provider is the
 * mock, so this is a no-op-ish pass (mock getRawTransaction returns no block).
 *
 * @param provider injected for tests; production callers pass the GetBlock-backed provider.
 */
export async function populateConfirmationProofsForSecuredAnchors(
  client: SupabaseClient,
  provider: ConfirmationProofProvider,
  options: PopulateConfirmationProofsOptions & {
    maxRows?: number;
    /**
     * H1: start the sweep after this `anchor_id` instead of the rotating
     * in-process cursor. Lets an operator resume or steer a sweep, and lets
     * tests drive the window without relying on module state.
     */
    startAfterAnchorId?: string;
  } = {},
): Promise<PopulateConfirmationProofsResult & { scanned: number }> {
  const maxRows = options.maxRows ?? MAX_CONFIRMATION_PROOF_ROWS_PER_RUN;
  const cursor = options.startAfterAnchorId ?? scanCursorAnchorId;

  // Scan anchor_proofs for app-tree-complete-but-confirmation-missing rows,
  // joined to anchors to confirm SECURED + recover the recorded block hash.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested select shape pending types regen
  const { data, error } = await (client as any)
    .from('anchor_proofs')
    // M6: `tx_inclusion_branch` is deliberately NOT selected. It was, and
    // nothing read it — `ProofScanRow` did not even declare it, yet a test
    // pinned its presence in this string, which is a test asserting a
    // typo-check rather than a behaviour. Filtering on a column does not
    // require selecting it (see the `.or()` watermark below), and there is no
    // honest local use for the stored branch here: the one thing it could save
    // is an RPC on a legacy branch-without-index row, and the only way to do
    // that is to DERIVE the index from the branch's own positions — which
    // manufactures a pair that the reader's index/side cross-check can never
    // reject. Re-deriving both halves from the chain and writing them
    // atomically is strictly better evidence for the same row.
    .select('anchor_id, receipt_id, block_height, block_hash, block_header, anchors!inner(chain_tx_id, chain_block_height, status)')
    .not('merkle_root', 'is', null)
    // K3 + H4: incomplete = ANY bitcoin-tree column still null.
    //
    // `tx_block_index` used to be left out on the grounds that it "is never
    // independently null" because it is written in the same UPDATE as the
    // branch. That was an assumption about the writer, not a property of the
    // schema: `ConfirmationProof.txIndex` is independently optional and the
    // write mapping omits each key independently, so a branch could land with a
    // NULL index — and such a row then matched NOTHING in this OR, becoming
    // permanently invisible and unrepairable while `/proof` published a branch a
    // verifier could not order-check. The writer now enforces the pair
    // atomically (see `updateAnchorConfirmationProofs`); this predicate is the
    // second half of that belt, and it also repairs any row an earlier revision
    // half-populated. A complete row still matches nothing, so no finished work
    // is re-fetched.
    .or('block_header.is.null,tx_inclusion_branch.is.null,tx_block_index.is.null')
    .eq('anchors.status', 'SECURED')
    .not('anchors.chain_tx_id', 'is', null)
    // H1: a total order + a cursor, so a page of rows that can never complete
    // is scanned once and then stepped over — not returned first, forever.
    .gt('anchor_id', cursor)
    .order('anchor_id', { ascending: true })
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
      anchorsBlockMismatch: 0,
    };
  }

  const rows = (data ?? []) as ProofScanRow[];

  // H1: advance the sweep past everything this page covered — SUCCEEDED OR NOT.
  // Advancing only on success is what would let a wedged page pin the window.
  // A short page means we reached the end of the candidate set, so wrap.
  if (options.startAfterAnchorId === undefined) {
    scanCursorAnchorId = rows.length === maxRows && rows.length > 0 ? rows[rows.length - 1].anchor_id : '';
  }

  const candidates: ConfirmationProofCandidate[] = rows
    .map((row): ConfirmationProofCandidate | null => {
      const txId = row.anchors?.chain_tx_id;
      if (!txId) return null;
      return {
        anchorId: row.anchor_id,
        chainTxId: txId,
        blockHeight: row.block_height ?? row.anchors?.chain_block_height ?? null,
        // K1: on a FIRST population there is no recorded block yet, and reorg
        // safety comes from gettxoutproof being pinned to the tx's CURRENT
        // block (a proof that doesn't contain the tx ⇒ stale). But once K3 lets
        // already-populated rows back into the scan, `block_hash` IS recorded —
        // and it is the only thing that can tell a legitimate branch backfill
        // apart from overwriting a header recorded under a block the tx has
        // since left. Thread it through so the reorg guard actually arms.
        expectedBlockHash: row.block_hash ?? null,
        // H2: …and when it is NOT recorded but a header IS, the header names
        // the block itself. `bytea` arrives `\x`-prefixed; normalise it here so
        // the guard downstream deals only in plain hex.
        expectedBlockHeader: fromByteaHex(row.block_header),
      };
    })
    .filter((c): c is ConfirmationProofCandidate => c !== null);

  const populateResult = await populateConfirmationProofs(client, provider, candidates, options);
  return { scanned: rows.length, ...populateResult };
}

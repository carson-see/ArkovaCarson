/**
 * L1-5 (S3.3) — pre-broadcast txid journal: PURE decision core.
 *
 * Closes the ambiguous crash window in the batch drain (lane1-report §2.3,
 * CTO memo R3/R9): batch-anchor.ts broadcasts the Merkle root (Phase 3,
 * submitFingerprint) and only afterwards persists chain_tx_id
 * (submit_batch_anchors, Phase 4). A hard crash between network-accept and
 * persistence leaves rows BROADCASTING with chain_tx_id NULL;
 * recover_stuck_broadcasts then reverts them to PENDING and the next drain
 * broadcasts a SECOND tx for the same fingerprints (double treasury spend —
 * the 2026-04-24 incident class at a wider seam).
 *
 * The journal closes the window: AFTER signing (the txid is computable from
 * the signed tx — signet.ts `psbt.extractTransaction().getId()` — and cannot
 * change once we broadcast that exact hex) and BEFORE broadcast, persist
 * {batch_id, txid, fingerprint_root, signed_at}. Reconcile then consults
 * `getrawtransaction(journaled_txid)` BEFORE reverting any NULL-chain_tx_id
 * row, and decides via `decideReconcileAction`:
 *
 *   revert      — safe to return rows to PENDING (no journal entry, or the
 *                 journaled tx was never observed and the ambiguity window
 *                 has elapsed).
 *   adopt-txid  — the journaled tx IS on the network: stamp rows with the
 *                 journaled txid (equivalent to what Phase 4 would have
 *                 written) instead of reverting. Never re-broadcast.
 *   hold        — evidence is ambiguous (lookup failed / txid mismatch /
 *                 conflicted sentinel / inside the window / clock skew).
 *                 Do nothing this pass; a later pass re-evaluates.
 *
 * DESIGN RULE (bias): the ONLY path to `revert` is affirmative evidence of
 * absence. Missing/failed/contradictory evidence always HOLDS — a stuck-held
 * row is an operator page; a wrong revert is an on-chain double-spend that no
 * operator can undo.
 *
 * This module is deliberately PURE (no db, no chain client, no logger, no
 * clock reads — `nowMs` is injected) so the 4 crash boundaries are unit-
 * testable without a rig. Table design (0355+), the journal write site, and
 * the reconcile wiring live in docs/lane1/s33-txid-journal-design.md and are
 * NOT in this PR (batch-anchor.ts collides with soaking #1417 — CTO R9).
 */

import { z } from 'zod';

/**
 * How long after `signed_at` a not-found journaled tx is still ambiguous.
 *
 * Inside this window a not-found lookup proves nothing: the worker may be
 * mid-broadcast on another instance, or the tx may be accepted but not yet
 * visible to the lookup node (GetBlock node lag / mempool propagation).
 * 30 min = two prod recover-broadcasts cycles (Cloud Scheduler every-15-min),
 * comfortably above observed propagation lag while still far below the
 * Trigger B age threshold (3 h), so a genuinely-dead batch is re-drained the
 * same day. Rig runs may inject a shorter window via `ambiguityWindowMs`.
 */
export const DEFAULT_AMBIGUITY_WINDOW_MS = 30 * 60 * 1000;

const HEX_64 = /^[0-9a-f]{64}$/;

const journalEntrySchema = z.object({
  /** Drain batch id (batch-anchor.ts `batch_<ts>_<n>`; generated pre-broadcast once wired). */
  batchId: z.string().trim().min(1).max(128),
  /** Txid of the SIGNED tx (computable pre-broadcast; immutable once that exact hex is broadcast). */
  txid: z
    .string()
    .trim()
    .toLowerCase()
    .regex(HEX_64, 'txid must be 64 lowercase hex chars'),
  /** Merkle root over the claimed fingerprints (the OP_RETURN payload body). */
  fingerprintRoot: z
    .string()
    .trim()
    .toLowerCase()
    .regex(HEX_64, 'fingerprintRoot must be 64 lowercase hex chars'),
  /** ISO-8601 signing timestamp (server clock, UTC — §1.5). */
  signedAt: z
    .string()
    .trim()
    .refine((s) => s.length > 0 && Number.isFinite(Date.parse(s)), 'signedAt must be a parsable ISO-8601 timestamp'),
});

export type TxidJournalEntry = z.infer<typeof journalEntrySchema>;

/**
 * Validate + normalize a journal entry (Zod — §1.2 every write path).
 *
 * THROWS on invalid input. Fail-loud is the point: once wired, the journal
 * INSERT sits between signing and broadcast, and a batch that cannot be
 * journaled must NOT be broadcast (aborting pre-broadcast is always safe —
 * nothing has hit the network, claims revert cleanly).
 */
export function buildJournalEntry(input: {
  batchId: string;
  txid: string;
  fingerprintRoot: string;
  signedAt: string;
}): TxidJournalEntry {
  return journalEntrySchema.parse(input);
}

/** Result of looking up the journaled txid on the network (getrawtransaction seam). */
export type ChainLookupResult =
  | { kind: 'found'; txid: string; confirmations: number }
  | { kind: 'not_found' }
  | { kind: 'lookup_failed'; reason?: string };

export type ReconcileAction = 'revert' | 'adopt-txid' | 'hold';

export interface ReconcileDecision {
  action: ReconcileAction;
  /** Machine-greppable `<slug>: <detail>` explanation — every decision is logged. */
  reason: string;
  /** The txid to stamp onto the rows. Present iff action === 'adopt-txid'. */
  txid?: string;
}

/**
 * B4 exclusion: only BROADCASTING rows with NULL chain_tx_id are in the
 * ambiguous window. Rows that already carry a chain_tx_id were persisted
 * (crash boundary B4) — the existing recover_stuck_broadcasts
 * `chain_tx_id IS NULL` guard owns them and the journal is never consulted.
 */
export function shouldConsultJournal(row: { status: string; chain_tx_id: string | null }): boolean {
  return row.status === 'BROADCASTING' && row.chain_tx_id === null;
}

/**
 * The reconcile decision core. Pure: clock injected, no I/O.
 *
 * @param entry  The journal entry for the stuck batch, or null when no entry
 *               exists (crash before signing — boundary B1).
 * @param lookup Result of getrawtransaction(entry.txid), or null when no
 *               lookup was performed (treated as unavailable evidence).
 */
export function decideReconcileAction(
  entry: TxidJournalEntry | null,
  lookup: ChainLookupResult | null,
  opts: { nowMs?: number; ambiguityWindowMs?: number } = {},
): ReconcileDecision {
  // B1 — nothing was ever signed: no tx can exist for this batch. The
  // existing revert-to-PENDING behavior is provably safe.
  if (entry === null) {
    return {
      action: 'revert',
      reason: 'no-journal-entry: crash predates signing; no tx can exist for this batch',
    };
  }

  // A journal entry exists — from here on, only affirmative evidence of
  // absence may revert.

  if (lookup === null || lookup.kind === 'lookup_failed') {
    const detail = lookup === null ? 'no lookup performed' : (lookup.reason ?? 'unspecified provider error');
    return {
      action: 'hold',
      reason: `lookup-unavailable: ${detail}; elapsed time is not evidence — retry next pass`,
    };
  }

  if (lookup.kind === 'found') {
    if (lookup.txid.trim().toLowerCase() !== entry.txid) {
      return {
        action: 'hold',
        reason: 'txid-mismatch: lookup returned a different tx than journaled; refusing to adopt or revert',
      };
    }
    if (lookup.confirmations < 0) {
      return {
        action: 'hold',
        reason: 'conflicted-sentinel: negative confirmations (conflicted/reorged); not adoptable, not provably absent',
      };
    }
    // B3 — the tx IS on the network. Adopting the journaled txid is
    // idempotent with what Phase 4 (submit_batch_anchors) would have written.
    return {
      action: 'adopt-txid',
      reason: `journaled-tx-on-network: adopting journaled txid at ${lookup.confirmations} confirmation(s)`,
      txid: entry.txid,
    };
  }

  // not_found — B2 vs still-ambiguous, decided by the window.
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.ambiguityWindowMs ?? DEFAULT_AMBIGUITY_WINDOW_MS;
  const signedAtMs = Date.parse(entry.signedAt);

  if (!Number.isFinite(signedAtMs)) {
    return {
      action: 'hold',
      reason: 'unparsable-signed-at: cannot bound the ambiguity window; refusing to revert blind',
    };
  }
  if (signedAtMs > nowMs) {
    return {
      action: 'hold',
      reason: 'clock-skew: signedAt is in the future; refusing to revert on an untrusted clock',
    };
  }
  if (nowMs - signedAtMs < windowMs) {
    return {
      action: 'hold',
      reason: 'inside-ambiguity-window: signed recently; tx may still be propagating or broadcast may be in flight',
    };
  }

  // B2 — signed, never observed on the network, window elapsed: the broadcast
  // never happened (or was never accepted). Safe to revert and re-drain.
  return {
    action: 'revert',
    reason: `not-found-after-window: no network observation ${Math.round((nowMs - signedAtMs) / 1000)}s after signing`,
  };
}

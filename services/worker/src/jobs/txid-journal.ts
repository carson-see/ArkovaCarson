/**
 * SCRUM-2692 — durable pre-broadcast txid journal decision core.
 *
 * The worker computes a signed Bitcoin transaction's immutable txid before
 * broadcast. Recovery therefore never has to guess whether a stale claim is
 * safe to retry:
 *
 * - ADOPT only when the exact journaled txid is found.
 * - REVERT only when there is no journal, or the provider affirmatively
 *   reports absence after the bounded propagation window.
 * - HOLD on every ambiguous outcome. HELD journals are excluded from the
 *   generic stale-BROADCASTING sweep by migration 0358.
 *
 * This file is deliberately pure. Database persistence and chain lookup live
 * at the batch/recovery boundary so this decision table is exhaustively unit
 * tested without network or database mocks.
 */

import { z } from 'zod';

export const DEFAULT_TXID_AMBIGUITY_WINDOW_MS = 30 * 60 * 1000;

export type TxidJournalRecoveryStatus =
  | 'PENDING'
  | 'HELD'
  | 'ADOPTED'
  | 'REVERTED'
  | 'PERSISTED';

export interface TxidJournalLeaf {
  anchorId: string;
  fingerprint: string;
}

export interface TxidJournalEntry {
  batchId: string;
  txid: string;
  fingerprintRoot: string;
  anchorIds: string[];
  leafOrder: TxidJournalLeaf[];
  signedAt: string;
}

export type TxidJournalLookupResult =
  | { status: 'found'; txid: string; confirmations: number }
  | { status: 'not_found' }
  | { status: 'lookup_failed' };

export type TxidJournalRecoveryDecision =
  | { action: 'ADOPT'; reason: 'exact_txid_found'; txid: string }
  | {
      action: 'REVERT';
      reason: 'no_journal_entry' | 'affirmative_absence_after_ambiguity_window';
      txid?: string;
    }
  | {
      action: 'HOLD';
      reason:
        | 'found_txid_mismatch'
        | 'negative_confirmations'
        | 'lookup_failed'
        | 'missing_lookup_result'
        | 'absence_inside_ambiguity_window'
        | 'untrusted_signed_at';
    };

const hex64 = z.string().regex(/^[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase());

const leafSchema = z.object({
  // Production persistence is uuid[]-typed by Postgres. Keep the pure core
  // storage-agnostic so deterministic in-memory crash harnesses can use their
  // stable synthetic anchor identifiers.
  anchorId: z.string().trim().min(1).max(128),
  fingerprint: hex64,
});

const entrySchema = z.object({
  batchId: z.string().trim().min(1).max(200),
  txid: hex64,
  fingerprintRoot: hex64,
  leafOrder: z.array(leafSchema).min(1).max(10_000),
  signedAt: z.string().datetime({ offset: true }),
}).superRefine((entry, ctx) => {
  const ids = new Set<string>();
  entry.leafOrder.forEach((leaf, index) => {
    if (ids.has(leaf.anchorId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['leafOrder', index, 'anchorId'],
        message: 'anchor ids must be unique within a journal cohort',
      });
    }
    ids.add(leaf.anchorId);
  });
});

/** Validate and normalize the immutable journal payload before persistence. */
export function buildTxidJournalEntry(input: {
  batchId: string;
  txid: string;
  fingerprintRoot: string;
  leafOrder: TxidJournalLeaf[];
  signedAt: string;
}): TxidJournalEntry {
  const parsed = entrySchema.parse(input);
  return {
    ...parsed,
    anchorIds: parsed.leafOrder.map((leaf) => leaf.anchorId),
  };
}

/**
 * Decide the only safe recovery action. Time alone is never evidence of
 * absence: elapsed time permits REVERT only alongside an explicit not-found
 * verdict from the configured chain provider.
 */
export function decideTxidJournalRecovery(
  entry: TxidJournalEntry | null,
  lookup: TxidJournalLookupResult | null,
  options: { nowMs?: number; ambiguityWindowMs?: number } = {},
): TxidJournalRecoveryDecision {
  if (!entry) {
    return { action: 'REVERT', reason: 'no_journal_entry' };
  }

  if (!lookup) {
    return { action: 'HOLD', reason: 'missing_lookup_result' };
  }

  if (lookup.status === 'lookup_failed') {
    return { action: 'HOLD', reason: 'lookup_failed' };
  }

  if (lookup.status === 'found') {
    if (lookup.txid.toLowerCase() !== entry.txid) {
      return { action: 'HOLD', reason: 'found_txid_mismatch' };
    }
    if (!Number.isFinite(lookup.confirmations) || lookup.confirmations < 0) {
      return { action: 'HOLD', reason: 'negative_confirmations' };
    }
    return { action: 'ADOPT', reason: 'exact_txid_found', txid: entry.txid };
  }

  const nowMs = options.nowMs ?? Date.now();
  const signedAtMs = Date.parse(entry.signedAt);
  const ambiguityWindowMs = options.ambiguityWindowMs ?? DEFAULT_TXID_AMBIGUITY_WINDOW_MS;
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(signedAtMs) ||
    signedAtMs > nowMs ||
    !Number.isFinite(ambiguityWindowMs) ||
    ambiguityWindowMs < 0
  ) {
    return { action: 'HOLD', reason: 'untrusted_signed_at' };
  }

  if (nowMs - signedAtMs < ambiguityWindowMs) {
    return { action: 'HOLD', reason: 'absence_inside_ambiguity_window' };
  }

  return {
    action: 'REVERT',
    reason: 'affirmative_absence_after_ambiguity_window',
    txid: entry.txid,
  };
}

/** PENDING and HELD cohorts must never enter generic stale-claim recovery. */
export function isJournalRecoveryProtected(status: TxidJournalRecoveryStatus): boolean {
  return status === 'PENDING' || status === 'HELD';
}

/** Pure mirror of the generic recovery boundary for adversarial tests. */
export function shouldConsultTxidJournal(row: {
  status: string;
  chainTxId: string | null;
}): boolean {
  return row.status === 'BROADCASTING' && row.chainTxId === null;
}

/**
 * L1-5 (S3.3) — pre-broadcast txid journal: PURE decision core.
 *
 * Written RED-FIRST against services/worker/src/jobs/txid-journal.ts (which
 * does not exist when this file is first committed to the working tree).
 *
 * WHY THIS MODULE EXISTS (the ambiguous crash window, lane1-report §2.3 /
 * CTO memo R9 carve-out):
 *
 *   batch-anchor.ts Phase 3 broadcasts (submitFingerprint, :741-745) and only
 *   THEN persists chain_tx_id via submit_batch_anchors (:763+). A hard crash
 *   (SIGKILL / OOM / instance preemption) AFTER the network accepted the tx
 *   but BEFORE persistence leaves rows BROADCASTING with chain_tx_id NULL.
 *   recover_stuck_broadcasts sees NULL chain_tx_id → reverts to PENDING →
 *   the next drain claims the same fingerprints and broadcasts a SECOND,
 *   DIFFERENT tx (double-spend of treasury sats + two on-chain receipts for
 *   one logical batch — the 2026-04-24 incident class, now at a wider seam).
 *
 *   Fix: journal {batch_id, txid, fingerprint_root, signed_at} AFTER signing
 *   (txid is computable from the signed tx, signet.ts psbt.extractTransaction
 *   → tx.getId()) and BEFORE broadcast. Reconcile consults the journal +
 *   getrawtransaction(journaled_txid) BEFORE reverting NULL-chain_tx_id rows.
 *
 * THE FOUR CRASH BOUNDARIES (each maps to a decision below):
 *   B1  crash after claim, before sign      → no journal row   → REVERT (safe)
 *   B2  crash after sign, before broadcast  → journaled, tx never on network
 *                                             → REVERT once the ambiguity
 *                                               window has elapsed; HOLD inside
 *   B3  crash after network-accept, before persist
 *                                           → journaled, tx found on network
 *                                             → ADOPT-TXID (never revert)
 *   B4  crash after persist                 → chain_tx_id set; journal is NOT
 *                                             consulted (shouldConsultJournal
 *                                             excludes the row; existing
 *                                             recover_stuck_broadcasts guard
 *                                             already leaves it alone)
 *
 * NO drain wiring in this PR — batch-anchor.ts collides with soaking #1417
 * (CTO R9). Wiring plan: docs/lane1/s33-txid-journal-design.md.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AMBIGUITY_WINDOW_MS,
  buildJournalEntry,
  decideReconcileAction,
  shouldConsultJournal,
  type ChainLookupResult,
  type TxidJournalEntry,
} from './txid-journal.js';

const TXID = 'a'.repeat(64);
const OTHER_TXID = 'b'.repeat(64);
const ROOT = 'c'.repeat(64);
const SIGNED_AT = '2026-07-10T12:00:00.000Z';
const SIGNED_AT_MS = Date.parse(SIGNED_AT);

function entry(overrides: Partial<TxidJournalEntry> = {}): TxidJournalEntry {
  return buildJournalEntry({
    batchId: 'batch_1752148800000_10000',
    txid: TXID,
    fingerprintRoot: ROOT,
    signedAt: SIGNED_AT,
    ...overrides,
  });
}

const found = (confirmations: number, txid: string = TXID): ChainLookupResult => ({
  kind: 'found',
  txid,
  confirmations,
});
const notFound: ChainLookupResult = { kind: 'not_found' };
const lookupFailed: ChainLookupResult = { kind: 'lookup_failed', reason: 'provider 502' };

// ─── journal-entry construction ────────────────────────────────────────────

describe('buildJournalEntry', () => {
  it('accepts a valid entry and returns it normalized', () => {
    const e = entry();
    expect(e.batchId).toBe('batch_1752148800000_10000');
    expect(e.txid).toBe(TXID);
    expect(e.fingerprintRoot).toBe(ROOT);
    expect(e.signedAt).toBe(SIGNED_AT);
  });

  it('normalizes uppercase/mixed-case hex to lowercase (txid + root)', () => {
    const e = buildJournalEntry({
      batchId: 'b1',
      txid: TXID.toUpperCase(),
      fingerprintRoot: `${'C'.repeat(32)}${'c'.repeat(32)}`,
      signedAt: SIGNED_AT,
    });
    expect(e.txid).toBe(TXID);
    expect(e.fingerprintRoot).toBe(ROOT);
  });

  it('trims surrounding whitespace before validating', () => {
    const e = buildJournalEntry({
      batchId: '  b1  ',
      txid: `  ${TXID}  `,
      fingerprintRoot: ` ${ROOT} `,
      signedAt: ` ${SIGNED_AT} `,
    });
    expect(e.batchId).toBe('b1');
    expect(e.txid).toBe(TXID);
  });

  it.each([
    ['63-hex txid', { txid: 'a'.repeat(63) }],
    ['65-hex txid', { txid: 'a'.repeat(65) }],
    ['non-hex txid', { txid: 'z'.repeat(64) }],
    ['empty txid', { txid: '' }],
    ['63-hex root', { fingerprintRoot: 'c'.repeat(63) }],
    ['non-hex root', { fingerprintRoot: 'g'.repeat(64) }],
    ['empty batchId', { batchId: '' }],
    ['whitespace-only batchId', { batchId: '   ' }],
    ['overlong batchId', { batchId: 'x'.repeat(129) }],
    ['unparsable signedAt', { signedAt: 'not-a-date' }],
    ['empty signedAt', { signedAt: '' }],
  ])('rejects %s (fail-loud: an unjournalable batch must NOT broadcast)', (_label, bad) => {
    expect(() =>
      buildJournalEntry({
        batchId: 'b1',
        txid: TXID,
        fingerprintRoot: ROOT,
        signedAt: SIGNED_AT,
        ...bad,
      }),
    ).toThrow();
  });
});

// ─── B4 exclusion: which rows even consult the journal ─────────────────────

describe('shouldConsultJournal (crash boundary B4 exclusion)', () => {
  it('consults for a BROADCASTING row with NULL chain_tx_id (B1/B2/B3 shape)', () => {
    expect(shouldConsultJournal({ status: 'BROADCASTING', chain_tx_id: null })).toBe(true);
  });

  it('does NOT consult when chain_tx_id is already persisted (B4 — existing guard owns it)', () => {
    expect(shouldConsultJournal({ status: 'BROADCASTING', chain_tx_id: TXID })).toBe(false);
    expect(shouldConsultJournal({ status: 'SUBMITTED', chain_tx_id: TXID })).toBe(false);
  });

  it('does NOT consult non-BROADCASTING rows (PENDING/SUBMITTED/SECURED are not in the ambiguous window)', () => {
    expect(shouldConsultJournal({ status: 'PENDING', chain_tx_id: null })).toBe(false);
    expect(shouldConsultJournal({ status: 'SUBMITTED', chain_tx_id: null })).toBe(false);
    expect(shouldConsultJournal({ status: 'SECURED', chain_tx_id: null })).toBe(false);
  });
});

// ─── B1: no journal entry ───────────────────────────────────────────────────

describe('decideReconcileAction — B1 crash after claim, before sign', () => {
  it('reverts when there is no journal entry (no broadcast can have happened)', () => {
    const d = decideReconcileAction(null, notFound);
    expect(d.action).toBe('revert');
    expect(d.txid).toBeUndefined();
  });

  it('reverts on null entry even when the chain lookup errored (nothing was signed — lookup is irrelevant)', () => {
    expect(decideReconcileAction(null, lookupFailed).action).toBe('revert');
    expect(decideReconcileAction(null, null).action).toBe('revert');
  });
});

// ─── B3: journaled + found on network → adopt ───────────────────────────────

describe('decideReconcileAction — B3 crash after network-accept, before persist', () => {
  it('adopts the journaled txid when the tx is in the mempool (0 confirmations)', () => {
    const d = decideReconcileAction(entry(), found(0));
    expect(d.action).toBe('adopt-txid');
    expect(d.txid).toBe(TXID);
  });

  it('adopts the journaled txid when the tx is confirmed (adoption is idempotent with what persist would have written)', () => {
    const d = decideReconcileAction(entry(), found(3));
    expect(d.action).toBe('adopt-txid');
    expect(d.txid).toBe(TXID);
  });

  it('adopts case-insensitively (provider returns uppercase hex)', () => {
    const d = decideReconcileAction(entry(), found(1, TXID.toUpperCase()));
    expect(d.action).toBe('adopt-txid');
    expect(d.txid).toBe(TXID);
  });

  it('HOLDS on a txid mismatch (provider returned a different tx — never adopt unverified, never revert)', () => {
    const d = decideReconcileAction(entry(), found(1, OTHER_TXID));
    expect(d.action).toBe('hold');
    expect(d.txid).toBeUndefined();
  });

  it('HOLDS on negative confirmations (bitcoind conflicted/reorged sentinel — ambiguous, not adoptable)', () => {
    const d = decideReconcileAction(entry(), found(-1));
    expect(d.action).toBe('hold');
  });
});

// ─── B2 + the ambiguous window: journaled but not found ─────────────────────

describe('decideReconcileAction — B2 crash after sign, before broadcast (the ambiguous window)', () => {
  it('HOLDS inside the ambiguity window (tx may still be propagating / worker mid-broadcast)', () => {
    const d = decideReconcileAction(entry(), notFound, {
      nowMs: SIGNED_AT_MS + DEFAULT_AMBIGUITY_WINDOW_MS - 1,
    });
    expect(d.action).toBe('hold');
  });

  it('REVERTS once the window has fully elapsed (signed but never observed — safe to re-drain)', () => {
    const d = decideReconcileAction(entry(), notFound, {
      nowMs: SIGNED_AT_MS + DEFAULT_AMBIGUITY_WINDOW_MS,
    });
    expect(d.action).toBe('revert');
  });

  it('honors a caller-supplied window (rig-day acceleration)', () => {
    const opts = { nowMs: SIGNED_AT_MS + 5_000, ambiguityWindowMs: 4_000 };
    expect(decideReconcileAction(entry(), notFound, opts).action).toBe('revert');
    expect(
      decideReconcileAction(entry(), notFound, { nowMs: SIGNED_AT_MS + 3_999, ambiguityWindowMs: 4_000 }).action,
    ).toBe('hold');
  });

  it('a zero window reverts immediately on not_found', () => {
    const d = decideReconcileAction(entry(), notFound, { nowMs: SIGNED_AT_MS, ambiguityWindowMs: 0 });
    expect(d.action).toBe('revert');
  });

  it('HOLDS when signedAt is in the future (clock skew — never revert on a clock we do not trust)', () => {
    const d = decideReconcileAction(entry(), notFound, { nowMs: SIGNED_AT_MS - 60_000 });
    expect(d.action).toBe('hold');
  });

  it('HOLDS when a (hand-constructed) entry carries an unparsable signedAt — never throws, never reverts blind', () => {
    const corrupt = { ...entry(), signedAt: 'garbage' } as TxidJournalEntry;
    const d = decideReconcileAction(corrupt, notFound, { nowMs: SIGNED_AT_MS + DEFAULT_AMBIGUITY_WINDOW_MS * 10 });
    expect(d.action).toBe('hold');
  });
});

// ─── lookup unavailable: never revert on missing evidence ───────────────────

describe('decideReconcileAction — lookup unavailable', () => {
  it('HOLDS on lookup_failed (provider outage must never trigger a revert → double-broadcast)', () => {
    const d = decideReconcileAction(entry(), lookupFailed);
    expect(d.action).toBe('hold');
  });

  it('HOLDS when no lookup was performed at all (null) but a journal entry exists', () => {
    const d = decideReconcileAction(entry(), null);
    expect(d.action).toBe('hold');
  });

  it('holds even far past the ambiguity window — elapsed time is not evidence when the lookup is unavailable', () => {
    const d = decideReconcileAction(entry(), lookupFailed, {
      nowMs: SIGNED_AT_MS + DEFAULT_AMBIGUITY_WINDOW_MS * 100,
    });
    expect(d.action).toBe('hold');
  });
});

// ─── every decision is explained ────────────────────────────────────────────

describe('decision reasons', () => {
  it('every action carries a non-empty machine-greppable reason', () => {
    const decisions = [
      decideReconcileAction(null, notFound),
      decideReconcileAction(entry(), found(1)),
      decideReconcileAction(entry(), found(1, OTHER_TXID)),
      decideReconcileAction(entry(), notFound, { nowMs: SIGNED_AT_MS + DEFAULT_AMBIGUITY_WINDOW_MS }),
      decideReconcileAction(entry(), notFound, { nowMs: SIGNED_AT_MS }),
      decideReconcileAction(entry(), lookupFailed),
    ];
    for (const d of decisions) {
      expect(d.reason.length).toBeGreaterThan(0);
      expect(d.reason).toMatch(/^[a-z0-9-]+:/); // `<slug>: <detail>` shape for log grepping
    }
  });
});

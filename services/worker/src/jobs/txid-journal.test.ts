import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_TXID_AMBIGUITY_WINDOW_MS,
  buildTxidJournalEntry,
  decideTxidJournalRecovery,
  isJournalRecoveryProtected,
  shouldConsultTxidJournal,
} from './txid-journal.js';

const TXID = 'ab'.repeat(32);
const ROOT = 'cd'.repeat(32);
const SIGNED_AT = '2026-07-15T12:00:00.000Z';
const NOW_MS = Date.parse(SIGNED_AT) + DEFAULT_TXID_AMBIGUITY_WINDOW_MS;

function journal() {
  return buildTxidJournalEntry({
    batchId: 'batch_1721044800000_2',
    txid: TXID.toUpperCase(),
    fingerprintRoot: ROOT.toUpperCase(),
    leafOrder: [
      { anchorId: '11111111-1111-4111-8111-111111111111', fingerprint: '01'.repeat(32) },
      { anchorId: '22222222-2222-4222-8222-222222222222', fingerprint: '02'.repeat(32) },
    ],
    signedAt: SIGNED_AT,
  });
}

describe('SCRUM-2692 txid journal entry', () => {
  it('normalizes the immutable txid/root and preserves ordered leaves', () => {
    const entry = journal();

    expect(entry.txid).toBe(TXID);
    expect(entry.fingerprintRoot).toBe(ROOT);
    expect(entry.anchorIds).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ]);
    expect(entry.leafOrder.map((leaf) => leaf.fingerprint)).toEqual([
      '01'.repeat(32),
      '02'.repeat(32),
    ]);
  });

  it.each([
    ['invalid txid', { txid: 'not-a-txid' }],
    ['invalid root', { fingerprintRoot: 'ff' }],
    ['empty batch id', { batchId: '   ' }],
    ['empty leaf order', { leafOrder: [] }],
    ['duplicate anchor id', {
      leafOrder: [
        { anchorId: '11111111-1111-4111-8111-111111111111', fingerprint: '01'.repeat(32) },
        { anchorId: '11111111-1111-4111-8111-111111111111', fingerprint: '02'.repeat(32) },
      ],
    }],
    ['unparseable signed_at', { signedAt: 'not-a-date' }],
  ])('rejects %s before any broadcast', (_label, override) => {
    expect(() => buildTxidJournalEntry({
      batchId: 'batch_1721044800000_2',
      txid: TXID,
      fingerprintRoot: ROOT,
      leafOrder: [
        { anchorId: '11111111-1111-4111-8111-111111111111', fingerprint: '01'.repeat(32) },
      ],
      signedAt: SIGNED_AT,
      ...override,
    })).toThrow();
  });
});

describe('SCRUM-2692 ADOPT / REVERT / HOLD decision', () => {
  it('REVERTs an unjournaled stale claim (nothing signed)', () => {
    expect(decideTxidJournalRecovery(null, null, { nowMs: NOW_MS })).toEqual({
      action: 'REVERT',
      reason: 'no_journal_entry',
    });
  });

  it('ADOPTs only the exact immutable txid, including zero confirmations', () => {
    expect(decideTxidJournalRecovery(journal(), {
      status: 'found',
      txid: TXID,
      confirmations: 0,
    }, { nowMs: NOW_MS })).toEqual({
      action: 'ADOPT',
      reason: 'exact_txid_found',
      txid: TXID,
    });
  });

  it.each([
    ['mismatched txid', { status: 'found' as const, txid: 'ef'.repeat(32), confirmations: 0 }, 'found_txid_mismatch'],
    ['conflicted tx', { status: 'found' as const, txid: TXID, confirmations: -1 }, 'negative_confirmations'],
    ['lookup outage', { status: 'lookup_failed' as const }, 'lookup_failed'],
  ])('HOLDs on %s', (_label, lookup, reason) => {
    expect(decideTxidJournalRecovery(journal(), lookup, { nowMs: NOW_MS })).toEqual({
      action: 'HOLD',
      reason,
    });
  });

  it('HOLDs a definitive not-found inside the ambiguity window', () => {
    const nowMs = Date.parse(SIGNED_AT) + DEFAULT_TXID_AMBIGUITY_WINDOW_MS - 1;
    expect(decideTxidJournalRecovery(journal(), { status: 'not_found' }, { nowMs })).toEqual({
      action: 'HOLD',
      reason: 'absence_inside_ambiguity_window',
    });
  });

  it('REVERTs only after affirmative absence reaches the bounded window', () => {
    expect(decideTxidJournalRecovery(journal(), { status: 'not_found' }, { nowMs: NOW_MS })).toEqual({
      action: 'REVERT',
      reason: 'affirmative_absence_after_ambiguity_window',
      txid: TXID,
    });
  });

  it('HOLDs when signed_at is in the future rather than trusting a bad clock', () => {
    expect(decideTxidJournalRecovery(journal(), { status: 'not_found' }, {
      nowMs: Date.parse(SIGNED_AT) - 1,
    })).toEqual({
      action: 'HOLD',
      reason: 'untrusted_signed_at',
    });
  });

  it('supports a shorter injected ambiguity window for the isolated crash rig', () => {
    expect(decideTxidJournalRecovery(journal(), { status: 'not_found' }, {
      nowMs: Date.parse(SIGNED_AT) + 5_000,
      ambiguityWindowMs: 5_000,
    }).action).toBe('REVERT');
  });
});

describe('SCRUM-2692 HELD-cohort protection', () => {
  it.each(['PENDING', 'HELD'] as const)('protects %s journals from generic recovery', (status) => {
    expect(isJournalRecoveryProtected(status)).toBe(true);
  });

  it.each(['ADOPTED', 'REVERTED', 'PERSISTED'] as const)('does not protect resolved %s journals', (status) => {
    expect(isJournalRecoveryProtected(status)).toBe(false);
  });

  it('consults the journal only for BROADCASTING rows without a durable txid', () => {
    expect(shouldConsultTxidJournal({ status: 'BROADCASTING', chainTxId: null })).toBe(true);
    expect(shouldConsultTxidJournal({ status: 'BROADCASTING', chainTxId: TXID })).toBe(false);
    expect(shouldConsultTxidJournal({ status: 'PENDING', chainTxId: null })).toBe(false);
  });
});

describe('SCRUM-2692 migration contract', () => {
  const migrationUrl = new URL(
    '../../../../supabase/migrations/0358_scrum2692_anchor_txid_journal.sql',
    import.meta.url,
  );

  it('creates a service-role-only journal with immutable cohort constraints', () => {
    const sql = readFileSync(migrationUrl, 'utf8');

    expect(sql).toMatch(/CREATE TABLE public\.anchor_txid_journal/i);
    expect(sql).toMatch(/anchor_ids\s+uuid\[\]\s+NOT NULL/i);
    expect(sql).toMatch(/recovery_status[\s\S]*PENDING[\s\S]*HELD[\s\S]*ADOPTED[\s\S]*REVERTED[\s\S]*PERSISTED/i);
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/CREATE POLICY anchor_txid_journal_deny_clients[\s\S]*TO anon, authenticated[\s\S]*USING \(false\)[\s\S]*WITH CHECK \(false\)/i);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.anchor_txid_journal FROM anon, authenticated/i);
    expect(sql).toMatch(/REVOKE ALL ON TABLE public\.anchor_txid_journal FROM service_role/i);
    expect(sql).toMatch(/GRANT SELECT, DELETE ON TABLE public\.anchor_txid_journal TO service_role/i);
    expect(sql).not.toMatch(/GRANT[^;]*\b(?:INSERT|UPDATE)\b[^;]*anchor_txid_journal[^;]*service_role/i);
  });

  it('serializes journal persistence with lifecycle transitions and permits exact retries after REVERT', () => {
    const sql = readFileSync(migrationUrl, 'utf8');

    expect(sql).toMatch(/CREATE UNIQUE INDEX anchor_txid_journal_live_batch_id_unique[\s\S]*\(batch_id\)[\s\S]*WHERE recovery_status <> 'REVERTED'/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX anchor_txid_journal_live_txid_unique[\s\S]*\(txid\)[\s\S]*WHERE recovery_status <> 'REVERTED'/i);
    expect(sql).not.toMatch(/CONSTRAINT anchor_txid_journal_(?:batch_id|txid)_unique UNIQUE/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.persist_anchor_txid_journal/i);
    expect(sql).toMatch(/FROM public\.anchors a[\s\S]*ORDER BY a\.id[\s\S]*FOR UPDATE/i);
    expect(sql).toMatch(/v_locked_count <> cardinality\(p_anchor_ids\)/i);
    expect(sql).toMatch(/a\.status <> 'BROADCASTING'/i);
    expect(sql).toMatch(/a\.chain_tx_id IS NOT NULL/i);
    expect(sql).toMatch(/RETURNS jsonb/i);
    expect(sql).toMatch(/'created', false/i);
    expect(sql).toMatch(/'created', true/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.persist_anchor_txid_journal/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.persist_anchor_txid_journal[\s\S]*TO service_role/i);
  });

  it('blocks supersede/revoke only while a journal is unresolved and keeps supersede aligned with the state machine', () => {
    const sql = readFileSync(migrationUrl, 'utf8');
    const machine = readFileSync(
      new URL('../../../../machines/bitcoinAnchor.machine.ts', import.meta.url),
      'utf8',
    );

    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.guard_anchor_txid_journal_lifecycle/i);
    expect(sql).toMatch(/NEW\.status IN \('REVOKED', 'SUPERSEDED'\)[\s\S]*recovery_status IN \('PENDING', 'HELD'\)/i);
    expect(sql).toMatch(/CREATE TRIGGER guard_anchor_txid_journal_lifecycle/i);
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.revoke_anchor/i);
    const supersedeAction = machine.match(/supersede:\s*\{[\s\S]*?\n\s*\},\n\n\s*\/\/ Reorg detection/)?.[0] ?? '';
    expect(supersedeAction).toContain('eq(index(journalRecovery, param("a")), lit("NONE"))');
    expect(supersedeAction).not.toContain('setMap("journalRecovery", param("a"), lit("NONE"))');
  });

  it('uses a symbolic missing-row condition so quota policy lint cannot misread a SQLSTATE literal', () => {
    const sql = readFileSync(migrationUrl, 'utf8');

    expect(sql).toMatch(/RAISE no_data_found[\s\S]*Txid journal not found/i);
    expect(sql).not.toContain("ERRCODE = 'P0002'");
  });

  it('protects PENDING/HELD cohorts inside the atomic generic recovery RPC', () => {
    const sql = readFileSync(migrationUrl, 'utf8');

    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.recover_stuck_broadcasts/i);
    expect(sql).toMatch(/NOT EXISTS\s*\([\s\S]*anchor_txid_journal[\s\S]*recovery_status IN \('PENDING', 'HELD'\)[\s\S]*ANY\s*\(j\.anchor_ids\)/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.recover_stuck_broadcasts\(integer\) FROM PUBLIC, anon, authenticated/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.recover_stuck_broadcasts\(integer\) TO service_role/i);
  });

  it('provides an atomic service-role ADOPT/REVERT/HOLD resolution boundary and rollback', () => {
    const sql = readFileSync(migrationUrl, 'utf8');

    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.resolve_anchor_txid_journal/i);
    expect(sql).toMatch(/p_action IN \('ADOPT', 'REVERT', 'HOLD', 'PERSISTED'\)/i);
    expect(sql).toMatch(/p_action = 'ADOPT'[\s\S]*status = 'SUBMITTED'/i);
    expect(sql).toMatch(/p_action = 'REVERT'[\s\S]*status = 'PENDING'/i);
    expect(sql).toMatch(/p_action = 'HOLD'[\s\S]*recovery_status = 'HELD'/i);
    expect(sql).toMatch(/recovery_status = 'ADOPTED' AND p_action = 'ADOPT'/i);
    expect(sql).toMatch(/recovery_status = 'REVERTED' AND p_action = 'REVERT'/i);
    expect(sql).toMatch(/recovery_status = 'PERSISTED' AND p_action = 'PERSISTED'/i);
    expect(sql).toMatch(/p_action = 'REVERT'[\s\S]*finalized_size <> cohort_size/i);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.resolve_anchor_txid_journal/i);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.resolve_anchor_txid_journal[\s\S]*TO service_role/i);
    expect(sql).toMatch(/ROLLBACK[\s\S]*DROP FUNCTION IF EXISTS public\.resolve_anchor_txid_journal/i);
    expect(sql).toMatch(/ROLLBACK[\s\S]*DROP TABLE IF EXISTS public\.anchor_txid_journal/i);
  });
});

describe('SCRUM-2692 scheduled recovery ordering', () => {
  it('reconciles durable journals before invoking generic stale recovery', () => {
    const source = readFileSync(new URL('./broadcast-recovery.ts', import.meta.url), 'utf8');
    const journalIndex = source.indexOf('reconcileTxidJournals(');
    const genericIndex = source.indexOf("'recover_stuck_broadcasts'");

    expect(journalIndex).toBeGreaterThan(-1);
    expect(genericIndex).toBeGreaterThan(journalIndex);
  });

  it('keeps the manual fallback fail-closed around unresolved journal anchor ids', () => {
    const source = readFileSync(new URL('./broadcast-recovery.ts', import.meta.url), 'utf8');

    expect(source).toContain('loadProtectedJournalAnchorIds');
    expect(source).toContain('protectedAnchorIds.has(anchor.id)');
    expect(source).toContain('journal protection scan failed — refusing manual stale recovery');
    expect(source).toContain('(data ?? []).length >= 1000');
  });

  it('fails closed when journal protection cannot be loaded and rotates HELD work fairly', () => {
    const batchSource = readFileSync(new URL('./batch-anchor.ts', import.meta.url), 'utf8');
    const recoverySource = readFileSync(new URL('./broadcast-recovery.ts', import.meta.url), 'utf8');

    expect(batchSource).toContain('protectionLoaded: false');
    expect(batchSource).toContain(".order('recovery_status', { ascending: false })");
    expect(batchSource).toContain(".order('updated_at', { ascending: true })");
    expect(batchSource).toContain('TXID_JOURNAL_RECONCILE_LIMIT + 1');
    expect(batchSource).toContain('scanCapped');
    expect(batchSource).toContain('if (!journal.protectionLoaded) return result');
    expect(recoverySource).toContain('if (!journal.protectionLoaded)');
  });
});

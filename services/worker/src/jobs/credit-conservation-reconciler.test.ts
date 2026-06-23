/**
 * Tests for the money-conservation reconciler daily-sweep CALLER (S1-9,
 * parent SCRUM-2349 / PM-25).
 *
 * The reconciler LOGIC is the prod SQL function `org_credit_ledger_divergence`
 * (live via mig 0341, CORRECTED by mig 0344): it computes, per org, whether
 *   balance == purchased + monthly_allocation + net(org_credit_allocations)
 *              + SUM(org_credit_deductions.amount)
 * and flags `diverged = true` on any mismatch. Grants live in the `org_credits`
 * columns (purchased / monthly_allocation) plus net parent→child sub-org
 * allocations — NOT in the deduction ledger. (The original 0341 body compared
 * against a `p_initial_grant=0` scalar, which false-flagged every funded org;
 * 0344 sources the grant from the real columns and drops that arg.)
 *
 * This module is the daily caller that fires the function over ALL orgs, builds
 * a structured conservation report, and ALERTS on any drift (Sentry) so gate #11
 * SLO/alerting has a signal. Parent failure mode this guards: "the caller never
 * gets wired / drift goes unobserved."
 *
 * Two test layers, mirroring stuck-anchor-monitor.test.ts:
 *   1. decideCreditConservationAlert() — pure, no I/O.
 *   2. runCreditConservationReconciler(db) — cron glue; mocks callRpc + Sentry.
 *      The drift-injection test (a row with diverged=true must fire the alert)
 *      is the key proof the observation actually works.
 *
 * PII / §1.4: raw credit amounts are PII. When expected==0, divergence==balance,
 * so even the raw divergence value leaks the org balance. The caller must log +
 * alert with org_id + a COARSE divergence BUCKET ('0' | '±1-9' | '±10-99' |
 * '±100-999' | '±1000+') only — never the raw balance / ledger_sum / granted /
 * expected / divergence numbers. These tests assert no raw-amount value leaks
 * into the Sentry `extra` payload or the structured logs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const mockCaptureCreditConservationAlert = vi.fn();
vi.mock('../utils/sentry.js', () => ({
  captureCreditConservationAlert: (...args: unknown[]) =>
    mockCaptureCreditConservationAlert(...args),
}));

const mockCallRpc = vi.fn();
vi.mock('../utils/rpc.js', () => ({
  callRpc: (...args: unknown[]) => mockCallRpc(...args),
}));

import {
  decideCreditConservationAlert,
  runCreditConservationReconciler,
  bucketDivergence,
  CREDIT_LEDGER_DIVERGENCE_RPC,
  type DivergenceRow,
} from './credit-conservation-reconciler.js';
import { logger } from '../utils/logger.js';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

/**
 * Build a divergence row that satisfies the REAL invariant by construction:
 *   expected   = granted + ledger_sum
 *   divergence = balance - expected
 *   diverged   = balance != expected
 * Override `balance` to inject a real drift (the row then derives divergence +
 * diverged consistently, exactly as the SQL function would).
 */
function row(o: {
  org_id?: string;
  balance: number;
  granted?: number;
  ledger_sum?: number;
}): DivergenceRow {
  const granted = o.granted ?? 0;
  const ledgerSum = o.ledger_sum ?? 0;
  const expected = granted + ledgerSum;
  const divergence = o.balance - expected;
  return {
    org_id: o.org_id ?? ORG_A,
    balance: o.balance,
    granted,
    ledger_sum: ledgerSum,
    expected,
    divergence,
    diverged: divergence !== 0,
  };
}

/**
 * The 5 live-prod orgs (vzwyaatejekddvltxyye, 2026-06-23). The REAL invariant
 * `balance == purchased + monthly_allocation + net_alloc + SUM(ledger)` holds
 * for every one of them — none should ever flag under the 0344 function. With
 * the OLD p_initial_grant=0 function the 3 funded orgs (50/10/5) false-flagged.
 */
const PROD_ORGS: DivergenceRow[] = [
  // balance=50, purchased=0, monthly_allocation=50 → granted=50
  row({ org_id: '00000000-0000-0000-0000-0000000000a1', balance: 50, granted: 50 }),
  // balance=10, purchased=10, monthly_allocation=0 → granted=10
  row({ org_id: '00000000-0000-0000-0000-0000000000a2', balance: 10, granted: 10 }),
  // balance=5, purchased=5 → granted=5
  row({ org_id: '00000000-0000-0000-0000-0000000000a3', balance: 5, granted: 5 }),
  // balance=0, all 0
  row({ org_id: '00000000-0000-0000-0000-0000000000a4', balance: 0, granted: 0 }),
  row({ org_id: '00000000-0000-0000-0000-0000000000a5', balance: 0, granted: 0 }),
];

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// bucketDivergence — coarse PII-safe magnitude bucket
// ─────────────────────────────────────────────────────────────────────────────

describe('bucketDivergence', () => {
  it('maps zero to "0" with no sign', () => {
    expect(bucketDivergence(0)).toBe('0');
  });

  it('buckets by magnitude order, preserving sign', () => {
    expect(bucketDivergence(1)).toBe('+1-9');
    expect(bucketDivergence(9)).toBe('+1-9');
    expect(bucketDivergence(10)).toBe('+10-99');
    expect(bucketDivergence(99)).toBe('+10-99');
    expect(bucketDivergence(100)).toBe('+100-999');
    expect(bucketDivergence(999)).toBe('+100-999');
    expect(bucketDivergence(1000)).toBe('+1000+');
    expect(bucketDivergence(50_000)).toBe('+1000+');
  });

  it('preserves a negative sign across every band', () => {
    expect(bucketDivergence(-1)).toBe('-1-9');
    expect(bucketDivergence(-9)).toBe('-1-9');
    expect(bucketDivergence(-10)).toBe('-10-99');
    expect(bucketDivergence(-100)).toBe('-100-999');
    expect(bucketDivergence(-1000)).toBe('-1000+');
  });

  it('never returns the raw number for an exact-balance leak case (expected==0 → divergence==balance)', () => {
    // The C2 leak: a funded org with expected==0 would have divergence==balance.
    // The bucket must NOT echo that balance back.
    expect(bucketDivergence(5)).toBe('+1-9'); // not "5"
    expect(bucketDivergence(50)).toBe('+10-99'); // not "50"
    expect(bucketDivergence(1234)).toBe('+1000+'); // not "1234"
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: pure decision function
// ─────────────────────────────────────────────────────────────────────────────

describe('decideCreditConservationAlert', () => {
  it('does not fire across the 5 live-prod orgs (real invariant holds for all)', () => {
    const decision = decideCreditConservationAlert(PROD_ORGS);
    expect(decision.should_fire).toBe(false);
    expect(decision.diverged_count).toBe(0);
    expect(decision.orgs_checked).toBe(5);
    expect(decision.diverged_orgs).toEqual([]);
    expect(decision.reason).toMatch(/conserv/i);
  });

  it('does not fire when no rows diverged', () => {
    const decision = decideCreditConservationAlert([
      row({ org_id: ORG_A, balance: 100, granted: 100 }),
      row({ org_id: ORG_B, balance: 100, granted: 60, ledger_sum: 40 }),
    ]);
    expect(decision.should_fire).toBe(false);
    expect(decision.diverged_count).toBe(0);
    expect(decision.orgs_checked).toBe(2);
    expect(decision.diverged_orgs).toEqual([]);
  });

  it('does not fire on an empty result set (no orgs)', () => {
    const decision = decideCreditConservationAlert([]);
    expect(decision.should_fire).toBe(false);
    expect(decision.diverged_count).toBe(0);
    expect(decision.orgs_checked).toBe(0);
  });

  it('fires when at least one row diverged (REAL drift: balance=100 vs granted+ledger=90)', () => {
    const decision = decideCreditConservationAlert([
      row({ org_id: ORG_A, balance: 100, granted: 100 }),
      // granted 80 + ledger 10 = 90 expected, but balance is 100 → +10 drift
      row({ org_id: ORG_B, balance: 100, granted: 80, ledger_sum: 10 }),
    ]);
    expect(decision.should_fire).toBe(true);
    expect(decision.severity).toBe('error');
    expect(decision.diverged_count).toBe(1);
    expect(decision.orgs_checked).toBe(2);
    expect(decision.reason).toMatch(/divergen|conserv/i);
  });

  it('summarizes each diverged org as {org_id, divergence_bucket} — never the raw balances or raw divergence', () => {
    const decision = decideCreditConservationAlert([
      // expected 100, balance 95 → -5 → bucket "-1-9"
      row({ org_id: ORG_A, balance: 95, granted: 100 }),
      // expected 100, balance 107 → +7 → bucket "+1-9"
      row({ org_id: ORG_B, balance: 107, granted: 100 }),
    ]);
    expect(decision.diverged_count).toBe(2);
    const a = decision.diverged_orgs.find((o) => o.org_id === ORG_A);
    const b = decision.diverged_orgs.find((o) => o.org_id === ORG_B);
    expect(a).toEqual({ org_id: ORG_A, divergence_bucket: '-1-9' });
    expect(b).toEqual({ org_id: ORG_B, divergence_bucket: '+1-9' });
    for (const o of decision.diverged_orgs) {
      expect(o).not.toHaveProperty('balance');
      expect(o).not.toHaveProperty('ledger_sum');
      expect(o).not.toHaveProperty('granted');
      expect(o).not.toHaveProperty('expected');
      expect(o).not.toHaveProperty('divergence');
    }
  });

  it('counts only diverged rows even when many orgs are balanced', () => {
    const rows: DivergenceRow[] = [];
    for (let i = 0; i < 50; i++) {
      rows.push(row({ org_id: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`, balance: 100, granted: 100 }));
    }
    // expected 100, balance 97 → -3 drift
    rows.push(row({ org_id: ORG_A, balance: 97, granted: 100 }));
    const decision = decideCreditConservationAlert(rows);
    expect(decision.orgs_checked).toBe(51);
    expect(decision.diverged_count).toBe(1);
    expect(decision.should_fire).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: cron-glue entry point (RPC + Sentry mocked)
// ─────────────────────────────────────────────────────────────────────────────

describe('runCreditConservationReconciler', () => {
  const fakeDb = {} as never;

  it('PROD SHAPE: the 5 live-prod orgs all reconcile → healthy, no alert', async () => {
    mockCallRpc.mockResolvedValue({ data: PROD_ORGS, error: null });

    const result = await runCreditConservationReconciler(fakeDb);

    expect(result.healthy).toBe(true);
    expect(result.alertFired).toBe(false);
    expect(result.divergedCount).toBe(0);
    expect(result.orgsChecked).toBe(5);
    expect(mockCaptureCreditConservationAlert).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('calls org_credit_ledger_divergence over all orgs (no org filter arg → SQL DEFAULT NULL)', async () => {
    mockCallRpc.mockResolvedValue({ data: [row({ balance: 0, granted: 0 })], error: null });

    await runCreditConservationReconciler(fakeDb);

    expect(mockCallRpc).toHaveBeenCalledTimes(1);
    const [, fnName, args] = mockCallRpc.mock.calls[0];
    expect(fnName).toBe(CREDIT_LEDGER_DIVERGENCE_RPC);
    expect(fnName).toBe('org_credit_ledger_divergence');
    // All-orgs sweep → arg-less call. After 0344 the function is (uuid DEFAULT
    // NULL); an arg-less RPC maps to it and p_org_id keeps its SQL DEFAULT NULL.
    // We MUST NOT pass p_initial_grant (removed in 0344).
    expect(args === undefined || (args.p_org_id == null && !('p_initial_grant' in args))).toBe(true);
  });

  it('DRIFT INJECTION: a REAL diverged row (balance=100 vs granted+ledger=90) fires the alert path', async () => {
    // The key proof. Inject a deliberate divergence and assert the caller
    // DETECTS it and fires the Sentry alert (the parent PM-25 fear is that
    // drift goes unobserved).
    mockCallRpc.mockResolvedValue({
      data: [
        row({ org_id: ORG_A, balance: 100, granted: 100 }),
        row({ org_id: ORG_B, balance: 100, granted: 80, ledger_sum: 10 }),
      ],
      error: null,
    });

    const result = await runCreditConservationReconciler(fakeDb);

    expect(result.healthy).toBe(false);
    expect(result.alertFired).toBe(true);
    expect(result.divergedCount).toBe(1);
    expect(result.orgsChecked).toBe(2);

    // Sentry alert fired exactly once, at error level.
    expect(mockCaptureCreditConservationAlert).toHaveBeenCalledTimes(1);
    const [message, , level] = mockCaptureCreditConservationAlert.mock.calls[0];
    expect(typeof message).toBe('string');
    expect(message).toMatch(/divergen|conserv/i);
    expect(level).toBe('error');

    // Drift is also logged at error level so Cloud Logging surfaces it.
    expect(logger.error).toHaveBeenCalled();
  });

  it('PII: Sentry payload carries org_id + coarse bucket only — no raw balance/ledger/granted/expected/divergence', async () => {
    // Funded org with expected==0 → divergence==balance (the C2 leak class).
    // balance=500, granted=0, ledger=0 → expected 0, divergence 500.
    mockCallRpc.mockResolvedValue({
      data: [row({ org_id: ORG_B, balance: 500, granted: 0, ledger_sum: 0 })],
      error: null,
    });

    await runCreditConservationReconciler(fakeDb);

    expect(mockCaptureCreditConservationAlert).toHaveBeenCalledTimes(1);
    const [message, extra] = mockCaptureCreditConservationAlert.mock.calls[0];
    const extraSerialized = JSON.stringify(extra);
    // No raw credit AMOUNT leaks anywhere (extra OR the human-readable message):
    // balance==divergence==500 here, and the bucket must not echo it.
    const all = extraSerialized + String(message);
    expect(all).not.toContain('500'); // the leaked balance / divergence number
    // The structured `extra` payload (the part that would carry leaked DATA)
    // must not contain any raw-amount FIELD. (The message string legitimately
    // describes the invariant in prose — "balance == granted + ..." — so we do
    // not keyword-scan it for field names, only for raw numbers above.)
    expect(extraSerialized).not.toContain('balance');
    expect(extraSerialized).not.toContain('ledger_sum');
    expect(extraSerialized).not.toContain('granted');
    expect(extraSerialized).not.toContain('expected');
    // No raw `divergence` number field — only the coarse bucket survives.
    expect(extraSerialized).not.toContain('"divergence"');
    expect(extraSerialized).toContain('divergence_bucket');
    expect(extraSerialized).toContain('+100-999'); // bucket for 500
    // org_id + aggregate count are allowed (not PII).
    expect(extraSerialized).toContain(ORG_B);
    expect(extraSerialized).toContain('diverged_count');
  });

  it('PII: structured ERROR log carries org_id + bucket only — no raw balance/divergence', async () => {
    mockCallRpc.mockResolvedValue({
      data: [row({ org_id: ORG_B, balance: 777, granted: 0, ledger_sum: 0 })],
      error: null,
    });

    await runCreditConservationReconciler(fakeDb);

    expect(logger.error).toHaveBeenCalled();
    // Inspect every error-log call's structured context object.
    for (const call of (logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('777'); // the leaked balance / divergence
      expect(serialized).not.toContain('ledger_sum');
      expect(serialized).not.toContain('"divergence"');
      expect(serialized).not.toContain('"balance"');
      expect(serialized).not.toContain('"granted"');
      expect(serialized).not.toContain('"expected"');
    }
  });

  it('BALANCED LEDGER: no diverged rows → clean report, NO alert', async () => {
    mockCallRpc.mockResolvedValue({
      data: [
        row({ org_id: ORG_A, balance: 100, granted: 100 }),
        row({ org_id: ORG_B, balance: 40, granted: 0, ledger_sum: 40 }),
      ],
      error: null,
    });

    const result = await runCreditConservationReconciler(fakeDb);

    expect(result.healthy).toBe(true);
    expect(result.alertFired).toBe(false);
    expect(result.divergedCount).toBe(0);
    expect(result.orgsChecked).toBe(2);
    expect(mockCaptureCreditConservationAlert).not.toHaveBeenCalled();
    // A clean run logs at info, not error.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('BALANCED LEDGER: empty result set is healthy with no alert', async () => {
    mockCallRpc.mockResolvedValue({ data: [], error: null });

    const result = await runCreditConservationReconciler(fakeDb);

    expect(result.healthy).toBe(true);
    expect(result.alertFired).toBe(false);
    expect(result.orgsChecked).toBe(0);
    expect(mockCaptureCreditConservationAlert).not.toHaveBeenCalled();
  });

  it('is idempotent / safe to re-run: a second identical tick repeats the same read-only outcome and never writes', async () => {
    mockCallRpc.mockResolvedValue({
      data: [row({ org_id: ORG_B, balance: 95, granted: 100 })],
      error: null,
    });

    const first = await runCreditConservationReconciler(fakeDb);
    const second = await runCreditConservationReconciler(fakeDb);

    expect(second).toEqual(first);
    // Two ticks → two reads of the same RPC, never an insert/update/upsert.
    expect(mockCallRpc).toHaveBeenCalledTimes(2);
    for (const call of mockCallRpc.mock.calls) {
      expect(call[1]).toBe('org_credit_ledger_divergence');
    }
  });

  it('RPC error: surfaces error, does not crash, and reports unhealthy without a false "balanced" alert-clear', async () => {
    mockCallRpc.mockResolvedValue({
      data: null,
      error: { message: 'permission denied for function org_credit_ledger_divergence', code: '42501' },
    });

    const result = await runCreditConservationReconciler(fakeDb);

    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/permission denied/i);
    // A probe failure must NOT masquerade as a clean conservation report.
    expect(result.divergedCount).toBeNull();
    expect(logger.error).toHaveBeenCalled();
    // We do not fire the divergence alert on a probe failure (different signal),
    // but we also don't claim health.
    expect(mockCaptureCreditConservationAlert).not.toHaveBeenCalled();
  });

  it('RPC throws (callRpc rejects): caught, reported unhealthy, no crash', async () => {
    mockCallRpc.mockRejectedValue(new Error('network down'));

    const result = await runCreditConservationReconciler(fakeDb);

    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/network down/i);
    expect(logger.error).toHaveBeenCalled();
  });

  it('tolerates a non-array RPC payload without throwing (defensive)', async () => {
    mockCallRpc.mockResolvedValue({ data: { unexpected: 'shape' } as never, error: null });

    const result = await runCreditConservationReconciler(fakeDb);

    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/unexpected|shape|array/i);
    expect(mockCaptureCreditConservationAlert).not.toHaveBeenCalled();
  });
});

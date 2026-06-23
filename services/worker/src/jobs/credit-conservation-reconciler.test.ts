/**
 * Tests for the money-conservation reconciler daily-sweep CALLER (S1-9,
 * parent SCRUM-2349 / PM-25).
 *
 * The reconciler LOGIC is the prod SQL function `org_credit_ledger_divergence`
 * (live via mig 0341): it computes, per org, whether
 *   balance == initial_grant + SUM(org_credit_deductions.amount)
 * and flags `diverged = true` on any mismatch. This module is the daily caller
 * that fires the function over ALL orgs, builds a structured conservation
 * report, and ALERTS on any drift (Sentry) so gate #11 SLO/alerting has a
 * signal. Parent failure mode this guards: "the caller never gets wired / drift
 * goes unobserved."
 *
 * Two test layers, mirroring stuck-anchor-monitor.test.ts:
 *   1. decideCreditConservationAlert() — pure, no I/O.
 *   2. runCreditConservationReconciler(db) — cron glue; mocks callRpc + Sentry.
 *      The drift-injection test (a row with diverged=true must fire the alert)
 *      is the key proof the observation actually works.
 *
 * PII / §1.4: the caller must log + alert with org_id + divergence MAGNITUDE
 * only — never the raw balance / ledger_sum / expected credit amounts (raw
 * credit amounts are PII). These tests assert no raw-amount field leaks into
 * the Sentry `extra` payload.
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
  CREDIT_LEDGER_DIVERGENCE_RPC,
  type DivergenceRow,
} from './credit-conservation-reconciler.js';
import { logger } from '../utils/logger.js';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

function row(overrides: Partial<DivergenceRow> = {}): DivergenceRow {
  return {
    org_id: ORG_A,
    balance: 100,
    ledger_sum: 100,
    expected: 100,
    divergence: 0,
    diverged: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: pure decision function
// ─────────────────────────────────────────────────────────────────────────────

describe('decideCreditConservationAlert', () => {
  it('does not fire when no rows diverged', () => {
    const decision = decideCreditConservationAlert([
      row({ org_id: ORG_A, diverged: false }),
      row({ org_id: ORG_B, diverged: false }),
    ]);
    expect(decision.should_fire).toBe(false);
    expect(decision.diverged_count).toBe(0);
    expect(decision.orgs_checked).toBe(2);
    expect(decision.diverged_orgs).toEqual([]);
    expect(decision.reason).toMatch(/conserv/i);
  });

  it('does not fire on an empty result set (no orgs)', () => {
    const decision = decideCreditConservationAlert([]);
    expect(decision.should_fire).toBe(false);
    expect(decision.diverged_count).toBe(0);
    expect(decision.orgs_checked).toBe(0);
  });

  it('fires when at least one row diverged', () => {
    const decision = decideCreditConservationAlert([
      row({ org_id: ORG_A, diverged: false }),
      row({ org_id: ORG_B, balance: 95, ledger_sum: 100, expected: 100, divergence: -5, diverged: true }),
    ]);
    expect(decision.should_fire).toBe(true);
    expect(decision.severity).toBe('error');
    expect(decision.diverged_count).toBe(1);
    expect(decision.orgs_checked).toBe(2);
    expect(decision.reason).toMatch(/divergen|conserv/i);
  });

  it('reports divergence MAGNITUDE per org, never the raw balances', () => {
    const decision = decideCreditConservationAlert([
      row({ org_id: ORG_A, balance: 95, ledger_sum: 100, expected: 100, divergence: -5, diverged: true }),
      row({ org_id: ORG_B, balance: 107, ledger_sum: 100, expected: 100, divergence: 7, diverged: true }),
    ]);
    expect(decision.diverged_count).toBe(2);
    // Each diverged org is summarized as {org_id, divergence} only — the raw
    // balance / ledger_sum / expected credit amounts (PII) are NOT carried.
    const a = decision.diverged_orgs.find((o) => o.org_id === ORG_A);
    const b = decision.diverged_orgs.find((o) => o.org_id === ORG_B);
    expect(a).toEqual({ org_id: ORG_A, divergence: -5 });
    expect(b).toEqual({ org_id: ORG_B, divergence: 7 });
    for (const o of decision.diverged_orgs) {
      expect(o).not.toHaveProperty('balance');
      expect(o).not.toHaveProperty('ledger_sum');
      expect(o).not.toHaveProperty('expected');
    }
  });

  it('counts only diverged rows even when many orgs are balanced', () => {
    const rows: DivergenceRow[] = [];
    for (let i = 0; i < 50; i++) {
      rows.push(row({ org_id: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}` }));
    }
    rows.push(row({ org_id: ORG_A, divergence: -3, diverged: true }));
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

  it('calls org_credit_ledger_divergence over all orgs (no org filter arg)', async () => {
    mockCallRpc.mockResolvedValue({ data: [row()], error: null });

    await runCreditConservationReconciler(fakeDb);

    expect(mockCallRpc).toHaveBeenCalledTimes(1);
    const [, fnName, args] = mockCallRpc.mock.calls[0];
    expect(fnName).toBe(CREDIT_LEDGER_DIVERGENCE_RPC);
    expect(fnName).toBe('org_credit_ledger_divergence');
    // All-orgs sweep → p_org_id stays NULL (function default). We pass no
    // org filter so the SQL DEFAULT NULL applies.
    expect(args === undefined || args.p_org_id == null).toBe(true);
  });

  it('DRIFT INJECTION: a diverged=true row fires the alert path', async () => {
    // The key proof. Inject a deliberate divergence and assert the caller
    // DETECTS it and fires the Sentry alert (the parent PM-25 fear is that
    // drift goes unobserved).
    mockCallRpc.mockResolvedValue({
      data: [
        row({ org_id: ORG_A, diverged: false }),
        row({ org_id: ORG_B, balance: 95, ledger_sum: 100, expected: 100, divergence: -5, diverged: true }),
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

  it('DRIFT INJECTION: Sentry payload carries org_id + magnitude only — no raw amounts (PII)', async () => {
    mockCallRpc.mockResolvedValue({
      data: [
        row({ org_id: ORG_B, balance: 9_999, ledger_sum: 10_000, expected: 10_000, divergence: -1, diverged: true }),
      ],
      error: null,
    });

    await runCreditConservationReconciler(fakeDb);

    expect(mockCaptureCreditConservationAlert).toHaveBeenCalledTimes(1);
    const [, extra] = mockCaptureCreditConservationAlert.mock.calls[0];
    // Serialize the whole alert context and assert the raw credit amounts
    // (balance / ledger_sum / expected) never appear anywhere in it.
    const serialized = JSON.stringify(extra);
    expect(serialized).not.toContain('9999');
    expect(serialized).not.toContain('10000');
    expect(serialized).not.toContain('balance');
    expect(serialized).not.toContain('ledger_sum');
    expect(serialized).not.toContain('expected');
    // The divergence magnitude IS allowed (it's the alert signal, not PII).
    expect(serialized).toContain('divergence');
  });

  it('BALANCED LEDGER: no diverged rows → clean report, NO alert', async () => {
    mockCallRpc.mockResolvedValue({
      data: [
        row({ org_id: ORG_A, diverged: false }),
        row({ org_id: ORG_B, diverged: false }),
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
      data: [row({ org_id: ORG_B, divergence: -5, diverged: true })],
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

/**
 * SCRUM-2906 R1 — tests for the parallel-rig reservation-ledger validator.
 *
 * TDD: the double-booking fixtures below reproduce the collision that
 * contaminates parallel soaks (two active reservations on one Cloud Run service
 * or one Supabase project). Each must fail its OWN rule; the scaffold's
 * example-only ledger must pass.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  validateLedger,
  formatReport,
  main,
  type Ledger,
  type Reservation,
} from './check-rig-reservations.js';

function activeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    reservation_id: `resv-${Math.random().toString(36).slice(2, 8)}`,
    status: 'active',
    rail: 'rail-a',
    tier: 'T3',
    rig: {
      cloud_run_service: 'arkova-worker-rail-a-staging',
      supabase_ref: 'refaaaaaaaaaaaaaaaaaa',
      region: 'us-central1',
    },
    ...overrides,
  };
}

describe('validateLedger — healthy', () => {
  it('passes when active reservations use distinct services and refs', () => {
    const ledger: Ledger = {
      version: 1,
      reservations: [
        activeReservation({
          reservation_id: 'resv-a',
          rig: { cloud_run_service: 'svc-a', supabase_ref: 'refa0000000000000000' },
        }),
        activeReservation({
          reservation_id: 'resv-b',
          rig: { cloud_run_service: 'svc-b', supabase_ref: 'refb0000000000000000' },
        }),
      ],
    };
    const report = validateLedger(ledger);
    expect(report.ok).toBe(true);
    expect(report.activeCount).toBe(2);
    expect(report.findings).toHaveLength(0);
  });

  it('ignores example and released rows entirely', () => {
    const ledger: Ledger = {
      version: 1,
      reservations: [
        { reservation_id: 'ex', status: 'example', rig: { cloud_run_service: 'svc', supabase_ref: 'ref' } },
        { reservation_id: 'old', status: 'released', rig: { cloud_run_service: 'svc', supabase_ref: 'ref' } },
      ],
    };
    const report = validateLedger(ledger);
    expect(report.ok).toBe(true);
    expect(report.activeCount).toBe(0);
  });
});

describe('validateLedger — double-booking', () => {
  it('FAILS when two active reservations share a Cloud Run service', () => {
    const ledger: Ledger = {
      version: 1,
      reservations: [
        activeReservation({
          reservation_id: 'resv-a',
          rig: { cloud_run_service: 'svc-shared', supabase_ref: 'refa0000000000000000' },
        }),
        activeReservation({
          reservation_id: 'resv-b',
          rig: { cloud_run_service: 'svc-shared', supabase_ref: 'refb0000000000000000' },
        }),
      ],
    };
    const report = validateLedger(ledger);
    expect(report.ok).toBe(false);
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toContain('double-booked-cloud-run-service');
    expect(report.findings.find((f) => f.rule === 'double-booked-cloud-run-service')?.message)
      .toMatch(/resv-a.*resv-b|resv-b.*resv-a/);
  });

  it('FAILS when two active reservations share a Supabase project ref', () => {
    const ledger: Ledger = {
      version: 1,
      reservations: [
        activeReservation({
          reservation_id: 'resv-a',
          rig: { cloud_run_service: 'svc-a', supabase_ref: 'refshared00000000000' },
        }),
        activeReservation({
          reservation_id: 'resv-b',
          rig: { cloud_run_service: 'svc-b', supabase_ref: 'refshared00000000000' },
        }),
      ],
    };
    const report = validateLedger(ledger);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.rule)).toContain('double-booked-supabase-ref');
  });

  it('does NOT flag an example row that reuses an active row service/ref', () => {
    const ledger: Ledger = {
      version: 1,
      reservations: [
        activeReservation({
          reservation_id: 'resv-a',
          rig: { cloud_run_service: 'svc', supabase_ref: 'ref00000000000000000' },
        }),
        { reservation_id: 'ex', status: 'example', rig: { cloud_run_service: 'svc', supabase_ref: 'ref00000000000000000' } },
      ],
    };
    expect(validateLedger(ledger).ok).toBe(true);
  });
});

describe('validateLedger — malformed active rows', () => {
  it('FAILS when an active reservation is missing cloud_run_service', () => {
    const ledger: Ledger = {
      version: 1,
      reservations: [activeReservation({ rig: { supabase_ref: 'refa0000000000000000' } })],
    };
    const report = validateLedger(ledger);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.rule)).toContain('active-required-field');
    expect(report.findings[0].message).toMatch(/cloud_run_service/);
  });

  it('FAILS when an active reservation is missing supabase_ref', () => {
    const ledger: Ledger = {
      version: 1,
      reservations: [activeReservation({ rig: { cloud_run_service: 'svc-a' } })],
    };
    expect(validateLedger(ledger).ok).toBe(false);
  });

  it('FAILS on duplicate reservation_id across any rows', () => {
    const ledger: Ledger = {
      version: 1,
      reservations: [
        activeReservation({ reservation_id: 'dup', rig: { cloud_run_service: 'svc-a', supabase_ref: 'refa0000000000000000' } }),
        { reservation_id: 'dup', status: 'released' },
      ],
    };
    const report = validateLedger(ledger);
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.rule)).toContain('duplicate-reservation-id');
  });

  it('FAILS when the ledger has no reservations array', () => {
    // @ts-expect-error deliberately malformed
    const report = validateLedger({ version: 1 });
    expect(report.ok).toBe(false);
    expect(report.findings[0].rule).toBe('ledger-shape');
  });
});

describe('formatReport', () => {
  it('renders a clean line when consistent', () => {
    const out = formatReport(validateLedger({ version: 1, reservations: [] }));
    expect(out).toMatch(/No double-booking/);
  });

  it('renders a CI ::error:: line when a rule fails', () => {
    const ledger: Ledger = {
      version: 1,
      reservations: [
        activeReservation({ reservation_id: 'a', rig: { cloud_run_service: 's', supabase_ref: 'r' } }),
        activeReservation({ reservation_id: 'b', rig: { cloud_run_service: 's', supabase_ref: 'r' } }),
      ],
    };
    expect(formatReport(validateLedger(ledger))).toMatch(/::error::/);
  });
});

describe('main (CLI) + committed scaffold', () => {
  it('returns exit code 2 when the ledger file cannot be read', () => {
    expect(main(['/nonexistent/rig-reservations.json'])).toBe(2);
  });

  it('the committed docs/staging/rig-reservations.json scaffold is valid (example-only → passes)', () => {
    const path = resolve(__dirname, '../../docs/staging/rig-reservations.json');
    const ledger: Ledger = JSON.parse(readFileSync(path, 'utf8'));
    const report = validateLedger(ledger);
    expect(report.ok).toBe(true);
    expect(report.activeCount).toBe(0);
  });
});

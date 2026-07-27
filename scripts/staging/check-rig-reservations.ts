#!/usr/bin/env -S npx tsx
/**
 * SCRUM-2906 R1 — parallel-rig reservation-ledger validator.
 *
 * A parallel-soak program stands up MULTIPLE isolated staging rigs at once. The
 * recurring failure mode is a double-booking: two sessions reserve the same
 * Cloud Run service or the same Supabase project, and one silently writes into
 * a rig another session is mid-soak on — contaminating the evidence
 * (`feedback_no_live_soak_rig_as_validation_target`,
 * `feedback_dont_touch_soaking_prs`). Cloud Run tag URLs isolate worker
 * revisions only; the Supabase project ref is the real isolation boundary
 * (CLAUDE.md §1.11A), so BOTH must be unique across active reservations.
 *
 * This validator reads `docs/staging/rig-reservations.json` and fails (exit 1)
 * on any double-booking or malformed ACTIVE row. It is a scaffold check — it
 * stands up nothing, touches no rig, and reads only the ledger file. Rows with
 * `status: "example"` are ignored (they document the shape).
 *
 * Design-only per SCRUM-2906 (NO live rigs). Not wired as a gating CI job under
 * the PI-0.5 W3 freeze; run manually:
 *   npx tsx scripts/staging/check-rig-reservations.ts [path]
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export type ReservationStatus = 'active' | 'released' | 'example';

export interface RigDescriptor {
  cloud_run_service?: string;
  supabase_ref?: string;
  region?: string;
  tag_url?: string;
}

export interface Reservation {
  reservation_id?: string;
  status?: ReservationStatus;
  rail?: string;
  tier?: string;
  rig?: RigDescriptor;
  pr?: number | string | null;
  pr_head_sha?: string | null;
  soak?: { start?: string | null; end?: string | null };
  owner?: string;
  [k: string]: unknown;
}

export interface Ledger {
  version?: number;
  updated?: string;
  reservations?: Reservation[];
}

export interface LedgerFinding {
  /** Stable identifier for the rule that produced the finding. */
  rule: string;
  severity: 'error';
  message: string;
}

export interface LedgerReport {
  ok: boolean;
  activeCount: number;
  findings: LedgerFinding[];
}

/**
 * Required fields for an ACTIVE reservation. A rig you are actively soaking on
 * must be fully identified so no parallel session can collide with it and so
 * its evidence is attributable (CLAUDE.md §1.11A isolated-evidence identity).
 */
const REQUIRED_ACTIVE_FIELDS: Array<{ path: string; get: (r: Reservation) => unknown }> = [
  { path: 'reservation_id', get: (r) => r?.reservation_id },
  { path: 'rail', get: (r) => r?.rail },
  { path: 'rig.cloud_run_service', get: (r) => r?.rig?.cloud_run_service },
  { path: 'rig.supabase_ref', get: (r) => r?.rig?.supabase_ref },
];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Validate a parsed ledger. Pure function — no I/O. Only `status: "active"`
 * rows participate in double-booking and required-field checks; `example` and
 * `released` rows are inert.
 */
export function validateLedger(ledger: Ledger): LedgerReport {
  const findings: LedgerFinding[] = [];
  const reservations = Array.isArray(ledger?.reservations) ? ledger.reservations : [];

  if (!Array.isArray(ledger?.reservations)) {
    findings.push({
      rule: 'ledger-shape',
      severity: 'error',
      message:
        'Ledger has no `reservations` array. Expected { "version", "reservations": [...] }.',
    });
    return { ok: false, activeCount: 0, findings };
  }

  const active = reservations.filter((r) => r?.status === 'active');

  // 1. Required-field completeness for active rows.
  for (const r of active) {
    for (const field of REQUIRED_ACTIVE_FIELDS) {
      if (!isNonEmptyString(field.get(r))) {
        findings.push({
          rule: 'active-required-field',
          severity: 'error',
          message:
            `Active reservation "${r.reservation_id ?? '<no id>'}" is missing ` +
            `required field \`${field.path}\`. An active rig must be fully ` +
            `identified so no parallel session can collide with it.`,
        });
      }
    }
  }

  // 2. No two active reservations share a Cloud Run service.
  collectDuplicates(
    active,
    (r) => r.rig?.cloud_run_service,
    (value, ids) =>
      findings.push({
        rule: 'double-booked-cloud-run-service',
        severity: 'error',
        message:
          `Cloud Run service "${value}" is double-booked by active ` +
          `reservations [${ids.join(', ')}]. One rig = one concurrent soak; ` +
          `stand up a distinct service per rail.`,
      }),
  );

  // 3. No two active reservations share a Supabase project ref (the real
  //    isolation boundary — tag URLs do NOT isolate schema/queues/ledger rows).
  collectDuplicates(
    active,
    (r) => r.rig?.supabase_ref,
    (value, ids) =>
      findings.push({
        rule: 'double-booked-supabase-ref',
        severity: 'error',
        message:
          `Supabase project ref "${value}" is double-booked by active ` +
          `reservations [${ids.join(', ')}]. Cloud Run tag URLs isolate worker ` +
          `revisions only; the Supabase ref is the isolation boundary ` +
          `(CLAUDE.md §1.11A) and must be unique per active reservation.`,
      }),
  );

  // 4. reservation_id uniqueness across ALL rows (active + released + example),
  //    so history stays addressable.
  collectDuplicates(
    reservations,
    (r) => r.reservation_id,
    (value, _ids) =>
      findings.push({
        rule: 'duplicate-reservation-id',
        severity: 'error',
        message: `reservation_id "${value}" appears more than once — ids must be unique.`,
      }),
  );

  return { ok: findings.length === 0, activeCount: active.length, findings };
}

/** Group rows by a string key and invoke `onDup` once per key seen >1 time. */
function collectDuplicates(
  rows: Reservation[],
  keyOf: (r: Reservation) => unknown,
  onDup: (value: string, ids: string[]) => void,
): void {
  const byKey = new Map<string, string[]>();
  for (const r of rows) {
    if (r === null || typeof r !== 'object') continue;
    const key = keyOf(r);
    if (!isNonEmptyString(key)) continue;
    const ids = byKey.get(key) ?? [];
    ids.push(r.reservation_id ?? '<no id>');
    byKey.set(key, ids);
  }
  for (const [value, ids] of byKey) {
    if (ids.length > 1) onDup(value, ids);
  }
}

export function formatReport(report: LedgerReport): string {
  const lines: string[] = [
    `Rig-reservation ledger check (SCRUM-2906): ${report.activeCount} active reservation(s).`,
    '',
  ];
  if (report.ok) {
    lines.push('✅ No double-booking or malformed active rows — parallel-rig ledger is consistent.');
    return lines.join('\n');
  }
  for (const f of report.findings) {
    lines.push(`  ❌ [${f.rule}] ${f.message}`);
  }
  lines.push('');
  lines.push('::error::Rig-reservation ledger has double-booking / malformed active rows — resolve before standing up or soaking any rig.');
  return lines.join('\n');
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const path = argv.find((a) => !a.startsWith('--')) ?? 'docs/staging/rig-reservations.json';
  let ledger: Ledger;
  try {
    ledger = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`::error::Failed to read/parse rig-reservations ledger "${path}": ${msg}`);
    return 2;
  }
  const report = validateLedger(ledger);
  console.log(formatReport(report));
  return report.ok ? 0 : 1;
}

function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && resolve(fileURLToPath(metaUrl)) === resolve(argvPath);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(main());
}

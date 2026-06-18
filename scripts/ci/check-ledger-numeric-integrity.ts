#!/usr/bin/env -S npx tsx
/**
 * SCRUM-2500 / S0-4.2 — Full-ledger numeric-integrity CI audit.
 *
 * WHY: the migration-drift gate (.github/workflows/migration-drift.yml) only
 * inspects the migrations CHANGED in a PR diff. On 2026-06-15 a Supabase MCP
 * `apply_migration` silently re-regressed 7 prod ledger rows back to
 * timestamp-format `version`s; because no PR touched those files, nothing
 * failed and the drift was found by a human, not CI. This audit closes that
 * gap by validating the ENTIRE ledger, every run:
 *
 *   - prod ledger rows (read-only fetch in CI): a row whose `name` is a numeric
 *     Arkova migration (`^NNNN_`) MUST carry a numeric `version` (`^NNNN$`),
 *     never a 14-digit timestamp or a `timestamp_NNNN_...` composite. No
 *     duplicate names or versions.
 *   - local files (network-free): every `supabase/migrations/*.sql` filename
 *     must be the Path-C baseline, a numeric `NNNN_` prefix, or a grandfathered
 *     lettered-suffix variant (`0055b_`). No new numeric-prefix collisions
 *     (reusing the SCRUM-1287 grandfather baseline).
 *
 * Fail-closed contract (pre-mortem P1): a *configured-but-unreadable* Supabase
 * token is a hard failure (mirrors migration-drift.yml). A *missing* token in
 * CI runs the local-file pass and emits an explicit "ledger pass skipped"
 * notice — never a silent green for the ledger pass.
 *
 * Runbook: docs/runbooks/migration-drift-playbook.md
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { isMainModule } from './lib/ciContext.js';

const REPO = process.env.LEDGER_AUDIT_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations');
const PREFIX_BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'migration-prefix-baseline.json');
const LEDGER_EXEMPTIONS_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'ledger-numeric-exemptions.json');
const BASELINE_FILE = '00000000000000_baseline_at_main_HEAD.sql';

export interface LedgerRow {
  version: string;
  name?: string | null;
}

export interface Violation {
  code: string;
  message: string;
}

/** A numeric Arkova migration name: `0322_bump_...`. */
const NUMERIC_NAME_RE = /^(\d{4})_/;
/** A clean numeric ledger version: exactly 4 digits. */
const NUMERIC_VERSION_RE = /^\d{4}$/;
/** Recognized local filenames: numeric `NNNN_`, lettered `NNNNb_`. */
const LOCAL_NUMERIC_RE = /^(\d{4})([a-z])?_/;

/**
 * Validate prod ledger rows for numeric-version integrity + duplicates.
 *
 * Only rows whose `name` looks like a numeric Arkova migration are required to
 * carry a numeric version — operator-applied names (e.g. the Path-C baseline,
 * `public_verification_revoked`) are left alone.
 *
 * `exemptPrefixes` is the documented-unreconciled backlog (mirrors the
 * migration-drift.yml exempt_regex). A row whose numeric name-prefix is exempt
 * is skipped entirely so the audit does not block CI on the known backlog —
 * while any NON-exempt numeric row that re-regresses to a timestamp version (or
 * a NEW duplicate) still fails. The exempt set shrinks to empty as prod
 * reconciliation lands (S0-4.2d).
 */
export function auditLedgerRows(
  rows: LedgerRow[],
  exemptPrefixes: Set<string> = new Set(),
): Violation[] {
  const violations: Violation[] = [];
  const seenNames = new Map<string, number>();
  const seenVersions = new Map<string, number>();

  for (const row of rows) {
    const name = row.name ?? '';
    const version = row.version ?? '';

    const prefix = name.match(NUMERIC_NAME_RE)?.[1];
    if (prefix && exemptPrefixes.has(prefix)) continue; // documented backlog (S0-4.2d)

    if (name) seenNames.set(name, (seenNames.get(name) ?? 0) + 1);
    if (version) seenVersions.set(version, (seenVersions.get(version) ?? 0) + 1);

    const m = name.match(NUMERIC_NAME_RE);
    if (m && !NUMERIC_VERSION_RE.test(version)) {
      violations.push({
        code: 'ledger-nonnumeric-version',
        message:
          `ledger row name="${name}" is a numeric migration (prefix ${m[1]}) but its ` +
          `version="${version}" is not a 4-digit numeric prefix. Reconcile per CLAUDE.md §0 rule 10 ` +
          `(operator-approved single ledger write).`,
      });
    }
  }

  for (const [name, count] of seenNames) {
    if (count > 1) {
      violations.push({
        code: 'ledger-duplicate-name',
        message: `ledger has ${count} rows with duplicate name="${name}" (SCRUM-2192 dup class).`,
      });
    }
  }
  for (const [version, count] of seenVersions) {
    if (count > 1) {
      violations.push({
        code: 'ledger-duplicate-version',
        message: `ledger has ${count} rows with duplicate version="${version}".`,
      });
    }
  }

  return violations;
}

/**
 * Validate local migration filenames for numeric-prefix grammar + collisions.
 * `files` are basenames (with or without the `.sql` extension).
 */
export function auditLocalFiles(files: string[], grandfathered: Set<string>): Violation[] {
  const violations: Violation[] = [];
  const byPrefix = new Map<string, string[]>();

  for (const raw of files) {
    const file = raw.endsWith('.sql') ? raw : `${raw}.sql`;
    if (file === BASELINE_FILE) continue;

    const numeric = file.match(LOCAL_NUMERIC_RE);
    if (numeric) {
      // Lettered-suffix variants (`0055b_`) are intentional correctives that
      // share a numeric prefix with their base — they do NOT count as
      // collisions (matches check-migration-prefix-uniqueness.ts semantics,
      // which only extracts a pure `\d{4,}_` run). Only bare NNNN_ files
      // participate in duplicate-prefix detection.
      if (numeric[2]) continue;
      const prefix = numeric[1];
      if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
      byPrefix.get(prefix)!.push(file);
      continue;
    }

    // No `NNNN_` prefix. Distinguish a 14-digit timestamp (the regression we
    // guard) from a genuinely malformed name.
    if (/^\d{13,}_/.test(file)) {
      violations.push({
        code: 'local-nonnumeric-prefix',
        message: `local migration "${file}" uses a timestamp prefix; Arkova migrations use numeric NNNN_ prefixes.`,
      });
    } else {
      violations.push({
        code: 'local-malformed-prefix',
        message: `local migration "${file}" has no recognizable numeric NNNN_ prefix.`,
      });
    }
  }

  for (const [prefix, list] of byPrefix) {
    if (list.length > 1 && !grandfathered.has(prefix)) {
      violations.push({
        code: 'local-duplicate-prefix',
        message: `local migrations collide on numeric prefix ${prefix}: ${list.join(', ')}.`,
      });
    }
  }

  return violations;
}

/** Read a string[] under `key` from a snapshot JSON into a Set (missing/bad → empty). */
function loadStringSet(path: string, key: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const arr = raw[key];
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch {
    return new Set();
  }
}

function readLocalFiles(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql') && !f.startsWith('_'));
}

/** Parse the Supabase Management API migrations payload (array of rows). */
export function parseLedgerPayload(raw: string): LedgerRow[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('ledger payload is not a JSON array');
  }
  return parsed.map((r) => ({ version: String(r.version ?? ''), name: r.name ?? null }));
}

function main(): void {
  // --report-only downgrades PROD-LEDGER violations to warnings (exit 0). It is
  // an available escape valve for re-introducing the gate after a known dirty
  // window, but NOT used in steady state: as of 2026-06-18 prod is verified
  // clean and migration-drift.yml runs this BLOCKING (no --report-only) with an
  // empty exemptions snapshot. The local-file pass ALWAYS blocks (deterministic).
  const reportOnly =
    process.argv.includes('--report-only') || process.env.LEDGER_AUDIT_REPORT_ONLY === '1';

  // 1. Local-file integrity (always; network-free).
  const localFiles = readLocalFiles();
  const localViolations = auditLocalFiles(localFiles, loadStringSet(PREFIX_BASELINE_PATH, 'grandfathered'));

  // 2. Prod-ledger integrity (when a payload is supplied).
  //    --ledger <path>, LEDGER_JSON env, or LEDGER_JSON_PATH env.
  let ledgerViolations: Violation[] = [];
  let ledgerChecked = false;
  const ledgerArgIdx = process.argv.indexOf('--ledger');
  const ledgerPath =
    ledgerArgIdx >= 0 ? process.argv[ledgerArgIdx + 1] : process.env.LEDGER_JSON_PATH;
  const inlineLedger = process.env.LEDGER_JSON;

  try {
    let raw: string | undefined;
    if (ledgerPath) raw = readFileSync(ledgerPath, 'utf8');
    else if (inlineLedger) raw = inlineLedger;
    if (raw) {
      ledgerViolations = auditLedgerRows(
        parseLedgerPayload(raw),
        loadStringSet(LEDGER_EXEMPTIONS_PATH, 'exemptPrefixes'),
      );
      ledgerChecked = true;
    }
  } catch (err) {
    // A supplied-but-unparseable ledger is a hard failure (fail-closed P1).
    console.error(
      `::error::ledger-parse-failure: could not read/parse the ledger payload: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  console.log('## Full-ledger numeric-integrity audit (SCRUM-2500 / S0-4.2)');
  console.log(`- Local migration files: ${localFiles.length}`);
  console.log(`- Local violations: ${localViolations.length}`);
  if (ledgerChecked) {
    console.log(`- Ledger violations: ${ledgerViolations.length}${reportOnly ? ' (report-only)' : ''}`);
  } else {
    console.log(
      '::notice title=Ledger pass skipped::No ledger payload supplied (LEDGER_JSON / --ledger). ' +
        'Local-file integrity ran; the prod-ledger pass requires the Supabase Management API payload in CI.',
    );
  }

  // Local-file violations ALWAYS block (deterministic). Ledger violations block
  // unless --report-only (observability mode until prod is reconciled — S0-4.2d).
  const blocking = [...localViolations, ...(reportOnly ? [] : ledgerViolations)];
  const warnOnly = reportOnly ? ledgerViolations : [];

  for (const v of warnOnly) console.warn(`::warning::${v.code}: ${v.message}`);
  for (const v of blocking) console.error(`::error::${v.code}: ${v.message}`);

  if (warnOnly.length > 0) {
    console.warn(
      `::warning title=Ledger drift (report-only)::${warnOnly.length} prod-ledger row(s) need ` +
        'reconciliation (CLAUDE.md §0 rule 10). Not blocking yet — see S0-4.2d in ' +
        'docs/runbooks/migration-drift-playbook.md.',
    );
  }
  if (blocking.length > 0) {
    console.error(
      '\nResolution: see docs/runbooks/migration-drift-playbook.md. Do not run migration repair ' +
        'or prod db push from CI — reconcile with Carson/operator sign-off (CLAUDE.md §1.11A).',
    );
    process.exit(1);
  }
  console.log('::notice title=Ledger integrity OK::No blocking numeric-prefix or duplicate violations found.');
}

if (isMainModule(import.meta.url, process.argv[1])) main();

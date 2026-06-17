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

const REPO = process.env.LEDGER_AUDIT_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..');
const MIGRATIONS_DIR = join(REPO, 'supabase', 'migrations');
const PREFIX_BASELINE_PATH = join(REPO, 'scripts', 'ci', 'snapshots', 'migration-prefix-baseline.json');
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
 */
export function auditLedgerRows(rows: LedgerRow[]): Violation[] {
  const violations: Violation[] = [];
  const seenNames = new Map<string, number>();
  const seenVersions = new Map<string, number>();

  for (const row of rows) {
    const name = (row.name ?? '').toString();
    const version = (row.version ?? '').toString();

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

function loadGrandfathered(): Set<string> {
  if (!existsSync(PREFIX_BASELINE_PATH)) return new Set();
  try {
    const raw = JSON.parse(readFileSync(PREFIX_BASELINE_PATH, 'utf8')) as { grandfathered?: string[] };
    return new Set(raw.grandfathered ?? []);
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
  const fail = (vs: Violation[]) => {
    for (const v of vs) console.error(`::error::${v.code}: ${v.message}`);
  };

  // 1. Local-file integrity (always; network-free).
  const localFiles = readLocalFiles();
  const localViolations = auditLocalFiles(localFiles, loadGrandfathered());

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
      ledgerViolations = auditLedgerRows(parseLedgerPayload(raw));
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

  const all = [...localViolations, ...ledgerViolations];
  console.log('## Full-ledger numeric-integrity audit (SCRUM-2500 / S0-4.2)');
  console.log(`- Local migration files: ${localFiles.length}`);
  console.log(`- Local violations: ${localViolations.length}`);
  if (ledgerChecked) {
    console.log(`- Ledger violations: ${ledgerViolations.length}`);
  } else {
    console.log(
      '::notice title=Ledger pass skipped::No ledger payload supplied (LEDGER_JSON / --ledger). ' +
        'Local-file integrity ran; the prod-ledger pass requires the Supabase Management API payload in CI.',
    );
  }

  if (all.length > 0) {
    fail(all);
    console.error(
      '\nResolution: see docs/runbooks/migration-drift-playbook.md. Do not run migration repair ' +
        'or prod db push from CI — reconcile with Carson/operator sign-off (CLAUDE.md §1.11A).',
    );
    process.exit(1);
  }
  console.log('::notice title=Ledger integrity OK::No numeric-prefix or duplicate violations found.');
}

const isDirectInvocation = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  return resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
})();

if (isDirectInvocation) main();

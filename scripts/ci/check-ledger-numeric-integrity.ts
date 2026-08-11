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

/**
 * Cross-check the prod ledger against the repo: every prod ledger row whose
 * `name` is a numeric Arkova migration (`NNNN_`) MUST have a matching
 * `supabase/migrations/NNNN_*.sql` file in the repo. A prod row with NO repo
 * file means a migration reached prod WITHOUT its source landing on `main` —
 * the 2026-06-29 incident class where `0347_lane1_i4_chain_block_hash_reorg`
 * was applied to prod out-of-band, ahead of its still-open owning PR #1307
 * (CLAUDE.md §1.11: staging-before-prod, RTE-applies-post-merge). The existing
 * `auditLedgerRows` pass missed it because the orphan row was a perfectly clean
 * numeric version with no duplicate — format-valid, just absent from the repo.
 *
 * Keyed off the numeric `version` (a clean `NNNN`), NOT the row `name`: prod
 * ledger names vary by apply path — `supabase db push` records the file
 * basename (`0347_lane1_...`) but an MCP `apply_migration` records a free-text
 * name (`microsoft_graph_webhook_nonces`) over a numeric version. The version is
 * the one reliable numeric identifier, so an out-of-band apply is caught
 * regardless of how its name was recorded.
 *
 * Direction matters: this flags ONLY prod-AHEAD-of-repo (orphan prod rows). The
 * reverse — a repo migration file not yet in the prod ledger — is the NORMAL
 * healthy window (merged, awaiting the RTE's post-merge prod apply) and is
 * intentionally NOT flagged. `files` are local migration basenames (± `.sql`).
 */
export function auditLedgerVsRepo(
  rows: LedgerRow[],
  files: string[],
  exemptPrefixes: Set<string> = new Set(),
): Violation[] {
  const localPrefixes = new Set<string>();
  for (const raw of files) {
    const file = raw.endsWith('.sql') ? raw : `${raw}.sql`;
    if (file === BASELINE_FILE) continue;
    const m = file.match(LOCAL_NUMERIC_RE);
    if (m) localPrefixes.add(m[1]); // bare NNNN_ and lettered NNNNb_ both map to NNNN
  }

  const violations: Violation[] = [];
  for (const row of rows) {
    const version = row.version ?? '';
    if (!NUMERIC_VERSION_RE.test(version)) continue; // baseline/operator/timestamp versions: not repo-file-tracked here
    if (exemptPrefixes.has(version)) continue; // documented backlog (S0-4.2d)
    if (localPrefixes.has(version)) continue; // repo has the file — reconciled
    violations.push({
      code: 'ledger-orphan-prod-row',
      message:
        `prod ledger has version="${version}" (name="${row.name ?? ''}") with no matching ` +
        `supabase/migrations/${version}_*.sql in the repo — a migration reached prod WITHOUT ` +
        `its source landing on main (CLAUDE.md §1.11: staging-before-prod / RTE-applies-post-merge). ` +
        `Reconcile by merging the owning PR (lands the file), or add ${version} to ` +
        `ledger-numeric-exemptions.json with a documented reason.`,
    });
  }
  return violations;
}

/**
 * Flag exemptions that have outlived their purpose (2026-08-11).
 *
 * WHY: `auditLedgerVsRepo` returns early on `exemptPrefixes.has(version)` BEFORE
 * it reaches the `localPrefixes` check, so once an owning PR merges and lands
 * `NNNN_*.sql` on main, the now-redundant exemption entry is skipped silently
 * and forever. Nothing ever says "you can delete this line." Every stale entry
 * to date was caught by a human reading the file: `0404` on the morning of
 * 2026-08-11, `0401`/`0407` that afternoon, `0406` within MINUTES of that
 * cleanup, and fifteen in one sweep on 2026-08-02.
 *
 * That matters because a stale exemption is not inert — it is a live hole. It
 * suppresses `ledger-orphan-prod-row` for its prefix, so if that migration is
 * ever reverted from main, or a FUTURE out-of-band apply reuses the number, the
 * orphan audit stays green on a real drift. The exemption file says so itself:
 * "a stale exemption is worse than no exemption."
 *
 * DELIBERATELY WARN-ONLY, never blocking. A stale exemption is hygiene debt, not
 * a live defect, and this check is evaluated against the whole ledger on every
 * PR — so making it fatal would red the entire board at once for a condition
 * nobody needs to fix this minute. That is precisely the pathology that cost a
 * day on 2026-08-11, when two orphan rows deadlocked every open PR. Visibility
 * without a merge block is the right trade; `main()` never adds these to
 * `blocking`.
 */
export function auditStaleExemptions(
  rows: LedgerRow[],
  files: string[],
  exemptPrefixes: Set<string> = new Set(),
): Violation[] {
  if (exemptPrefixes.size === 0) return [];

  const localPrefixes = new Set<string>();
  for (const raw of files) {
    const file = raw.endsWith('.sql') ? raw : `${raw}.sql`;
    if (file === BASELINE_FILE) continue;
    const m = file.match(LOCAL_NUMERIC_RE);
    if (m) localPrefixes.add(m[1]);
  }

  // Only prefixes actually present in the ledger are considered: an exemption
  // for a prefix that is in neither prod nor the repo is a different (and much
  // rarer) kind of dead entry, and flagging it here would misreport the reason.
  const ledgerPrefixes = new Set<string>();
  for (const row of rows) {
    const version = row.version ?? '';
    if (NUMERIC_VERSION_RE.test(version)) ledgerPrefixes.add(version);
  }

  const violations: Violation[] = [];
  // Explicit comparator, not a bare .sort() (Sonar S2871) and not localeCompare:
  // prefixes are zero-padded ASCII digit strings, so a plain relational compare is
  // both correct and locale-independent — CI output must not vary with the runner's
  // locale, or the warning order would churn between machines.
  const sortedPrefixes = [...exemptPrefixes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const prefix of sortedPrefixes) {
    if (!ledgerPrefixes.has(prefix) || !localPrefixes.has(prefix)) continue;
    violations.push({
      code: 'ledger-stale-exemption',
      message:
        `${prefix} is listed in ledger-numeric-exemptions.json but is now RECONCILED — it is ` +
        `present in the prod ledger AND its source supabase/migrations/${prefix}_*.sql is on main. ` +
        `The exemption no longer suppresses anything real; it only hides a future drift on ${prefix} ` +
        `(a revert, or a later out-of-band apply reusing the number). Remove ${prefix} from ` +
        `exemptPrefixes and record the removal in the file's _history array.`,
    });
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
  // Hygiene-only, never blocking — see auditStaleExemptions' header for why.
  let staleExemptions: Violation[] = [];
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
      const exempt = loadStringSet(LEDGER_EXEMPTIONS_PATH, 'exemptPrefixes');
      const ledgerRows = parseLedgerPayload(raw);
      ledgerViolations = [
        ...auditLedgerRows(ledgerRows, exempt),
        // Orphan-prod-row cross-check: prod ledger ahead of repo (0347 incident class).
        ...auditLedgerVsRepo(ledgerRows, localFiles, exempt),
      ];
      // Reported separately from ledgerViolations so it can never reach `blocking`.
      staleExemptions = auditStaleExemptions(ledgerRows, localFiles, exempt);
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
  for (const v of staleExemptions) console.warn(`::warning::${v.code}: ${v.message}`);
  for (const v of blocking) console.error(`::error::${v.code}: ${v.message}`);

  if (staleExemptions.length > 0) {
    console.warn(
      `::warning title=Stale ledger exemptions (${staleExemptions.length})::` +
        `${staleExemptions.length} exemption(s) are reconciled and can be deleted from ` +
        'scripts/ci/snapshots/ledger-numeric-exemptions.json. Not blocking — hygiene only.',
    );
  }

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

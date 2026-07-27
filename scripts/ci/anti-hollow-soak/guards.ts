#!/usr/bin/env -S npx tsx
/**
 * SCRUM-2977 — Anti-hollow-soak guard set.
 *
 * A "hollow soak" is a staging soak whose clock burns real wall-time while the
 * changed behavior under test is never actually exercised. The 48h B1 soak on
 * 2026-07-19 was INVALID for exactly this reason, and the clock had already
 * burned before anyone noticed. Root-cause signatures from that incident:
 *
 *   #1  ENABLE_BATCH_ANCHORING was OFF, so the changed drain path returned
 *       EMPTY every cycle — the soak "ran" but processed nothing.
 *   #2  The Cloud Scheduler forced-flush job had no OIDC audience matching the
 *       worker URL, so the flush call never authenticated (401) — the trigger
 *       under test never fired.
 *   #3  The rig treasury was unfunded, so hasFunds() short-circuited and the
 *       anchor/broadcast path was skipped entirely.
 *   #4  The rig never wrote a public.staging_deploy_log provenance row for the
 *       PR head SHA, so there was no proof the soaked code was the code on the
 *       rig.
 *
 * A fifth signature comes from the same incident family (base-drift): a PR
 * marked ready while still based on an agent/codex branch instead of main
 * produces evidence against a base that will never merge.
 *
 * This module is the PRE-CLOCK gate: every check below must pass BEFORE the
 * soak clock is allowed to count. Each check is a pure function returning
 * `{ pass, message }`; `runAntiHollowSoakGuards` orchestrates them and the CLI
 * entrypoint exits non-zero on any failure.
 *
 * CI wiring: SCRUM-2977 wires this into ci.yml in REPORT-ONLY / warn mode only
 * (`--report-only`), per the W3-freeze CTO carve-out — it prints findings and
 * exits 0, gating nothing. Fail-closed activation (dropping `--report-only`) is
 * DEFERRED until >=1 real green soak calibrates the guards, mirroring the
 * #1617 T0-CI-infra precedent.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface GuardResult {
  /** Stable identifier for the check (used to key failures in CI logs). */
  name: string;
  pass: boolean;
  message: string;
}

/** One drain cycle observed during the changed-path preflight. */
export interface DrainCycle {
  /** Number of records the changed drain path actually processed this cycle. */
  processed: number;
  /** Whether the drain path skipped this cycle (flag off, no funds, no auth…). */
  skipped: boolean;
  /** Optional human reason for a skip (e.g. "ENABLE_BATCH_ANCHORING=false"). */
  reason?: string;
  /**
   * G-4 attribution: the identifier of the drain path that processed this
   * cycle (e.g. "batch-anchor-drain", "connector-fetch-drain",
   * "synthetic-load"). Lets the preflight distinguish the PR's CHANGED path
   * from generic synthetic load burning the clock on an unrelated queue.
   */
  path?: string;
}

/** A Cloud Scheduler job descriptor (the forced-flush trigger). */
export interface SchedulerJob {
  name: string;
  httpTarget: {
    uri: string;
    oidcToken?: {
      audience?: string;
    };
  };
}

export interface TreasuryStatus {
  treasuryBalanceSats: number;
  minRequiredSats: number;
}

export interface DeployLogRow {
  head_sha: string;
  service: string;
  at?: string;
}

export interface DeployProvenanceInput {
  deployLogRows: DeployLogRow[];
  prHeadSha: string;
  service: string;
}

export interface BasePremergeInput {
  baseRefName: string;
}

export interface AntiHollowSoakInput {
  /** Changed-path drain log (signature #1). */
  drainLog: DrainCycle[];
  /** Forced-flush scheduler job descriptor (signature #2). */
  schedulerJob: SchedulerJob;
  /** Rig treasury balance vs minimum (signature #3). */
  treasury: TreasuryStatus;
  /** Deploy provenance rows + PR head SHA (signature #4). */
  deployProvenance: DeployProvenanceInput;
  /** PR base ref (signature #5). */
  base: BasePremergeInput;
  /**
   * G-4: the drain-path identifier(s) this PR actually changed. When present,
   * checkNonSkipDrainPreflight requires the productive work to be attributed to
   * one of these paths (not generic synthetic load). Omit/empty = legacy
   * attribution-unaware mode (passes with a caveat).
   */
  changedPaths?: string[];
}

export interface AntiHollowSoakReport {
  allPassed: boolean;
  results: GuardResult[];
}

// ---------------------------------------------------------------------------
// Check 1 — non-skip-drain-preflight (signature #1: empty-cycle drain)
// ---------------------------------------------------------------------------

/**
 * The changed-path drain log must contain at least one cycle that actually
 * processed the PR's changed behavior — a NON-skip cycle with processed > 0.
 * If every cycle is a skip or an empty (processed === 0) cycle, the drain path
 * never did real work and the soak is hollow (flag off / no funds / no data).
 *
 * G-4: a productive cycle alone is NOT sufficient. When `changedPaths` is
 * supplied, the productive work must be attributed (via `DrainCycle.path`) to
 * one of the PR's changed paths. This is what distinguishes real
 * changed-behavior coverage from generic synthetic load that happens to keep a
 * rig busy on an unrelated queue while the changed path is never exercised
 * (CLAUDE.md §1.12: "generic synthetic load is supporting worker-health
 * evidence only"). When `changedPaths` is omitted/empty the check falls back to
 * the legacy attribution-unaware behavior and passes with an explicit caveat.
 */
export function checkNonSkipDrainPreflight(
  drainLog: DrainCycle[],
  changedPaths?: string[],
): GuardResult {
  const name = 'non-skip-drain-preflight';

  if (!Array.isArray(drainLog) || drainLog.length === 0) {
    return {
      name,
      pass: false,
      message:
        'Drain preflight FAILED: no drain cycles recorded. The changed-path ' +
        'drain must be observed processing at least one non-empty cycle before ' +
        'the soak clock starts.',
    };
  }

  const productive = drainLog.filter((c) => !c.skipped && c.processed > 0);

  if (productive.length === 0) {
    const skipReasons = Array.from(
      new Set(
        drainLog
          .filter((c) => c.skipped && c.reason)
          .map((c) => c.reason as string),
      ),
    );
    const reasonSuffix =
      skipReasons.length > 0 ? ` Skip reasons seen: ${skipReasons.join('; ')}.` : '';
    return {
      name,
      pass: false,
      message:
        `Drain preflight FAILED: all ${drainLog.length} cycle(s) were skip/empty ` +
        `(0 records processed on the changed path). This is the signature-#1 ` +
        `empty-cycle drain (e.g. ENABLE_BATCH_ANCHORING off).${reasonSuffix}`,
    };
  }

  const totalProcessed = productive.reduce((sum, c) => sum + c.processed, 0);

  // Legacy / attribution-unaware mode: no changed paths declared.
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return {
      name,
      pass: true,
      message:
        `Drain preflight OK (attribution not asserted): ${productive.length} ` +
        `productive cycle(s) processed ${totalProcessed} record(s), but no ` +
        `changed-path set was declared so this cannot distinguish the PR's ` +
        `changed drain from generic synthetic load (G-4).`,
    };
  }

  // G-4 attribution mode: the productive work must land on a changed path.
  const changedSet = new Set(changedPaths);
  const attributed = productive.filter((c) => c.path && changedSet.has(c.path));
  const anyPathTagged = productive.some((c) => typeof c.path === 'string' && c.path.length > 0);

  if (!anyPathTagged) {
    return {
      name,
      pass: false,
      message:
        `Drain preflight FAILED: ${productive.length} productive cycle(s) but ` +
        `NONE carry a path attribution, so the work cannot be tied to the PR's ` +
        `changed path(s) [${changedPaths.join(', ')}]. Tag each cycle with its ` +
        `DrainCycle.path (G-4).`,
    };
  }

  if (attributed.length === 0) {
    const seenPaths = Array.from(
      new Set(productive.map((c) => c.path).filter((p): p is string => Boolean(p))),
    );
    return {
      name,
      pass: false,
      message:
        `Drain preflight FAILED: productive cycles ran only on non-changed ` +
        `path(s) [${seenPaths.join(', ')}] — this is generic synthetic load, ` +
        `not the PR's changed path(s) [${changedPaths.join(', ')}]. The changed ` +
        `behavior was never exercised (G-4 hollow-by-attribution).`,
    };
  }

  const attributedProcessed = attributed.reduce((sum, c) => sum + c.processed, 0);
  return {
    name,
    pass: true,
    message:
      `Drain preflight OK: ${attributed.length} productive cycle(s) processed ` +
      `${attributedProcessed} record(s) attributed to changed path(s) ` +
      `[${changedPaths.join(', ')}].`,
  };
}

// ---------------------------------------------------------------------------
// Check 2 — scheduler-oidc-audience (signature #2: forced-flush never authed)
// ---------------------------------------------------------------------------

/** Parse a URL and return its origin, or null if it is not a valid absolute URL. */
function originOf(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

/**
 * The forced-flush Cloud Scheduler job must carry an OIDC token whose audience
 * authenticates against the worker service. A missing audience, or an audience
 * pointing at a different service, means the flush call fails to authenticate
 * (401) and the trigger under test never fires.
 *
 * G-3: Cloud Run's OIDC audience is the service ORIGIN (e.g.
 * `https://svc-abc-uc.a.run.app`), while the scheduler's `httpTarget.uri`
 * carries the invoked PATH (e.g. `.../jobs/anchor-flush`). A naive full-URI
 * equality check false-fails every HEALTHY job that flushes a specific path.
 * The correct comparison is ORIGIN vs ORIGIN — the audience origin must equal
 * the target URI origin.
 */
export function checkSchedulerOidcAudience(job: SchedulerJob): GuardResult {
  const name = 'scheduler-oidc-audience';

  const uri = job?.httpTarget?.uri;
  const audience = job?.httpTarget?.oidcToken?.audience;

  if (!uri) {
    return {
      name,
      pass: false,
      message:
        `Scheduler OIDC FAILED: job "${job?.name ?? '<unnamed>'}" has no ` +
        `httpTarget.uri — cannot verify the forced-flush target.`,
    };
  }

  if (!audience) {
    return {
      name,
      pass: false,
      message:
        `Scheduler OIDC FAILED: forced-flush job "${job.name}" has no OIDC ` +
        `audience. Without it the flush call to ${uri} returns 401 and the ` +
        `trigger never fires (signature #2).`,
    };
  }

  const uriOrigin = originOf(uri);
  if (uriOrigin === null) {
    return {
      name,
      pass: false,
      message:
        `Scheduler OIDC FAILED: forced-flush job "${job.name}" httpTarget.uri ` +
        `"${uri}" is not a parseable absolute URL — cannot derive the worker ` +
        `origin to compare against the OIDC audience (signature #2).`,
    };
  }

  const audienceOrigin = originOf(audience);
  if (audienceOrigin === null) {
    return {
      name,
      pass: false,
      message:
        `Scheduler OIDC FAILED: forced-flush job "${job.name}" OIDC audience ` +
        `"${audience}" is not a parseable absolute URL (Cloud Run audiences ` +
        `must be the service origin URL) (signature #2).`,
    };
  }

  if (audienceOrigin !== uriOrigin) {
    return {
      name,
      pass: false,
      message:
        `Scheduler OIDC FAILED: forced-flush job "${job.name}" OIDC audience ` +
        `origin "${audienceOrigin}" does not match target URI origin ` +
        `"${uriOrigin}". The flush call will not authenticate against the ` +
        `worker (signature #2).`,
    };
  }

  return {
    name,
    pass: true,
    message:
      `Scheduler OIDC OK: forced-flush job "${job.name}" audience origin ` +
      `matches target URI origin ${uriOrigin}.`,
  };
}

// ---------------------------------------------------------------------------
// Check 3 — treasury-funded (signature #3: hasFunds() skipped the path)
// ---------------------------------------------------------------------------

/**
 * The rig treasury must hold at least the minimum required balance during the
 * soak window. If the balance is below the minimum, hasFunds() short-circuits
 * and the anchor/broadcast path is skipped — the soak exercises nothing.
 */
export function checkTreasuryFunded(status: TreasuryStatus): GuardResult {
  const name = 'treasury-funded';
  const { treasuryBalanceSats, minRequiredSats } = status ?? ({} as TreasuryStatus);

  if (
    typeof treasuryBalanceSats !== 'number' ||
    typeof minRequiredSats !== 'number' ||
    Number.isNaN(treasuryBalanceSats) ||
    Number.isNaN(minRequiredSats)
  ) {
    return {
      name,
      pass: false,
      message:
        'Treasury check FAILED: balance/minimum not provided as numbers — ' +
        'cannot confirm hasFunds() would pass during the soak window.',
    };
  }

  if (treasuryBalanceSats < minRequiredSats) {
    return {
      name,
      pass: false,
      message:
        `Treasury check FAILED: balance ${treasuryBalanceSats} sats is below the ` +
        `required minimum ${minRequiredSats} sats. hasFunds() would skip the ` +
        `anchor/broadcast path (signature #3).`,
    };
  }

  return {
    name,
    pass: true,
    message:
      `Treasury check OK: balance ${treasuryBalanceSats} sats >= required ` +
      `${minRequiredSats} sats — hasFunds() passes.`,
  };
}

// ---------------------------------------------------------------------------
// Check 4 — deploy-provenance (signature #4: no staging_deploy_log row)
// ---------------------------------------------------------------------------

/**
 * The rig must have written at least one public.staging_deploy_log row whose
 * head_sha matches the PR head SHA under test (for the service under test).
 * Without a matching provenance row there is no proof the soaked code IS the
 * code the PR ships.
 */
export function checkDeployProvenance(input: DeployProvenanceInput): GuardResult {
  const name = 'deploy-provenance';
  const { deployLogRows, prHeadSha, service } = input ?? ({} as DeployProvenanceInput);

  if (!prHeadSha) {
    return {
      name,
      pass: false,
      message:
        'Deploy provenance FAILED: no PR head SHA supplied — cannot match a ' +
        'staging_deploy_log row.',
    };
  }

  if (!Array.isArray(deployLogRows) || deployLogRows.length === 0) {
    return {
      name,
      pass: false,
      message:
        `Deploy provenance FAILED: the rig wrote no staging_deploy_log rows. ` +
        `There is no proof PR head ${prHeadSha} was deployed to the rig ` +
        `(signature #4).`,
    };
  }

  const match = deployLogRows.find(
    (r) => r.head_sha === prHeadSha && r.service === service,
  );

  if (!match) {
    const seen = deployLogRows
      .map((r) => `${r.service}@${r.head_sha}`)
      .join(', ');
    return {
      name,
      pass: false,
      message:
        `Deploy provenance FAILED: no staging_deploy_log row for ` +
        `service "${service}" at head ${prHeadSha}. Rows present: ${seen} ` +
        `(signature #4).`,
    };
  }

  return {
    name,
    pass: true,
    message:
      `Deploy provenance OK: staging_deploy_log has a row for service ` +
      `"${service}" at head ${prHeadSha}${match.at ? ` (at ${match.at})` : ''}.`,
  };
}

// ---------------------------------------------------------------------------
// Check 5 — base-is-main-premerge (signature #5: base-drift)
// ---------------------------------------------------------------------------

/**
 * Before mark-ready, the PR base must be `main`. A PR based on another agent /
 * codex branch produces soak evidence against a base that will never merge as
 * tested (base-drift, #1367/#1380 incident family).
 */
export function checkBaseIsMainPremerge(input: BasePremergeInput): GuardResult {
  const name = 'base-is-main-premerge';
  const baseRefName = input?.baseRefName;

  if (!baseRefName) {
    return {
      name,
      pass: false,
      message:
        'Base check FAILED: no base ref supplied — cannot confirm the PR is ' +
        'based on main.',
    };
  }

  if (baseRefName !== 'main') {
    return {
      name,
      pass: false,
      message:
        `Base check FAILED: PR base is "${baseRefName}", not "main". Soak ` +
        `evidence against a non-main base is base-drift-invalid (signature #5). ` +
        `Retarget to main and re-soak.`,
    };
  }

  return {
    name,
    pass: true,
    message: 'Base check OK: PR base is main.',
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export function runAntiHollowSoakGuards(
  input: AntiHollowSoakInput,
): AntiHollowSoakReport {
  const results: GuardResult[] = [
    checkNonSkipDrainPreflight(input.drainLog, input.changedPaths),
    checkSchedulerOidcAudience(input.schedulerJob),
    checkTreasuryFunded(input.treasury),
    checkDeployProvenance(input.deployProvenance),
    checkBaseIsMainPremerge(input.base),
  ];

  return {
    allPassed: results.every((r) => r.pass),
    results,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseInputArg(argv: string[]): string | undefined {
  const idx = argv.indexOf('--input');
  if (idx !== -1 && argv[idx + 1]) return argv[idx + 1];
  // Also accept a bare trailing path argument.
  const bare = argv.find((a) => !a.startsWith('--'));
  return bare;
}

export function formatReport(
  report: AntiHollowSoakReport,
  reportOnly = false,
): string {
  const lines: string[] = [
    `Anti-hollow-soak guard set (SCRUM-2977)${reportOnly ? ' [REPORT-ONLY / non-gating]' : ''}:`,
    '',
  ];
  for (const r of report.results) {
    lines.push(`  ${r.pass ? '✅' : '❌'} [${r.name}] ${r.message}`);
  }
  lines.push('');
  if (report.allPassed) {
    lines.push('✅ All guards passed — the soak clock may start.');
  } else if (reportOnly) {
    lines.push(
      '::warning::Anti-hollow-soak guard(s) would BLOCK the soak clock. Report-only during calibration (SCRUM-2977) — non-gating; resolve the hollow signature(s) above before starting a real soak.',
    );
  } else {
    lines.push(
      '::error::Anti-hollow-soak guard(s) FAILED — the soak clock must NOT start until the hollow signature(s) above are resolved.',
    );
  }
  return lines.join('\n');
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const reportOnly = argv.includes('--report-only');
  const inputPath = parseInputArg(argv);

  if (!inputPath) {
    if (reportOnly) {
      console.log(
        '::notice::anti-hollow-soak (report-only): no --input soak-preflight supplied; nothing to check. Non-gating.',
      );
      return 0;
    }
    console.error(
      '::error::Usage: anti-hollow-soak/guards.ts [--report-only] --input <soak-preflight.json>',
    );
    return 2;
  }

  let input: AntiHollowSoakInput;
  try {
    input = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (reportOnly) {
      console.log(
        `::warning::anti-hollow-soak (report-only): could not read/parse input "${inputPath}": ${msg}. Non-gating.`,
      );
      return 0;
    }
    console.error(`::error::Failed to read/parse input "${inputPath}": ${msg}`);
    return 2;
  }

  const report = runAntiHollowSoakGuards(input);
  console.log(formatReport(report, reportOnly));
  // Report-only mode never blocks — exit 0 regardless (calibration phase).
  return reportOnly ? 0 : report.allPassed ? 0 : 1;
}

function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && resolve(fileURLToPath(metaUrl)) === resolve(argvPath);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(main());
}

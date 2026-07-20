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
 * CI wiring (adding this to a workflow job) is intentionally deferred — this
 * file only provides the guard logic + tests.
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
 */
export function checkNonSkipDrainPreflight(drainLog: DrainCycle[]): GuardResult {
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
  return {
    name,
    pass: true,
    message:
      `Drain preflight OK: ${productive.length} productive cycle(s) processed ` +
      `${totalProcessed} record(s) on the changed path.`,
  };
}

// ---------------------------------------------------------------------------
// Check 2 — scheduler-oidc-audience (signature #2: forced-flush never authed)
// ---------------------------------------------------------------------------

/**
 * The forced-flush Cloud Scheduler job must carry an OIDC token whose audience
 * exactly matches the HTTP target URI (the worker URL). A missing audience, or
 * an audience that points somewhere other than the target, means the flush
 * call fails to authenticate (401) and the trigger under test never fires.
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

  if (audience !== uri) {
    return {
      name,
      pass: false,
      message:
        `Scheduler OIDC FAILED: forced-flush job "${job.name}" OIDC audience ` +
        `"${audience}" does not match target URI "${uri}". The flush call will ` +
        `not authenticate against the worker (signature #2).`,
    };
  }

  return {
    name,
    pass: true,
    message:
      `Scheduler OIDC OK: forced-flush job "${job.name}" audience matches ` +
      `target URI ${uri}.`,
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
    checkNonSkipDrainPreflight(input.drainLog),
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

export function formatReport(report: AntiHollowSoakReport): string {
  const lines: string[] = ['Anti-hollow-soak guard set (SCRUM-2977):', ''];
  for (const r of report.results) {
    lines.push(`  ${r.pass ? '✅' : '❌'} [${r.name}] ${r.message}`);
  }
  lines.push('');
  lines.push(
    report.allPassed
      ? '✅ All guards passed — the soak clock may start.'
      : '::error::Anti-hollow-soak guard(s) FAILED — the soak clock must NOT start until the hollow signature(s) above are resolved.',
  );
  return lines.join('\n');
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const inputPath = parseInputArg(argv);
  if (!inputPath) {
    console.error(
      '::error::Usage: anti-hollow-soak/guards.ts --input <soak-preflight.json>',
    );
    return 2;
  }

  let input: AntiHollowSoakInput;
  try {
    input = JSON.parse(readFileSync(resolve(inputPath), 'utf8'));
  } catch (err) {
    console.error(
      `::error::Failed to read/parse input "${inputPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 2;
  }

  const report = runAntiHollowSoakGuards(input);
  console.log(formatReport(report));
  return report.allPassed ? 0 : 1;
}

function isMainModule(metaUrl: string, argvPath: string | undefined): boolean {
  return argvPath !== undefined && resolve(fileURLToPath(metaUrl)) === resolve(argvPath);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(main());
}

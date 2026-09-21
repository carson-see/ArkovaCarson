#!/usr/bin/env -S npx tsx
/**
 * CI guard: no raw Cloud Run (`*.run.app`) host literal outside an explicit
 * allowlist (SCRUM-3888).
 *
 * WHY THIS EXISTS
 *
 * The raw Cloud Run revision host (e.g.
 * `arkova-worker-270018525501.us-central1.run.app`) answers publicly and
 * unauthenticated today — CLAUDE.md §1.1: `ingress=all`,
 * `invoker-iam-disabled`, empty IAM policy, no Cloud Armor, no GCLB, no
 * Cloudflare in front of it. SCRUM-3888 is the Cloudflare origin guard that
 * closes that gap: once enforced, a request that reaches the worker without
 * having come through Cloudflare's `api.arkova.ai` / `edge.arkova.ai` /
 * `app.arkova.ai` / `search.arkova.ai` routing gets a 403. Any client,
 * integration, doc example, or config that still DEFAULTS to or DOCUMENTS
 * the raw host as the thing to call breaks the moment that guard is live —
 * 2026-09-21's #3035 (packages/sdk, packages/embed, packages/verifier-cli
 * comments) and #3036-adjacent #integrations-public-api-host (this file's
 * own PR: integrations/zapier, integrations/shared, integrations/clio,
 * integrations/bullhorn, docs/api/*) both moved defaults off it for exactly
 * this reason — this guard exists so the NEXT one doesn't have to be found
 * by hand the same way.
 *
 * FAIL CLOSED, allowlist explicit. This scans every git-tracked, text-like
 * file for a `*.run.app` hostname literal and fails on any file not named in
 * {@link RUN_APP_ALLOWLIST}, each entry carrying its own reason. A file
 * legitimately needs to name the raw host when: it configures the deploy
 * itself (the workflow that builds/tags/verifies THAT Cloud Run revision,
 * or Vercel's server-side proxy rewrite, which never goes through
 * Cloudflare either way); it documents the origin guard's own subject
 * (CLAUDE.md, docs/reference/CLOUDFLARE_ORIGIN_GUARD.md); it asserts
 * REFUSAL of the host (packages/verifier-cli's independent-node guard and
 * its tests); it is dated staging-soak evidence under docs/staging/** (a
 * historical record of what was actually tested, not a live default); or it
 * is internal GCP-to-GCP infrastructure wiring (Cloud Scheduler OIDC job
 * URIs, uptime checks, load-test scripts) that deliberately targets the
 * Cloud Run service directly and bypasses any CDN/WAF layer by design —
 * Cloud Scheduler's OIDC token audience must match the actual Cloud Run
 * service, not a CDN-fronted alias.
 *
 * Usage: tsx scripts/ci/check-run-app-host-literal.ts
 * Exit 0 = every `*.run.app` literal is allowlisted with a reason. Exit 1 = drift.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const GIT_BIN = process.platform === 'win32' ? 'git.exe' : 'git';

/**
 * Matches any Cloud Run revision hostname, not only the current project/
 * revision ID. Captures every dot-separated label chain before `.run.app`
 * (e.g. `arkova-worker-270018525501.us-central1.run.app`, and the newer
 * `<hash>-<region>.a.run.app` format), not just the single label
 * immediately before it — an earlier version of this pattern only matched
 * one label and silently truncated multi-label hosts to e.g. `a.run.app`.
 */
export const RUN_APP_HOST_RE = /(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+run\.app/gi;

/**
 * Extensions worth scanning as text. Deliberately excludes binaries/images/
 * fonts/lockfiles (a `.run.app` substring inside a minified/hashed lockfile
 * entry would be noise, and none of those files are a source of truth for a
 * default host).
 */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.md', '.mdx', '.txt',
  '.html', '.sh', '.py', '.toml',
]);

export interface AllowlistEntry {
  /** Repo-relative path, exact match. */
  path: string;
  /** Why this file may legitimately contain a raw *.run.app literal. */
  reason: string;
}

export const RUN_APP_ALLOWLIST: AllowlistEntry[] = [
  // ── Deploy / verify config for the Cloud Run service itself ──────────
  {
    path: '.github/workflows/deploy-worker.yml',
    reason: 'Builds and deploys THIS Cloud Run revision — the workflow that ' +
      'produces the host, not a client of it.',
  },
  {
    path: '.github/workflows/revision-drift.yml',
    reason: 'Verifies the deployed Cloud Run revision matches main — reads the ' +
      'actual service, does not default anything to it.',
  },
  {
    path: '.github/workflows/verify-worker-runtime.yml',
    reason: 'Post-deploy smoke check against the actual Cloud Run revision that ' +
      'was just deployed.',
  },
  {
    path: 'vercel.json',
    reason: 'Server-side rewrite destinations (/api/*, /jobs/*, /.well-known/*) ' +
      'proxy directly from Vercel to Cloud Run — this never goes through ' +
      'Cloudflare either way, so the origin guard does not apply to it. ' +
      'Flagged in the PR body for a dedicated infra review regardless, since ' +
      'changing live routing config needs deploy verification this PR does ' +
      'not do.',
  },
  {
    path: 'index.html',
    reason: 'CSP connect-src allowlist entry for the root document — same ' +
      'reasoning as vercel.json (not a default any client code reads); ' +
      'flagged alongside it for the same dedicated infra review.',
  },

  // ── Docs that describe the origin / origin guard itself ───────────────
  { path: 'CLAUDE.md', reason: "Documents the origin guard's own subject (§1.1)." },
  {
    path: 'docs/reference/CLOUDFLARE_ORIGIN_GUARD.md',
    reason: 'IS the documentation of the guard this literal exists to eventually make obsolete.',
  },
  {
    path: 'docs/reference/WEBEXT01_REGATE_EVIDENCE.md',
    reason: 'Dated internal evidence doc recording what was tested against the raw host at the time.',
  },
  {
    path: 'docs/jira-workflow/automation-rules.json',
    reason: 'Internal Jira automation registry referencing the host in historical rule metadata, not a client default.',
  },

  // ── Tests / source that assert REFUSAL of the raw host ────────────────
  {
    path: 'packages/verifier-cli/src/lib/independent-endpoint.ts',
    reason: 'CLOUD_RUN_HOST_RE exists to REFUSE this host, not default to it — see the file.',
  },
  {
    path: 'packages/verifier-cli/test/independent-endpoint.test.ts',
    reason: 'Regression tests asserting the guard above refuses *.run.app hosts.',
  },
  {
    path: 'packages/verifier-cli/agents.md',
    reason: 'Documents the same refusal-not-default guard.',
  },

  // ── GCP-to-GCP infra that deliberately bypasses any CDN/WAF ───────────
  {
    path: 'tests/k6/verify-api-load.js',
    reason: 'Load-test script intentionally load-tests the real deployed instance directly.',
  },
  {
    path: 'services/worker/scripts/load-test/README.md',
    reason: 'Internal load-test runbook for the same direct-instance load testing.',
  },
  {
    path: 'scripts/pentest/provision-sekura-accounts.mjs',
    reason: 'Pentest account provisioning targets the real scoped host by design (docs/compliance/pentest-vendor-shortlist.md).',
  },

  // ── src/lib/workerClient.ts: the ONE default-host file this guard found
  // that is genuinely a different-lane, real-stakes change, not covered by
  // any prefix below ─────────────────────────────────────────────────────
  {
    path: 'src/lib/workerClient.ts',
    reason: "The frontend app's own worker client — a core-app change with real " +
      'deploy/e2e-testing stakes, out of scope for this integrations-focused ' +
      'PR; flagged as a HIGH-PRIORITY follow-up given the origin-guard risk.',
  },

  // ── This guard's own file + colocated test ─────────────────────────────
  {
    path: 'scripts/ci/check-run-app-host-literal.ts',
    reason: 'This file — every allowlisted path and RUN_APP_HOST_RE itself necessarily name the pattern.',
  },
  {
    path: 'scripts/ci/check-run-app-host-literal.test.ts',
    reason: "This guard's own colocated test exercises real matches/non-matches.",
  },

  // ── CI/config-drift tooling that asserts against the deployed host,
  // and staging-evidence-integrity tests using synthetic/placeholder hosts
  // as fixtures (not a scripts/staging/ prefix match — these live directly
  // under scripts/ci/) ────────────────────────────────────────────────────
  {
    path: 'scripts/ci/check-config-drift.test.ts',
    reason: 'Config-drift snapshot test comparing against the asserted deployed host.',
  },
  {
    path: 'scripts/ci/check-csp-runtime-deps.test.ts',
    reason: 'CSP runtime-dependency test comparing against the asserted deployed host.',
  },
  {
    path: 'scripts/ci/config-drift/expected-prod-config.json',
    reason: 'Committed snapshot of the asserted prod config, including the real deployed host.',
  },
  {
    path: 'scripts/ci/config-drift/prod-config-snapshot.json',
    reason: 'Committed snapshot of the asserted prod config, including the real deployed host.',
  },
  {
    path: 'scripts/ci/lib/runtimeParity.test.ts',
    reason: 'Worker/edge parity test comparing against the asserted deployed host.',
  },
  {
    path: 'scripts/ci/anti-hollow-soak/guards.ts',
    reason: 'Anti-hollow-soak guard source using a synthetic *.run.app host as its own fixture pattern.',
  },
  {
    path: 'scripts/ci/anti-hollow-soak/guards.test.ts',
    reason: 'Tests for the guard above using synthetic *.run.app fixtures.',
  },
  {
    path: 'scripts/ci/check-staging-evidence.test.ts',
    reason: 'Staging-evidence gate tests using synthetic example.run.app / *.run.app fixtures.',
  },
  {
    path: 'scripts/ci/check-staging-evidence-integrity.test.ts',
    reason: 'Staging-evidence-integrity tests using a synthetic example.run.app fixture.',
  },
  {
    path: 'scripts/ci/load-harness-artifact.test.ts',
    reason: 'Load-harness artifact tests using a synthetic *.run.app fixture.',
  },

  // ── #3035 sibling PR fixed these; PENDING MERGE ────────────────────────
  // Recovering PR #2986's qualification fixes onto main (#3035, opened
  // 2026-09-21) moves packages/sdk and packages/embed's default host off
  // *.run.app onto api.arkova.ai — the same fix this PR makes for
  // integrations/*. #3035 has not merged yet, so main (and this branch,
  // cut from main) still carries the old default in these 6 files. NOT
  // fixed here to avoid duplicate/conflicting work across two concurrent
  // PRs touching the same lines. REMOVE these 6 entries once #3035 merges
  // — if they are still needed after that, the merge did not do what it
  // was supposed to, and this guard should catch that immediately.
  {
    path: 'packages/sdk/README.md',
    reason: 'Fixed by #3035 (pending merge) — see note above this block.',
  },
  {
    path: 'packages/sdk/src/client.ts',
    reason: 'Fixed by #3035 (pending merge) — see note above this block.',
  },
  {
    path: 'packages/sdk/src/types.ts',
    reason: 'Fixed by #3035 (pending merge) — see note above this block.',
  },
  {
    path: 'packages/embed/README.md',
    reason: 'Fixed by #3035 (pending merge) — see note above this block.',
  },
  {
    path: 'packages/embed/src/index.ts',
    reason: 'Fixed by #3035 (pending merge) — see note above this block.',
  },
  {
    path: 'packages/embed/src/report-block.ts',
    reason: 'Fixed by #3035 (pending merge) — see note above this block.',
  },
  {
    path: 'packages/embed/src/web-component.ts',
    reason: 'Fixed by #3035 (pending merge) — see note above this block.',
  },

  // ── Dated historical/operational narrative not covered by a prefix below ──
  // Same exemption class check-doc-pointers.ts gives HANDOFF.md's ## History:
  // a dated record of what was true when written must not be rewritten to
  // satisfy a linter — that would corrupt the record.
  { path: 'HANDOFF.md', reason: "Dated ## History narrative — see check-doc-pointers.ts's identical exemption." },
  { path: 'docs/reference/STAGING_RIG.md', reason: 'Documents the actual staging rig hosts by design.' },
  { path: 'docs/security/sekura-known-issues-2026-08-03.md', reason: 'Dated historical security-scan record naming the scanned host.' },
  { path: 'docs/stories/11_mvp_launch_gaps.md', reason: 'Dated historical launch-gap record.' },
  { path: 'docs/uat03-email-confirmation.md', reason: 'Dated historical UAT record.' },
  { path: 'docs/bugs/uat_comprehensive_2026_04_06.md', reason: 'Dated historical UAT record.' },
  { path: 'docs/bugs/uat_launch_readiness_3.md', reason: 'Dated historical UAT record.' },
  { path: 'docs/compliance/pentest-rfp-email-draft.md', reason: 'Dated historical compliance draft naming the real target host for the pentest scope.' },
  { path: 'docs/compliance/pentest-vendor-shortlist.md', reason: 'Dated historical compliance doc naming the real target host for the pentest scope.' },
  { path: 'docs/internal/retroactive-closeout-gap-matrix-2026-05-19.md', reason: 'Dated historical closeout record.' },
  { path: 'docs/lane1/s33-prod-drain-topology.md', reason: 'Dated historical topology record.' },
  { path: 'docs/runbooks/gcp-max-setup.md', reason: 'GCP infra runbook naming the real Cloud Run service being configured.' },
  { path: 'docs/runbooks/integrations/docusign.md', reason: 'Internal integration runbook naming the real deployed host for operator use.' },
  { path: 'docs/runbooks/nph-16-deploy-api-keys.md', reason: 'Internal deploy runbook naming the real deployed host for operator use.' },
  { path: 'docs/runbooks/oauth-state-secret-rotation.md', reason: 'Internal ops runbook naming the real deployed host for operator use.' },
  { path: 'docs/runbooks/sarah-sprint-1-deploy-checklist.md', reason: 'Dated internal deploy checklist.' },
  { path: 'docs/runbooks/scrum-1235-honest-close.md', reason: 'Dated internal closeout record.' },
  { path: 'docs/runbooks/sec-harden/sec-harden-01-google-key-rotation.md', reason: 'Internal security-hardening runbook naming the real deployed host for operator use.' },
  {
    path: 'docs/partners/computeid-activation-runbook.md',
    reason: 'Real gcloud Cloud Scheduler --uri/--oidc-token-audience values for an ' +
      'actual configured job — must target the real Cloud Run service directly ' +
      'for OIDC to validate; not a client base URL.',
  },
  {
    path: 'docs/partners/hakichain-demo-runbook.md',
    reason: 'Internal ops/demo runbook: direct worker health-check and job-trigger ' +
      'commands for operators debugging the actual instance, deliberately ' +
      'bypassing CDN routing.',
  },
];

/**
 * Prefixes allowlisted wholesale — trees that are either huge and grow per-
 * soak/per-PR (so a per-file entry is a losing game), or are an entire
 * out-of-scope lane for this integrations-focused PR.
 */
const RUN_APP_ALLOWLIST_PREFIXES: AllowlistEntry[] = [
  {
    path: 'docs/staging/',
    reason: 'Dated staging-soak evidence: a historical record of what was actually ' +
      'tested against a real (often intentionally raw-host) rig, not a live default. ' +
      'Same exemption class as HANDOFF.md ## History in check-doc-pointers.ts.',
  },
  {
    path: 'scripts/staging/',
    reason: 'Soak-harness drivers, probes, and their tests. This tree deliberately ' +
      'targets specific staging/soak rig Cloud Run hosts (real or synthetic ' +
      'placeholders in unit tests, e.g. example.run.app) as PART OF its job — ' +
      'it is testing/soaking infrastructure, not a client default. ~60 files ' +
      'as of 2026-09-21; a per-file entry here is a losing game against a tree ' +
      'that grows every soak.',
  },
  {
    path: 'scripts/soak/',
    reason: 'Soak journey-probe scripts — same reasoning as scripts/staging/.',
  },
  {
    path: 'scripts/gcp-setup/',
    reason: 'GCP infrastructure configuration (Cloud Scheduler OIDC jobs, uptime ' +
      'checks, alert policies) that deliberately targets the Cloud Run service ' +
      'directly, bypassing any CDN/WAF layer by design — Cloud Scheduler\'s OIDC ' +
      'token audience has to match the actual Cloud Run service, not a ' +
      'CDN-fronted alias.',
  },
  {
    path: 'services/worker/',
    reason: "Worker's own tests, implementation, and served OpenAPI examples — a " +
      'different lane/maintenance surface from this integrations-focused PR ' +
      '(CLAUDE.md §1.13 one-lane-per-session). The origin guard\'s own ' +
      'implementation (services/worker/src/middleware/requireCloudflareOrigin.ts) ' +
      'lives here too, and necessarily names the host it protects.',
  },
  {
    path: 'services/api-gateway/',
    reason: 'api-gateway routing internals — different lane from this integrations-focused PR.',
  },
];

export interface RunAppViolation {
  file: string;
  matches: string[];
}

function isAllowlisted(file: string): boolean {
  if (RUN_APP_ALLOWLIST.some((e) => e.path === file)) return true;
  return RUN_APP_ALLOWLIST_PREFIXES.some((e) => file.startsWith(e.path));
}

/**
 * Candidate files: `git grep`'s own (highly optimized, non-regex-in-Node)
 * search across every tracked file for a plain `.run.app` substring —
 * about 15x faster in practice than reading and regex-testing every
 * tracked file in Node (1.5s vs 22s over this repo's tree). `-I` skips
 * binary files, matching {@link TEXT_EXTENSIONS}' intent without needing
 * git to know about them individually. This is a coarse pre-filter, not
 * the real match: {@link RUN_APP_HOST_RE} still runs in Node over each
 * candidate to extract the exact hostname(s) for the report, and a file
 * that merely contains the literal text ".run.app" without a valid host
 * label before it (unlikely, but not this function's job to assume) would
 * correctly fall out at that stage with zero matches.
 *
 * Exit code 1 from `git grep` means "no matches" (not an error) — caught
 * and treated as an empty result.
 */
function gitGrepCandidateFiles(root: string): string[] {
  try {
    return execFileSync(
      GIT_BIN,
      ['grep', '--fixed-strings', '-l', '.run.app', '--'],
      { encoding: 'utf8', cwd: root },
    ).trim().split('\n').filter(Boolean);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) return []; // git grep: no matches found
    throw err;
  }
}

/**
 * Scans every git-tracked, text-like file for a `*.run.app` literal and
 * returns the files that contain one AND are not allowlisted.
 */
export function findRunAppViolations(root: string = ROOT): RunAppViolation[] {
  const violations: RunAppViolation[] = [];
  for (const file of gitGrepCandidateFiles(root)) {
    if (!TEXT_EXTENSIONS.has(extname(file))) continue;
    if (isAllowlisted(file)) continue;

    let text: string;
    try {
      text = readFileSync(`${root}/${file}`, 'utf8');
    } catch {
      continue; // deleted-but-staged, symlink to nowhere, etc. — not this guard's problem
    }

    const matches = [...text.matchAll(RUN_APP_HOST_RE)].map((m) => m[0]);
    if (matches.length > 0) {
      violations.push({ file, matches: [...new Set(matches)] });
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file));
}

export function checkRunAppHostLiteral(root: string = ROOT): number {
  const violations = findRunAppViolations(root);
  if (violations.length === 0) {
    console.log('No un-allowlisted *.run.app host literal found.');
    return 0;
  }
  console.error(`${violations.length} file(s) contain a *.run.app host literal outside the allowlist:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}: ${v.matches.join(', ')}`);
  }
  console.error(
    '\nEither move the default off the raw Cloud Run host (see #3035 / ' +
    '#fix/integrations-public-api-host for the pattern), or add an ' +
    'allowlist entry with a reason to RUN_APP_ALLOWLIST in ' +
    'scripts/ci/check-run-app-host-literal.ts if the raw host is genuinely correct here.',
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(checkRunAppHostLiteral());
}

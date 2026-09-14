/**
 * SCRUM-2897 — unit tests for the evidence-identity CI gate.
 *
 * The gate asserts two identity invariants on a Ready, soak-tier PR:
 *   A. the `PR head SHA:` declared in the Staging Soak Evidence block equals the
 *      ACTUAL PR head SHA (a new commit silently invalidates exact-head
 *      evidence — feedback_pr_head_sha_in_evidence_block).
 *   B. clean-preflight identity — the declared preflight is `clean_mirror` (for
 *      T2/T3) and any head SHA embedded in the preflight matches the declared
 *      head (evidence may not be copied across heads — CLAUDE.md §1.11A).
 *
 * Drafts and T0 / non-soak PRs are skipped (the gate applies at Ready).
 */

import { describe, expect, it } from 'vitest';
import {
  runEvidenceIdentity,
  checkHeadShaIdentity,
  checkCleanPreflightIdentity,
  formatReport,
  main,
  type EvidenceIdentityInput,
} from './check-evidence-identity.js';

const HEAD = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const OTHER = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
// Distinct 40-hex SHAs for the Post-soak T0 delta allowance tests below.
const SOAKED = '5'.repeat(40);
const WRONG_DELTA = '9'.repeat(40);

function t2Body(overrides: Partial<Record<string, string>> = {}): string {
  const headSha = overrides.headSha ?? HEAD;
  const preflight = overrides.preflight ?? 'environment_type=clean_mirror';
  return [
    '## Staging Soak Evidence',
    'Tier: T2',
    `PR head SHA: ${headSha}`,
    'Base SHA: 1111111111111111111111111111111111111111',
    `Preflight result: ${preflight}`,
    'Staging deploy log id: 12345',
    'Soak start: 2026-07-19T00:00:00Z',
    'Soak end: 2026-07-19T13:00:00Z',
  ].join('\n');
}

function healthyInput(): EvidenceIdentityInput {
  return { body: t2Body(), actualHeadSha: HEAD, isDraft: false };
}

// ---------------------------------------------------------------------------
// checkHeadShaIdentity
// ---------------------------------------------------------------------------

describe('checkHeadShaIdentity', () => {
  it('passes when the declared head SHA equals the actual head SHA', () => {
    expect(checkHeadShaIdentity(t2Body(), HEAD)).toBeNull();
  });

  it('passes when the declared head is a short-SHA prefix of the actual head', () => {
    const finding = checkHeadShaIdentity(t2Body({ headSha: HEAD.slice(0, 12) }), HEAD);
    expect(finding).toBeNull();
  });

  it('FAILS when the declared head SHA does not match the actual head', () => {
    const finding = checkHeadShaIdentity(t2Body({ headSha: OTHER }), HEAD);
    expect(finding).not.toBeNull();
    expect(finding!.name).toBe('head-sha-identity');
    expect(finding!.message).toMatch(/does not match|invalidat/i);
  });

  it('FAILS when the evidence block declares no PR head SHA', () => {
    const body = t2Body().replace(/^PR head SHA:.*$/m, 'PR head SHA:');
    const finding = checkHeadShaIdentity(body, HEAD);
    expect(finding).not.toBeNull();
    expect(finding!.message).toMatch(/no.*PR head SHA|declares no/i);
  });
});

// ---------------------------------------------------------------------------
// checkHeadShaIdentity — Post-soak T0 delta allowance (CTO decision
// 2026-09-12, Confluence 146440221 / SCRUM-5054). Mirrors
// check-staging-evidence.ts's headShaEvidenceResult() for the SAME field —
// see PRs #2841/#2834/#2842, all merged origin/main d0a5ffa27.
// ---------------------------------------------------------------------------

function deltaBody(overrides: { headSha?: string; deltaSha?: string } = {}): string {
  const headSha = overrides.headSha ?? SOAKED;
  const lines = [
    '## Staging Soak Evidence',
    'Tier: T2',
    `PR head SHA: ${headSha}`,
    'Base SHA: 1111111111111111111111111111111111111111',
    'Preflight result: environment_type=clean_mirror',
    'Staging deploy log id: 12345',
    'Soak start: 2026-07-19T00:00:00Z',
    'Soak end: 2026-07-19T13:00:00Z',
  ];
  if (overrides.deltaSha !== undefined) {
    lines.push(`Post-soak T0 delta: ${overrides.deltaSha}`);
  }
  return lines.join('\n');
}

describe('checkHeadShaIdentity — Post-soak T0 delta allowance', () => {
  it('ACCEPTS a delta that names the actual head, descends from the soaked head, and touches only T0 files', () => {
    const finding = checkHeadShaIdentity(deltaBody({ deltaSha: HEAD }), HEAD, {
      ancestryProvider: () => true,
      changedFilesProvider: () => ['docs/reference/ENV.md', 'e2e/api-keys.spec.ts'],
    });
    expect(finding).toBeNull();
  });

  it('FAILS when the delta field names a SHA other than the actual head', () => {
    const finding = checkHeadShaIdentity(deltaBody({ deltaSha: WRONG_DELTA }), HEAD, {
      ancestryProvider: () => true,
      changedFilesProvider: () => ['docs/x.md'],
    });
    expect(finding).not.toBeNull();
    expect(finding!.name).toBe('head-sha-identity');
    expect(finding!.message).toMatch(/Post-soak T0 delta/);
    expect(finding!.message).toMatch(/CURRENT/);
  });

  it('FAILS when the soaked head is not an ancestor of the actual head', () => {
    const finding = checkHeadShaIdentity(deltaBody({ deltaSha: HEAD }), HEAD, {
      ancestryProvider: () => false,
      changedFilesProvider: () => ['docs/x.md'],
    });
    expect(finding).not.toBeNull();
    expect(finding!.message).toMatch(/ancestor/i);
  });

  it('FAILS (fails closed) when ancestry is unresolvable', () => {
    const finding = checkHeadShaIdentity(deltaBody({ deltaSha: HEAD }), HEAD, {
      ancestryProvider: () => null,
      changedFilesProvider: () => ['docs/x.md'],
    });
    expect(finding).not.toBeNull();
    expect(finding!.message).toMatch(/ancestry|ancestor/i);
  });

  it('FAILS when the post-soak changed-file list is empty', () => {
    const finding = checkHeadShaIdentity(deltaBody({ deltaSha: HEAD }), HEAD, {
      ancestryProvider: () => true,
      changedFilesProvider: () => [],
    });
    expect(finding).not.toBeNull();
    expect(finding!.message).toMatch(/empty|fails closed/i);
  });

  it('FAILS when the post-soak changed-file list cannot be computed', () => {
    const finding = checkHeadShaIdentity(deltaBody({ deltaSha: HEAD }), HEAD, {
      ancestryProvider: () => true,
      changedFilesProvider: () => null,
    });
    expect(finding).not.toBeNull();
    expect(finding!.message).toMatch(/could not be computed|fails closed/i);
  });

  it('FAILS when any post-soak file is not T0-classified', () => {
    const finding = checkHeadShaIdentity(deltaBody({ deltaSha: HEAD }), HEAD, {
      ancestryProvider: () => true,
      changedFilesProvider: () => ['docs/x.md', 'services/worker/src/x.ts'],
    });
    expect(finding).not.toBeNull();
    expect(finding!.message).toMatch(/not T0|T0, not/i);
  });

  it('keeps the ORIGINAL stale-head failure when no Post-soak T0 delta field is present', () => {
    const finding = checkHeadShaIdentity(deltaBody(), HEAD, {
      ancestryProvider: () => true,
      changedFilesProvider: () => ['docs/x.md'],
    });
    expect(finding).not.toBeNull();
    expect(finding!.message).toMatch(/does not match|invalidat/i);
    expect(finding!.message).not.toMatch(/Post-soak T0 delta/);
  });
});

describe('runEvidenceIdentity — Post-soak T0 delta note', () => {
  it('passes with an info note when the delta is accepted', () => {
    const r = runEvidenceIdentity({
      body: deltaBody({ deltaSha: HEAD }),
      actualHeadSha: HEAD,
      isDraft: false,
      ancestryProvider: () => true,
      changedFilesProvider: () => ['docs/x.md'],
    });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.notes.some((n) => /post-soak t0 delta/i.test(n))).toBe(true);
  });

  it('still fails when the delta is rejected', () => {
    const r = runEvidenceIdentity({
      body: deltaBody({ deltaSha: HEAD }),
      actualHeadSha: HEAD,
      isDraft: false,
      ancestryProvider: () => false,
      changedFilesProvider: () => ['docs/x.md'],
    });
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.name === 'head-sha-identity')).toBe(true);
    expect(r.notes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkCleanPreflightIdentity
// ---------------------------------------------------------------------------

describe('checkCleanPreflightIdentity', () => {
  it('passes when preflight is clean_mirror (T2)', () => {
    expect(checkCleanPreflightIdentity(t2Body(), HEAD, 'T2')).toEqual([]);
  });

  it('FAILS when preflight is not clean_mirror for a T2/T3 PR', () => {
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: 'environment_type=dirty' }),
      HEAD,
      'T2',
      // Stubbed so the edge-deploy-only carve-out's file-set lookup never
      // shells out to real git for this test's fake SHAs — a worker file
      // keeps the carve-out from applying, preserving pre-carve-out behavior.
      { changedFilesProvider: () => ['services/worker/src/index.ts'] },
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].message).toMatch(/clean_mirror/i);
  });

  it('FAILS when the preflight embeds a head SHA different from the declared head (copied evidence)', () => {
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: `environment_type=clean_mirror head=${OTHER}` }),
      HEAD,
      'T2',
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => /copied|different head|across heads/i.test(f.message))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Fail-closed activation (SCRUM-2965) makes b2's SHA extraction load-bearing.
  // It used to take the FIRST `\b[0-9a-f]{7,40}\b` run in the free-text
  // `Preflight result:` value, which also matches a 7+ digit decimal (a row
  // count, a unix timestamp) and any short hex-looking identifier that is not a
  // commit (`ref=abc1234`). Report-only that produced a spurious warning;
  // merge-blocking it reds a T2/T3 PR with "Preflight result embeds head
  // 3556355", which is both wrong and unactionable.
  // -------------------------------------------------------------------------

  it('does not read a 7+ digit count in the preflight as an embedded head SHA', () => {
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: 'environment_type=clean_mirror, rows=3556355' }),
      HEAD,
      'T2',
    );
    expect(findings).toEqual([]);
  });

  it('does not read an unrelated keyed identifier as an embedded head SHA', () => {
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: 'environment_type=clean_mirror ref=abc1234' }),
      HEAD,
      'T2',
    );
    expect(findings).toEqual([]);
  });

  it('FAILS on a bare full 40-char SHA that differs from the declared head', () => {
    // Unkeyed but unambiguous: nothing else in a preflight line is 40 hex chars.
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: `environment_type=clean_mirror captured at ${OTHER}` }),
      HEAD,
      'T2',
    );
    expect(findings.some((f) => /across heads/i.test(f.message))).toBe(true);
  });

  it('does NOT require clean_mirror for a T1 PR', () => {
    expect(
      checkCleanPreflightIdentity(t2Body({ preflight: 'smoke ok' }), HEAD, 'T1'),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// checkCleanPreflightIdentity — edge-deploy-only carve-out
// (CTO decision 2026-09-13, PR #2908). PR #2908's real changed-file list: a
// Cloudflare-Worker-only PR has no Supabase project to preflight, so a
// declared `Preflight result:` that is not `clean_mirror` is accepted for
// T2/T3 ONLY when the PR's own changed-file set (declared `Base SHA:` →
// declared `PR head SHA:`) is edge-deploy-only per `isEdgeDeployOnlyChange`.
// The base SHA in `t2Body()` is the 40-1's SHA below.
// ---------------------------------------------------------------------------

describe('checkCleanPreflightIdentity — edge-deploy-only carve-out', () => {
  const BASE = '1'.repeat(40);

  // PR #2908's actual changed-file list.
  const EDGE_ONLY_FILES = [
    '.github/workflows/agents.md',
    '.github/workflows/ci.yml',
    '.github/workflows/edge-deploy.yml',
    'docs/reference/ENV.md',
    'scripts/ci/agents.md',
    'scripts/ci/check-edge-deployed-version.test.ts',
    'scripts/ci/check-edge-deployed-version.ts',
    'services/edge/agents.md',
    'services/edge/package-lock.json',
    'services/edge/package.json',
    'services/edge/scripts/agents.md',
    'services/edge/scripts/generate-build-info.mjs',
    'services/edge/scripts/generate-build-info.test.ts',
    'services/edge/src/build-info.ts',
    'services/edge/src/index.test.ts',
    'services/edge/src/index.ts',
    'services/edge/vitest.config.ts',
  ];

  it('PASSES a non-clean_mirror preflight for an edge-only PR (T2)', () => {
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: 'smoke ok, no supabase project in scope' }),
      HEAD,
      'T2',
      { changedFilesProvider: () => EDGE_ONLY_FILES },
    );
    expect(findings).toEqual([]);
  });

  it('PASSES a non-clean_mirror preflight for an edge-only PR (T3)', () => {
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: 'smoke ok' }),
      HEAD,
      'T3',
      { changedFilesProvider: () => EDGE_ONLY_FILES },
    );
    expect(findings).toEqual([]);
  });

  it('surfaces an informational note via runEvidenceIdentity when the carve-out applies', () => {
    const result = runEvidenceIdentity({
      body: t2Body({ preflight: 'smoke ok' }),
      actualHeadSha: HEAD,
      isDraft: false,
      changedFilesProvider: () => EDGE_ONLY_FILES,
    });
    expect(result.ok).toBe(true);
    expect(result.notes.some((n) => /edge-deploy-only carve-out applied/i.test(n))).toBe(true);
  });

  it('still FAILS a worker-touching PR with the same non-clean_mirror preflight', () => {
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: 'smoke ok' }),
      HEAD,
      'T2',
      { changedFilesProvider: () => [...EDGE_ONLY_FILES, 'services/worker/src/handlers/index.ts'] },
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].message).toMatch(/clean_mirror/i);
  });

  it('still FAILS a migration-touching PR with the same non-clean_mirror preflight', () => {
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: 'smoke ok' }),
      HEAD,
      'T3',
      { changedFilesProvider: () => [...EDGE_ONLY_FILES, 'supabase/migrations/0450_x.sql'] },
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].message).toMatch(/clean_mirror/i);
  });

  it('still FAILS when the changed-file provider returns null (uncomputable diff)', () => {
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: 'smoke ok' }),
      HEAD,
      'T2',
      { changedFilesProvider: () => null },
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].message).toMatch(/clean_mirror/i);
  });

  it('still FAILS when the changed-file provider returns an empty list', () => {
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: 'smoke ok' }),
      HEAD,
      'T2',
      { changedFilesProvider: () => [] },
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].message).toMatch(/clean_mirror/i);
  });

  it('does not affect the b2 copied-evidence check when the carve-out applies', () => {
    // Edge-only file set, clean-mirror requirement skipped, but the preflight
    // still embeds a head SHA that differs from the declared PR head — that
    // is an orthogonal identity failure the carve-out must not swallow.
    const findings = checkCleanPreflightIdentity(
      t2Body({ preflight: `smoke ok head=${OTHER}` }),
      HEAD,
      'T2',
      { changedFilesProvider: () => EDGE_ONLY_FILES },
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => /copied|different head|across heads/i.test(f.message))).toBe(true);
  });

  it('does not read the declared Base SHA field as edge-only when it or the head is missing', () => {
    // No `PR head SHA:` declared at all — the carve-out cannot compute a
    // file-set diff without both endpoints, so it must not apply.
    const body = t2Body({ preflight: 'smoke ok' }).replace(/^PR head SHA:.*$/m, 'PR head SHA:');
    const findings = checkCleanPreflightIdentity(body, null, 'T2', {
      changedFilesProvider: () => EDGE_ONLY_FILES,
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].message).toMatch(/clean_mirror/i);
  });

  it('the BASE fixture matches the Base SHA declared by t2Body()', () => {
    // Sanity check that this describe block's assumption about t2Body()'s
    // fixture stays true if that helper ever changes.
    expect(t2Body()).toContain(`Base SHA: ${BASE}`);
  });
});

// ---------------------------------------------------------------------------
// runEvidenceIdentity — scoping (skip Drafts and T0)
// ---------------------------------------------------------------------------

describe('runEvidenceIdentity — scoping', () => {
  it('skips a Draft PR', () => {
    const r = runEvidenceIdentity({ ...healthyInput(), isDraft: true });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/draft/i);
    expect(r.findings).toEqual([]);
  });

  it('skips a T0 / no-evidence PR', () => {
    const r = runEvidenceIdentity({ body: 'Just a docs tweak.', actualHeadSha: HEAD, isDraft: false });
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(true);
  });

  // Fail-closed activation (SCRUM-2965): once this gate can red a PR, an
  // explicitly-declared T0 must SKIP. CLAUDE.md §1.12 requires no evidence
  // block at T0, but `hasEvidenceSection()` matches a bare `Tier: T0` line —
  // so a T0 PR that merely states its tier (the normal, required thing to do)
  // fell through to checkHeadShaIdentity and failed on the absent
  // `PR head SHA:`. Harmless while report-only; blocks every T0 PR the moment
  // the gate is real.
  it('skips a PR that explicitly declares Tier: T0', () => {
    const r = runEvidenceIdentity({
      body: 'Tier: T0\nCI/tooling-only change; no staging evidence required.',
      actualHeadSha: HEAD,
      isDraft: false,
    });
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toMatch(/T0/u);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('skips a Tier: T0 PR even when it carries a Staging Soak Evidence heading', () => {
    const r = runEvidenceIdentity({
      body: '## Staging Soak Evidence\nTier: T0\nNo soak required (docs/CI only).',
      actualHeadSha: HEAD,
      isDraft: false,
    });
    expect(r.skipped).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('still runs on an evidence block whose tier cannot be parsed', () => {
    // Unparseable tier + an evidence heading is ambiguous, not T0 — fail closed
    // and check identity rather than skipping on a malformed tier line.
    const r = runEvidenceIdentity({
      body: '## Staging Soak Evidence\nTier: (tbd)\nBase SHA: 1111111111111111111111111111111111111111',
      actualHeadSha: HEAD,
      isDraft: false,
    });
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.name === 'head-sha-identity')).toBe(true);
  });

  it('runs on a Ready soak-tier PR and passes when identity holds', () => {
    const r = runEvidenceIdentity(healthyInput());
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it('flags a head-SHA mismatch on a Ready T2 PR', () => {
    const r = runEvidenceIdentity({ body: t2Body({ headSha: OTHER }), actualHeadSha: HEAD, isDraft: false });
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.name === 'head-sha-identity')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatReport + CLI (report-only)
// ---------------------------------------------------------------------------

describe('formatReport', () => {
  it('renders a passing line when identity holds', () => {
    const out = formatReport(runEvidenceIdentity(healthyInput()));
    expect(out).toMatch(/identity/i);
  });

  it('renders the accepted Post-soak T0 delta as an info line, still passing', () => {
    const out = formatReport(
      runEvidenceIdentity({
        body: deltaBody({ deltaSha: HEAD }),
        actualHeadSha: HEAD,
        isDraft: false,
        ancestryProvider: () => true,
        changedFilesProvider: () => ['docs/x.md'],
      }),
    );
    expect(out).toMatch(/post-soak t0 delta/i);
    expect(out).toMatch(/✅/);
    expect(out).not.toMatch(/::error::/);
  });

  it('renders ::error:: when a finding exists and not report-only', () => {
    const out = formatReport(
      runEvidenceIdentity({ body: t2Body({ headSha: OTHER }), actualHeadSha: HEAD, isDraft: false }),
      false,
    );
    expect(out).toMatch(/::error::/);
  });

  it('renders ::warning:: (never ::error::) in report-only mode', () => {
    const out = formatReport(
      runEvidenceIdentity({ body: t2Body({ headSha: OTHER }), actualHeadSha: HEAD, isDraft: false }),
      true,
    );
    expect(out).toMatch(/::warning::/);
    expect(out).not.toMatch(/::error::/);
  });
});

describe('main (CLI)', () => {
  const okEnv = { PR_BODY: t2Body(), PR_HEAD_SHA: HEAD, PR_IS_DRAFT: 'false' };
  const mismatchEnv = { PR_BODY: t2Body({ headSha: OTHER }), PR_HEAD_SHA: HEAD, PR_IS_DRAFT: 'false' };

  it('returns 0 when there is no PR context (push event)', () => {
    expect(main([], {})).toBe(0);
  });

  it('returns 0 when identity holds', () => {
    expect(main([], okEnv)).toBe(0);
  });

  it('returns 1 (gating) when identity fails and not report-only', () => {
    expect(main([], mismatchEnv)).toBe(1);
  });

  it('report-only returns 0 even when identity fails', () => {
    expect(main(['--report-only'], mismatchEnv)).toBe(0);
  });

  it('returns 0 for a Draft PR (skipped)', () => {
    expect(main([], { ...mismatchEnv, PR_IS_DRAFT: 'true' })).toBe(0);
  });

  // -------------------------------------------------------------------------
  // SCRUM-2965 — "[Verify] Invalid T2/T3 evidence fails the gate (red-first)".
  // The default (no-flag) invocation is what ci.yml now runs, so these pin the
  // fail-closed contract at the exact surface CI executes.
  // -------------------------------------------------------------------------

  it('returns 1 for a T2 PR whose preflight is not clean_mirror', () => {
    const env = {
      PR_BODY: t2Body({ preflight: 'environment_type=soak_artifact' }),
      PR_HEAD_SHA: HEAD,
      PR_IS_DRAFT: 'false',
    };
    expect(main([], env)).toBe(1);
  });

  it('returns 1 for a T3 PR whose preflight was captured against a different head', () => {
    const body = t2Body({ preflight: `environment_type=clean_mirror head=${OTHER}` }).replace(
      'Tier: T2',
      'Tier: T3',
    );
    expect(main([], { PR_BODY: body, PR_HEAD_SHA: HEAD, PR_IS_DRAFT: 'false' })).toBe(1);
  });

  it('returns 0 for an explicitly declared T0 PR (no evidence required)', () => {
    const env = {
      PR_BODY: '## Staging Soak Evidence\nTier: T0\nCI-only change.',
      PR_HEAD_SHA: HEAD,
      PR_IS_DRAFT: 'false',
    };
    expect(main([], env)).toBe(0);
  });
});

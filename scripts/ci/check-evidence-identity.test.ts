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

  it('does NOT require clean_mirror for a T1 PR', () => {
    expect(
      checkCleanPreflightIdentity(t2Body({ preflight: 'smoke ok' }), HEAD, 'T1'),
    ).toEqual([]);
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
});

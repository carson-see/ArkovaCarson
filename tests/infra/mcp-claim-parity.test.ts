/**
 * MCP claim-parity guard, run against the LIVE surfaces (BUG-026).
 *
 * Sibling to `mcp-manifest-parity.test.ts`, which pins the tool NAME set, the
 * required-argument contract and the property names between
 * `services/edge/src/mcp-tools.ts` and `public/.well-known/mcp/server-card.json`
 * — and explicitly does not compare description TEXT. This file closes that
 * hole, and extends the comparison to the three prose surfaces.
 *
 * The rule logic itself is unit-tested on synthetic fixtures in
 * `scripts/ci/check-mcp-claim-parity.test.ts` — this file only asserts that
 * the real repository satisfies it, so a `npm test` run catches drift without
 * waiting for the CI job.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadRepoInput,
  collectViolations,
  applyBaseline,
  violationKey,
  CLAIM_RULES,
  BASELINE_FILE,
  PROSE_SURFACES,
  type Baseline,
} from '../../scripts/ci/check-mcp-claim-parity.js';

const ROOT = join(__dirname, '..', '..');
const baseline = JSON.parse(readFileSync(join(ROOT, BASELINE_FILE), 'utf-8')) as Baseline;

describe('MCP claim parity — live surfaces', () => {
  const input = loadRepoInput();
  const violations = collectViolations(input);
  const { unbaselined } = applyBaseline(violations, baseline.knownViolations);

  it('has no unbaselined claim violation on any published surface', () => {
    // Printed as keys rather than objects: the key is exactly what you paste
    // into the baseline, and a failure here should tell you what to do.
    expect(unbaselined.map((v) => `${v.key} :: ${v.detail}`)).toEqual([]);
  });

  it('reads every surface it claims to guard', () => {
    // Fail-closed tripwire: if a surface were silently dropped from the input
    // (renamed file, changed constant), every rule over it would report clean.
    const paths = input.surfaces.map((s) => s.path);
    for (const prose of PROSE_SURFACES) expect(paths).toContain(prose);
    expect(input.canonical.length).toBe(16);
    for (const surface of input.surfaces) {
      expect(
        (surface.text?.length ?? 0) > 0 || Object.keys(surface.descriptions ?? {}).length > 0,
        `${surface.path} contributed no content`,
      ).toBe(true);
    }
  });
});

describe('MCP claim-parity baseline hygiene', () => {
  it('has no duplicate keys', () => {
    const keys = baseline.knownViolations.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every entry an owner and a reason', () => {
    for (const entry of baseline.knownViolations) {
      expect(entry.owner.trim().length, entry.key).toBeGreaterThan(0);
      expect(entry.reason.trim().length, entry.key).toBeGreaterThan(0);
    }
  });

  it('only baselines keys whose rule actually exists', () => {
    // A typo in a rule id would silently baseline nothing while looking like
    // it covers something.
    const ruleIds = new Set([
      ...CLAIM_RULES.map((r) => r.id),
      'card-description-parity',
      'reference-coverage',
      'prose-coverage',
    ]);
    for (const entry of baseline.knownViolations) {
      expect(ruleIds, entry.key).toContain(entry.key.split('::')[0]);
    }
  });

  it('does not baseline the strict rules — reference-coverage has no exceptions', () => {
    // `docs/api/mcp-tools.md` is the complete reference: a registered tool
    // missing from it is never acceptable, so this rule must stay unbaselined.
    const refCoverage = baseline.knownViolations.filter((e) => e.key.startsWith('reference-coverage::'));
    expect(refCoverage).toEqual([]);
  });

  it('keys are well-formed rule::surface::subject triples', () => {
    for (const entry of baseline.knownViolations) {
      const parts = entry.key.split('::');
      expect(parts, entry.key).toHaveLength(3);
      expect(violationKey({ rule: parts[0], surface: parts[1], subject: parts[2] })).toBe(entry.key);
    }
  });
});

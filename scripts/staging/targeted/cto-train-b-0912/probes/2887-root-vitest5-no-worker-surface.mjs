// PR #2887 — root vitest 4 -> 5 (with the @vitest/coverage-v8 5.0.0 bump
// folded in) plus src/test/setup.ts importing
// `@testing-library/jest-dom/vitest` (the vitest-5-compatible entry point,
// replacing whatever the vitest-4-era import was). Measured tier: T1
// (default additive change) — confirmed against requiredTierFor() on the
// PR's real changed-file list: package-lock.json, package.json,
// src/test/setup.ts. All three are root-only.
//
// HONEST STATEMENT: this PR has NO Cloud-Run-reachable surface, on this or
// any rig, ever. services/worker/package.json and
// services/worker/package-lock.json are untouched by this PR (the worker
// Docker build context is services/worker/ per this repo's Cloud Build
// convention — root's vitest/testing-library versions are never baked into
// the deployed worker image), and src/test/setup.ts is test-harness wiring
// for the root Vitest run, not application source served by any route. There
// is no HTTP request this module could make, against this or ANY worker
// revision, that would exercise a single line this PR changes. Writing a
// probe that hits /health and calls that "coverage" for THIS PR specifically
// would be exactly the vacuous-pass pattern this train's own #2882 module
// warns against — so this module does not pretend otherwise.
//
// REAL EVIDENCE FOR THIS PR: the root Vitest suite itself, run locally
// against this train's merged head (branch rc/train-d-2026-09-14, head
// 26bba2748164db75d91a47467bb1080dfeebf005) before this soak was launched.
// `npx vitest run` under vitest 5.0.0 / @vitest/coverage-v8 5.0.0, with
// src/test/setup.ts's new @testing-library/jest-dom/vitest import resolving
// and every jest-dom matcher (toBeInTheDocument, etc.) available to the
// existing frontend test suite — that IS this PR's changed behavior, proven
// where it actually runs (the test runner itself), not on a deployed worker.
//
// This module exists (rather than being omitted from TRAIN_PROBES) so the
// train's per-cycle evidence file has an explicit, auditable record of WHY
// #2887 carries no targeted assertion, instead of a silent gap a reader
// might mistake for an oversight.

export const pr = '#2887';

export const changedBehavior = [
  'Root-only: vitest 4 -> 5 (+ @vitest/coverage-v8 5.0.0),',
  'src/test/setup.ts imports @testing-library/jest-dom/vitest. No',
  'services/worker file is touched, so nothing this PR changes is present',
  "in the deployed worker image (worker's Docker build context is",
  'services/worker/, not repo root) or reachable via any HTTP route on this',
  'or any rig. Real evidence is the root Vitest suite passing under vitest 5',
  "against this train's merged head, verified locally before this soak",
  'launched — not this module. This module records that fact every cycle',
  'rather than fabricating a health-check-as-coverage assertion.',
].join(' ');

export async function run(_ctx) {
  return [
    {
      name: '2887_no_worker_reachable_surface_documented',
      expected: true,
      actual: true,
      pass: true,
      detail: 'Root-only change (package-lock.json, package.json, src/test/setup.ts); no services/worker file touched; no HTTP route exercises it. See module header for the real evidence (root vitest suite, run locally, not on this rig).',
    },
  ];
}

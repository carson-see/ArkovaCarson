# Run every required gate on a head BEFORE pinning it for a soak window

Founder directive, 2026-09-22 ("Stop with the re-soaks. Time is money and you're
wasting both. Get these done right the first time."), after Train C's sealed
4-hour T2 window on PR #3054 was voided by a SonarCloud S5850 finding that
three review rounds had not run.

## Why

A soak window binds evidence to an **exact head SHA**. The gate
(`scripts/ci/check-staging-evidence.ts`) fails closed on head staleness: the
post-soak allowance covers T0 files only, and the residual-risk note waives
only rig contamination. So any red required check found *after* the clock
starts forces a new head, which voids the window — 4 h (T2) or 24 h (T3) of
rig time and a full CI matrix, spent proving nothing. The review rounds that
pinned Train C's head checked correctness thoroughly and never ran the
required-check lints; the defect they missed was a lint, not a bug.

## How to apply

Before a head is pinned (the soak clock starts, the RC manifest names it, the
body's `PR head SHA:` is written):

1. **Every required check green on that exact head** — the full CI matrix,
   SonarCloud Code Analysis, Dependency Scanning (all ~26 steps), Policy Lints.
   A draft PR skips most of the matrix, so ready it (with `do-not-merge` on if
   it must not be queued) and let the one matrix run first. That matrix is
   spent exactly once per head either way; running it *before* the window is
   free, running it *after* can cost the window.
2. **Run the same gates locally first** so the hosted matrix is a confirmation,
   not a discovery: `npm run typecheck`, `npm run lint`, `npm run lint:copy`,
   `services/worker` `npm run lint` + `vitest run`, the Dependency Scanning
   job's steps (`awk` them out of `.github/workflows/ci.yml`), and
   `check()` from `check-staging-evidence.ts` against the intended body and
   the real changed-file list.
3. **Sonar-class lint on the delta**: grep added lines for unanchored
   alternation (`/^A|B/` — S5850), and for functions whose cognitive
   complexity is at the S3776 threshold. SonarCloud is a required Mergify
   check; a red there after the seal is a voided window.
4. Only then send the pin. A head that is not fully green is not a candidate.

Two voided windows on #3054 alone (S5850 regex; then the job_queue-parity
guard on the lease dirty marker) were both findable in under ten minutes
locally. Neither needed a rig.

## Related

- `feedback_no_prs_for_t0.md` — the matrix-spend rationale this extends.
- CLAUDE.md §0 rule 11 — one matrix per head, no re-run-all.
- `project_base_refresh_destroys_soak_evidence.md` (session memory) — the
  same head-binding rule from the other direction.

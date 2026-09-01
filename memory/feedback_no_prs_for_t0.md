# T0 changes commit directly to `main` — never open a PR for one

Founder directive, 2026-09-01, restated the same day.

## Why

Every PR fires the full check matrix — Tests, E2E, CodeQL, SonarCloud, Lighthouse,
Supabase Preview, the staging-evidence gate, and Mergify's speculative queue runs.
On a T0 — docs, CI tooling, tests, a harness script — every one of those minutes is
spent proving something that cannot reach production.

This was raised as a **budget** problem, not a style preference: it is a direct,
measurable cost against the GitHub Actions allowance.

## How to apply

1. Confirm the change is genuinely T0 by **running** `requiredTierFor()` against the
   real changed-file list. Never infer the tier from the PR title — that has been
   wrong repeatedly. A single file under `services/worker/src/api/` makes the whole
   change T2 no matter how small the diff.
2. Confirm nothing is embarked in the Mergify queue. A direct push to `main`
   invalidates an embarked train's pinned base and livelocks it — see
   [[feedback_docs_push_livelocks_mergify]].
3. `git commit` + `git push origin main`.

## The exceptions

- **A change to a merge gate itself** — `scripts/ci/check-staging-evidence.ts`, and
  anything else under `scripts/ci/` that decides whether other PRs may merge — still
  needs a PR. `scripts/ci/agents.md` records the FD-GATE-3 precedent: the gate that
  decides whether other PRs may merge must not be self-merged on its own green
  checks. A gate that can wave its own changes through is the self-referential hole
  closed over 2026-08-29..31.
- **`CLAUDE.md` rule changes**, per its own §0 rule 8: the constitution is the one
  doc that gets the second look.

Related: [[feedback_no_prs_for_doc_updates]] is the narrower docs-only carve-out that
this generalises.

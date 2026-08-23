# FD-SDK-1 — SDK/package PRs are classified T2 but cannot reach the unsoakable-evidence path, because one CI file in the diff disqualifies them

**Found:** 2026-08-21, triaging #2247, #2252, #2274.
**Class:** structural gate deadlock. Same family as [[FD-RC-1]]: the gate demands evidence the PR's own shape makes impossible to produce.

## The finding

`scripts/ci/check-staging-evidence.ts` has an escape hatch for surfaces with no worker
runtime to soak:

```ts
function isUnsoakableEvidencePath(declared, required, files) {
  return declared === 'T2' && required === 'T2' && isOfflinePackageOnlyChange(files);
}
```

and `isOfflinePackageOnlyChange` requires that **every** changed file is under
`packages/` or `sdks/`, explicitly rejecting:

```ts
&& !f.startsWith('.github/workflows/')
&& !f.startsWith('scripts/')
```

The rejection is deliberate and correct in intent — a PR that edits CI or migrations is
not "purely offline". But in practice an SDK change almost always ships with the CI wiring
that builds, tests or publishes it. One such file collapses the whole PR back onto the full
worker-evidence path.

## Observed

All three PRs fail the live gate with the identical error — the full T2 worker field set:

```
`## Staging Soak Evidence` section is missing required fields for T2:
`Staging branch:`, `Worker revision:`, `Staging project ref:`, `Cloud Run service/tag URL:`,
`Image digest:`, `Evidence scope:`, `Preflight timestamp:`, `Preflight result:`,
`Soak start:`, `Soak end:`, `E2E result:`, `Migration applied:`, `Rollback rehearsed:`,
`Staging deploy log id:`.
Evidence scope must be one of: merge-grade shared staging, merge-grade isolated staging.
```

The disqualifying files:

| PR | Surface | Files that block the offline-only test |
|---|---|---|
| #2247 | `packages/arkova-py` | `.github/workflows/ci.yml`, `scripts/ci/ci-workflow-contract.test.ts` |
| #2252 | `packages/arkova-py` | `.github/workflows/{agents.md,ci.yml}`, `.mergify.yml`, `scripts/ci/*` |
| #2274 | `packages/sdk`, `sdks/mcp-server` | `.github/workflows/publish-sdk.yml`, `scripts/publish-packages.sh`, `scripts/release/publish-npm.sh`, `src/pages/DevelopersPage.tsx`, `e2e/`, `docs/api/*`, `HANDOFF.md` |

None of these PRs deploys a worker revision, so `Worker revision:`, `Image digest:` and
`Staging deploy log id:` have no truthful value available. The demanded evidence does not
exist and cannot be manufactured without fabricating it.

## There is no other hatch

- `hasResidualRiskException` (`### Residual-risk note`) is scoped to **DB contamination**
  (`Contamination type:`, `Affected rows:`, `Reason not cleaned:`). It is not a
  no-worker-to-soak exception and is not consulted on this path.
- `hasUnsoakableSurfaceNote` exists and has the right fields (`No worker runtime:`,
  `Surfaces touched:`, `Approved by:`) — but it is only ever reached **inside**
  `unsoakableT2Result`, which `isUnsoakableEvidencePath` already gated out.
- There is no override label for SDK paths.

So the note that describes exactly this situation is unreachable for exactly the PRs that
need it.

## Options

1. **Split each PR** so the diff is `packages/`/`sdks/`-only, and land the CI/workflow/script
   half as its own T0 PR. Works today with no gate change. Costs a head rewrite per PR and
   re-runs CI — and per `feedback_pr_head_sha_in_evidence_block`, any evidence block already
   written against the old head must be re-stamped.
2. **Narrow the denylist** so `.github/workflows/` and `scripts/` files that only build,
   test or publish the package do not disqualify it. Precise but needs care to stay
   fail-closed — the current bluntness is what makes it safe.
3. **Carson §1.12 exception** per PR, recorded in the body.

Recommendation: (1) for #2247 and #2252, which are small and nearly package-only. #2274 is
a genuinely mixed change (it touches `src/pages/DevelopersPage.tsx`, `e2e/`, served API docs
under `docs/api/`) and is **correctly** classified T2 — it should not take the unsoakable
path at all, and it additionally has a real red `Tests` run to fix first.

## The rule this is a case of

Before writing evidence to satisfy a gate, check the gate can be satisfied **truthfully** at
all. If the required fields have no real value for this PR's shape, the answer is to change
the PR's shape or the gate — never to fill the fields in.

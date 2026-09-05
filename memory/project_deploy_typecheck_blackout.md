---
name: deploy-typecheck-blackout
description: A TypeScript error in a worker TEST file used to pass every PR check and fail only post-merge in the deploy gate, blacking out ALL prod worker deploys while `main` kept merging. Three tsconfig scopes disagreed; three parity gates now hold them together.
type: project
---

The worker's compile surface was covered by three different tsconfig scopes, and no single PR-time check ran the one the deploy gate ran. The gap was narrow — worker **test** files — and the blast radius was total: every production worker deploy, for as long as it took someone to notice.

**The three scopes, and why they left a hole:**

| Surface | Config it compiles | Sees `services/worker/src/**/*.test.ts`? | When it runs |
|---|---|---|---|
| Root `npm run typecheck` | root `tsconfig.json` — `"exclude": ["services", …]` | No. It never sees worker source at all. | Every PR |
| `Worker Build (deploy-parity)` | `services/worker/tsconfig.build.json` — excludes `src/**/*.test.ts` / `*.spec.ts` | No | Every PR, but path-gated in-job and NON-required |
| `deploy-worker.yml` → `Typecheck` | `services/worker/tsconfig.json` — `"include": ["src/**/*"]`, tests INCLUDED | **Yes** | On push to `main` — i.e. **after** merge |

So a type error in a worker test file was invisible to every gate that could block a merge, and fatal to the only gate that ran afterwards. `deploy-worker.yml` fails, no new revision ships, and because nothing about the PR flow is affected, `main` keeps accepting merges on top. Production silently falls behind by however many PRs land before someone checks `/health`. The repo's own record: SCRUM-1810 was exactly this failure, and SCRUM-3130 recorded `main` running roughly 20 merged PRs ahead of production.

**Why it is a class, not an incident.** The defect is not "someone wrote a bad test." It is that *the command the deploy gate runs was not run at PR time*. Any future divergence between a deploy-time command and its PR-time counterpart reproduces it: a Dockerfile build step CI does not run, a lint script the deploy gate invokes differently, a config file only one side reads.

**How to apply:**

- **Never let a deploy-time command exist without an identical PR-time counterpart on a REQUIRED check.** Not "an equivalent check" — the same command, same config, same working directory. `tsc -p tsconfig.build.json` is not a substitute for `tsc --noEmit`; the configs differ in exactly the files that broke this.
- Hosting the counterpart matters as much as having it. A new top-level CI job is not in branch protection or `.mergify.yml merge_conditions`, so it reports without blocking. Adding a **step to an already-required job** closes the gap without touching branch protection (a Carson/admin surface). The `Typecheck worker (deploy-gate parity)` step lives inside `typecheck-lint`, which `.mergify.yml` requires as `TypeCheck & Lint`.
- The step must carry **no `if:` guard and no path filter** — a test-only edit is precisely the change that triggers this class, and a path filter would let it through.
- When you see `main` ahead of production, do **not** assume this class. Confirm it. Worker deploys are also path-filtered, and `DEPLOY_WORKER_PAUSED` is an Actions variable that stops deploys entirely. Read the failing `deploy-worker.yml` run before diagnosing.
- Do not "fix" a red deploy typecheck by excluding the offending file from `services/worker/tsconfig.json`. That exclude list already carries six named test files; each one is a hole this gate cannot see through.

**Enforcement:** three sibling parity gates, all fail-closed pure file readers with no `process.env` / git dependency, so they run in the shallow-checkout `typecheck-lint` job:

- `scripts/ci/check-deploy-lint-parity.ts` — the LINT path (R0-4 / SCRUM-1250, CLAUDE.md §0 rule 9). Both surfaces must invoke `npm run lint` from `services/worker/`.
- `scripts/ci/check-deploy-build-parity.ts` — the BUILD path. `services/worker/package.json` `scripts.build`, the Dockerfile's `RUN npm run build`, and the ci.yml compile step must be the same build.
- `scripts/ci/check-deploy-typecheck-parity.ts` — the TYPECHECK path (SCRUM-1811). Asserts `deploy-worker.yml` and the ci.yml `typecheck-lint` job both run exactly `node_modules/.bin/tsc --noEmit` in `services/worker`, with no `if:` guard, and that neither step is renamed into a sibling gate's marker.

**Override label:** `ci-config-change`, at the workflow level (the ci.yml step's `if:`), not inside the scripts. A parity mismatch is never acceptable on its own merits; the escape hatch is editing the invariant in-PR under review.

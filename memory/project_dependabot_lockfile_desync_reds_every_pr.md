# A Dependabot bump can desync package.json from its lockfile and red `Tests` on EVERY open PR

Failure class. Mechanism, blast radius, and how to tell it apart from a
per-branch failure in one command.

## Mechanism

Dependabot bumps a dependency in a sub-package's `package.json` **and** that
package's own entry in `package-lock.json`, but does not add the new version's
**transitive** dependencies to the lock. `npm install` would resolve them;
`npm ci` refuses, because its whole contract is "install exactly the lock":

```
npm error code EUSAGE
npm error `npm ci` can only install packages when your package.json and
npm error package-lock.json are in sync. …
npm error Missing: vite@8.3.0 from lock file
npm error Missing: @rolldown/binding-linux-x64-gnu@1.2.9 from lock file
…
```

Real instance: PR #3043 bumped `vitest` to 5.0.1 in `integrations/zapier`.
vitest 5 pulls vite 8, the rolldown bindings, lightningcss, postcss, nanoid,
source-map-js and `@oxc-project/types`; none reached the lock. Fixed by
`d984356de` (2026-09-22) — `npm install --package-lock-only --ignore-scripts`,
+764 lock lines, no `package.json` change, the bumped version unchanged.

## Blast radius: every open PR, not one branch

`integrations/zapier`'s `npm ci` runs inside the **required** `Tests` job
(`Validate Zapier clean installation and build`). A red there fails `Tests` for
every PR whose merge commit contains the broken lock — which, once it is on
`main`, is all of them, including Dependabot's own. On 2026-09-22 this reddened
five PRs at once and read convincingly as five separate branch problems.

The trap is that it looks per-branch: each PR shows its own red `Tests`, each
with a plausible local story ("stale base", "needs a rebase"). Two sessions
spent hours treating it that way.

## Telling it apart — one command, before any per-branch theory

Reproduce on a clean checkout of `origin/main` itself:

```bash
git worktree add --detach /tmp/wt origin/main
cd /tmp/wt/<sub-package> && rm -rf node_modules && npm ci --ignore-scripts
```

If that fails, **main is broken** and no amount of rebasing any branch will fix
it. Fix main first; every PR then needs one push to pick it up (a re-run cannot
— see below).

## Two things that do NOT work

1. **Re-running the failed job.** `actions/checkout` on a `pull_request` event
   resolves the merge commit recorded in the event payload. A re-run replays
   that payload, so it rebuilds the same merge against the same broken base.
   Only a new `synchronize` event (a push) picks up a fixed `main`.
2. **Verifying part of the step.** The workflow step runs four commands —
   `npm ci`, `npm test`, `npm run build`, `npm run validate`. Running only
   `npm test` against an already-populated `node_modules` passes cheerfully
   while `npm ci` is the thing that is broken. Run the whole step, from
   `rm -rf node_modules`, or the local green is meaningless.

## Fixing it

`npm install --package-lock-only --ignore-scripts` in that sub-package, then
verify the complete step end to end on a clean tree. Check the audit count
before and after (`npm audit --audit-level=moderate` against the old lock in a
scratch dir) and say so: regenerating a lock re-resolves the tree, and "I added
no new advisories" should be a measured claim, not an assumption. In the
2026-09-22 fix both sides were 9 (1 low, 8 high, all pre-existing dev-only
advisories via `zapier-platform-cli`).

A lockfile-only change classifies **T0** (`requiredTierFor` →
`docs/tests/CI/tooling-only`), so it lands direct on `main` per CLAUDE.md §0
rule 8 — which is what makes it a fast unblock rather than another PR queued
behind the very gate it is breaking.

## Related

- [[feedback_gates_before_pin]] — run every required check, in full, on the
  exact head, before a soak window pins it. This failure class is the reason
  the "in full" clause is there.

# FD-GATE-4 — a delete-only PR is invisible to the tier detector and merges with no soak

**Filed:** 2026-08-22
**Severity:** High (soak-gate bypass), **latent** — no delete-only commit exists in `main`'s last
400, so this has never fired. It is a hole, not an incident.
**Status:** OPEN. Demonstrated end-to-end below.

## The finding

`scripts/ci/lib/ciContext.ts:337` computes every path-gated check's input with:

```ts
const args = ['diff', '--name-only', '--diff-filter=AMR', `${base}..HEAD`];
```

`AMR` = **A**dded, **M**odified, **R**enamed. **`D` (deleted) is excluded.** A PR whose changes
are *exclusively deletions* therefore produces an **empty** changed-file set.

`scripts/ci/check-staging-evidence.ts:915`, the first line of `requiredTierFor`:

```ts
if (files.length === 0) return { tier: 'T0', reason: 'no changed files' };
```

**Empty set → T0 → no staging soak evidence required.**

## Demonstrated, not reasoned

In a throwaway worktree off `main`, deleting one T3-classified file and nothing else:

```
$ git rm services/worker/src/chain/fee-estimator.ts   # chain/treasury hot path, T3
$ git diff --name-only --diff-filter=AMR BASE..HEAD
                                                      # ← 0 files. empty.
$ git diff --name-only --diff-filter=D    BASE..HEAD
services/worker/src/chain/fee-estimator.ts
```

`requiredTierFor([])` → `{ tier: 'T0', reason: 'no changed files' }`.

So a PR that deletes the fee estimator — or an RLS policy test, or a security guard — is
classified **CI-only** and asked for **nothing**.

## No compensating control exists

Every `--diff-filter` in the repository, checked:

| Location | Filter | Includes `D`? |
|---|---|---|
| `scripts/ci/lib/ciContext.ts:337` | `AMR` | **no** |
| `.github/workflows/migration-drift.yml:302` | `AMR` | **no** |
| `scripts/enforce-tdd.sh:100,102` | `ACMR` | **no** |

`check-staging-evidence.ts:915` is the only empty-set handler and it returns T0. Nothing
computes deletions separately.

**The migration-drift gate has the same hole.** `migration-drift.yml:302` runs `AMR` against
`supabase/migrations/*.sql`, so **deleting a migration is invisible to it.** CLAUDE.md §1.2 says
*"Never modify an existing migration — write a compensating one."* Deleting one is strictly worse
than modifying it, and it is the case neither gate can see.

## Why the empty set is the dangerous part

This is the same failure direction the codebase has already been burned by and fixed once.
`ciContext.ts`'s own docstring on `changedFiles()`:

> A previous version swallowed the `git diff` error to `[]`, which made every path-gated check
> see "no changed files" and PASS — exactly the wrong direction for a gate.

That fix made a *diff failure* throw. It did not address a diff that **legitimately returns
empty** because the filter discarded every change. The fail-closed reasoning was applied to the
error path and not to the result path.

## Suggested fix (not written)

Two independent changes; the first is the cheap one:

1. **Include `D` in the filter** — `--diff-filter=AMRD` in `ciContext.ts:337` and
   `migration-drift.yml:302`. A deleted T3 file then classifies T3 like any other change to it.
   Check the callers first: some path-gated lints read file *contents* and must tolerate a path
   that no longer exists on disk.
2. **Make an empty set suspicious rather than free.** On a `pull_request` event an empty changed
   set is not a normal state — GitHub does not create empty PRs. `requiredTierFor([])` returning
   T0 is defensible for a non-PR context, but on a PR it should fail closed, or at minimum be
   reported so it cannot pass silently.

(2) matters more than (1): it closes the class rather than the instance. Any future filter
change, shallow-checkout quirk, or path-spec bug that empties the set inherits the same free pass.

## What this finding does NOT claim

- **Not exploited.** No delete-only commit exists in `main`'s last 400 commits. This is latent.
- It does **not** claim a mixed PR is affected: one added or modified file makes the set
  non-empty, and the deletions merely go unclassified alongside it.
- It does **not** claim the tier detector is wrong to return T0 for a genuinely empty set outside
  a PR context.

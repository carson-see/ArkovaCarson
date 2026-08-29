# FD-GATE-3 — the base-drift gate is stricter than the constitution it enforces

**Filed:** 2026-08-22
**Status:** OPEN, **substantially rewritten 2026-08-22** after the mechanism in the first
version was refuted. Read "Correction of record" first — the original diagnosis was wrong and
the wrong version was merged to `main` before it was caught.

## Correction of record — the first version of this finding was wrong

The first version claimed the gate *"invalidates soak evidence for paths the PR never touched"*
because `BASE_REF_SHA` is a frozen ref and `changedFiles()` two-dot-diffs against it. **Three
of those four claims are false.** Each was checked against the source and the clone, not
reasoned about:

| Claim (v1) | Verdict |
|---|---|
| `BASE_REF_SHA` is frozen for this gate | **FALSE.** `.github/workflows/staging-evidence.yml:112-118` live-resolves it with `gh api repos/…/pulls/N` → `.base.sha`. `scripts/ci/staging-evidence-workflow-contract.test.ts` pins that and forbids reverting to the event payload. (It **is** frozen in `ci.yml` and `merge-authority.yml` — a different, real bug; see below.) |
| The drift is misattributed main history | **FALSE.** `git merge-base --is-ancestor 5c0db595a 785c13b0c9b0` → **no**; against `406ead53a0e2` → **yes**. So `5c0db595a` is genuine main movement *between* the evidence base and the current base. `785c13b0c9b0..406ead53a0e2` is **653 files, 7 under `services/worker/src/chain/`.** Ten real days of drift. |
| The file list comes from `changedFiles()` | **FALSE.** It is `intersecting` from `driftFilesIntersectingSurface` (`check-staging-evidence.ts:2195-2202`), and `driftFiles` comes from `changedFilesBetween(evidenceBaseSha, currentBaseSha)` — a diff between two **main** commits. `changedFiles()` supplies only `ownFiles`. |
| The gate flags paths the PR never touched | **TRUE — but deliberate**, see below. |

**The suggested fix in v1 would not have worked either.** Narrowing to the PR's own files does
not unblock #2235: `ownFiles ∩ drift` is **5 files, not zero** — `scripts/ci/agents.md`,
`scripts/ci/check-hot-table-ddl-lock-timeout.{ts,test.ts}`, `services/worker/src/routes/agents.md`,
`src/lib/copy.ts` — and `requiredTierFor` over those five returns **T1** (via `src/lib/copy.ts`).
The escape hatch only opens at T0, so #2235 would fail identically, just naming a different file.

**How this happened, recorded because it is the reusable part:** the mechanism was inferred from
the gate's error message and from a comment in a neighbouring file, and filed without reading
either `driftFilesIntersectingSurface` or the workflow that sets the env var. Both are ~30 lines
and would have refuted it immediately. This is the same failure the findings index exists to
catch — a plausible mechanism that matches the symptom is not a verified one — and it reached
`main` before three independent adversarial reviews caught it.

## What is actually true

`driftFilesIntersectingSurface` is an **OR**, and its name says "Intersecting":

```ts
return driftFiles.filter(
  (f) => surface.ownFiles.has(f) || surface.sharedPatterns.some((re) => re.test(f)),
);
```

`sharedPatterns` is `SHARED_PROD_RUNTIME_RULES` (`:271-273`) — **every `PATH_RULE` at T2 or
above**, a static list that never consults the PR's diff. `/^services\/worker\/src\/chain\//`
is in it for every T2/T3 PR. So a PR owning zero chain files is invalidated by chain-only drift.

**That behaviour is intentional and test-pinned.** `check-staging-evidence.test.ts:2926-2934`:

```ts
const r = driftCheck(['services/worker/src/api/v1/docusign.ts'], ['services/worker/src/chain/client.ts']);
expect(r.ok).toBe(false);
```

It is defensible: if `main` changed the chain hot path under you, your soak ran against a worker
that no longer exists. **This is a policy question, not a plumbing bug**, and anyone proposing to
change it must argue with that test, not around it.

## The actual defect — the gate is harsher than CLAUDE.md

`baseDriftImpactErrors` (`:2240-2270`) has exactly **two** outcomes above "no intersection":

1. **Whole drift is T0** → the `Base drift impact:` attestation hatch opens (needs the changed
   files, a no-runtime-impact assessment, and a named approver).
2. **Anything above T0** → *"existing soak evidence cannot be preserved without release-owner
   re-scope/retest."* **Unconditional re-soak. No hatch, no attestation, no note.**

But the constitution provides a third state in both places it addresses this:

- **§1.11A**: *"…requires a new soak **or an explicit residual-risk note**."*
- **§1.12**: *"…or an explicit Carson-approved residual-risk exception."*

**The gate implements neither.** It offers the residual-risk path only when the drift is
harmless (T0) — precisely the case that least needs one — and withholds it whenever the drift
actually matters. That inversion is the defect.

## Why this is not survivable at current merge velocity

A T3 soak is **48 hours**. On 2026-08-22 `main` took **23 PRs**. Any 48-hour window will contain
`main` commits touching some T2+ path, and `SHARED_PROD_RUNTIME_RULES` matches
`/^services\/worker\/src\//` wholesale, so essentially every worker commit qualifies. Combined
with outcome 2, a T3 PR can be re-soaked indefinitely and never converge — the same shape as
[[FD-RC-1]]: individually reasonable rules that are collectively unsatisfiable.

## What to actually do

**Not** the v1 fix. The narrow, defensible change is to give outcome 2 the third state the
constitution already names: an auditable, named, file-enumerating residual-risk attestation for
above-T0 drift — while keeping an unconditional hard fail for the cases where an attestation
cannot honestly cover the risk:

- `main` edited **an exact file this PR soaked** at T2+ (the evidence provably describes code
  that no longer exists), and
- the PR owns a `supabase/migrations/` file **and** `main` landed a migration in the interval
  (ledger ordering is shared mutable state and cannot be attested away).

Any such change is a **§1.12/§1.13 policy change requiring a named approver**, not plumbing, and
it edits the gate that decides whether other PRs may merge — so it must not be self-merged on
its own green checks.

## Two separate, real defects found while investigating — neither is this one

1. **Frozen base in the OTHER workflows.** `ci.yml` (`BASE_REF_SHA: ${{ github.event.pull_request.base.sha }}`,
   line 34 and repeated) and `merge-authority.yml:47` **do** use the frozen event-payload sha,
   and neither checkout pins a `ref:`, so `HEAD` is `refs/pull/N/merge` which GitHub recomputes
   against current `main`. `frozenBase..HEAD` therefore charges `main`'s intervening commits to
   the PR — inflating `compute-merge-authority.ts`'s tier and the `needs-carson-merge` label, and
   letting the feedback-rules scans flag files `main` authored. **This is the bug v1 described,
   in the jobs v1 did not look at.**
2. **Raw-head fallback.** `staging-evidence.yml:127-139` falls back to the branch head when
   `mergeable_state` is dirty/unknown; there `base..HEAD` with `--diff-filter=AMR` does attribute
   `main`'s post-fork changes to the PR.

Also noted: `--diff-filter=AMR` drops deletions, so a PR that only **deletes** a T3 file yields
zero changed files and classifies T0.

## Currently blocked by outcome 2

- **#2235** — non-draft, 34 green, carries a complete T3 evidence block; this is its only
  substantive failure. It owns migrations **0411/0412/0413, already applied to production**, so
  the gate is holding closed the PR that would reconcile a prod-ahead-of-`main` ledger divergence.
- **#2314** — the FD-FERPA-1 fix for a **live** production privacy exposure. Its code is verified
  (`rls-tests` green, 23 files, including the non-vacuity control).

## What this finding does NOT claim

- It does **not** claim the drift rule is a bug. It is deliberate and test-pinned.
- It does **not** claim either PR is safe to merge.
- It does **not** invoke the *"release-owner re-scope/retest"* escape: under §1.12 that is a
  Carson-approved residual-risk exception. This documents the mechanism so the call is made on
  the facts.

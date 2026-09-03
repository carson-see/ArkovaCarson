# FD-RC-1 — an RC manifest asserting soak coverage cannot be retrofitted onto an already-soaked PR

**Filed:** 2026-08-21
**Severity:** Process / throughput (no production impact)
**Found while:** trying to unlock 32 gate-failing PRs by centralising wave3's soak
evidence in an RC manifest

## The live-lock

Three rules interact to make retrofitting impossible:

1. **The manifest must exist in the PR's checked-out tree.** The gate loads it from the PR
   head, not the merge preview. Verified: with the manifest committed to `main` but the PR
   not restacked, the gate fails with
   `RC manifest docs/staging/rc-manifests/rc-2026-08-21-wave3.json was not found in the checked-out PR tree.`
2. **Getting it into the tree requires restacking**, which changes the PR head.
3. **Default `head_binding: exact` requires `included_prs[].head_sha` to equal the *live*
   PR head.** Verified after restacking #2272:
   `RC manifest current PR entry head SHA 08014061b40f… does not match current PR head 7e59e4b8e881…`

Naming the new head means committing an updated manifest to `main` — which the PR's tree
does not contain, so it must restack again, which changes the head again. **Infinite
regress.**

The gate's own source anticipated this. It used to offer a second mode, `roster`, on the
grounds that:

> exact-head binding proves nothing about safety … while costing a manifest re-commit per
> push — the same live-lock as the base problem.

**`roster` mode was REMOVED on 2026-08-23 (SCRUM-3533) and is no longer an option.** It was
reachable from the normal *approved* path, not only from deferred mode, so a manifest
claiming completed soak evidence could use it to merge an arbitrary post-soak head against
that evidence. Its safety argument — "the exception is not forgeable by the PR author acting
alone" — was also false at the time, because `docs/staging/rc-manifests/**` classified T0
with no CODEOWNERS (SCRUM-3542, fixed in the same change). A manifest that sets
`head_binding.mode: "roster"` now hard-fails. The live-lock this document describes is
resolved instead by `soak_mode: "deferred_consolidated_soak"`, which is gated on the
`DEPLOY_WORKER_PAUSED` repository variable that no PR author can set, and which never lets a
passing check read as "evidence present".

## What this means

**RC manifests are a train-launch artifact, not a retrofit.** The workflow they are built
for is:

1. create the manifest first, naming the frozen member heads,
2. restack the members onto it **once**,
3. freeze — no further pushes,
4. soak, then merge.

Applying one to PRs that were already soaked (as a union) and have since drifted from
`main` cannot work under `exact` binding.

## Options for already-soaked PRs, and their honesty cost

| Option | Verdict |
|---|---|
| ~~`head_binding: roster`~~ | **Gone (SCRUM-3533, 2026-08-23).** It was reachable from the approved path, so it could merge an arbitrary post-soak head against completed evidence, and the `exceptions[]` entry it relied on was mintable by the PR author. Use `soak_mode: "deferred_consolidated_soak"` instead — same "merge before the soak exists" outcome, but gated on a repository variable the author cannot set. |
| Re-soak the restacked heads | Fully honest and expensive: a fresh 12h T2 window per train on a free rig. |
| Per-PR evidence blocks | What most of these PRs need anyway, since most were never actually exercised (see below). |

## The restack itself was content-free — recorded for audit

#2272 was restacked by merging `origin/main` (clean, no conflicts). Its own contribution is
provably unchanged:

- changed-file set **identical** before and after,
- the patch for `services/worker/src/jobs/queue-digest-cron.ts` is **byte-identical**,
  md5 `610639d1c12511116398653368b35e4e` on both sides.

So the wave3 soak did cover this code; only the SHA moved. The manifest records both
`soaked_head_sha` (what the soak ran) and `head_sha` (the restacked head), so the
distinction is auditable rather than hidden.

## Consequence for the current backlog

This does **not** unlock the 32 gate-failing PRs. It was worth establishing because it
rules out the cheapest-looking path. The real position is unchanged from the wave2/wave3
maturity records:

- only **#2272** and **#2276** were ever directly exercised by a soak driver,
- **#2220, #2230, #2232, #2236** were never probed,
- **#2247, #2252, #2274** are offline package surfaces belonging on
  `isUnsoakableEvidencePath`,
- **#2211, #2233** were not covered because `/api/v1` was dark on the wave2 rig.

Most of the backlog genuinely needs soak time, not paperwork. Two rigs are free.

## Prevention

When a release train is next assembled, **write the RC manifest before the members freeze**
and restack once, up front. That is the only ordering in which `exact` binding and an
in-tree manifest can both hold.

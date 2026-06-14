# Release Drain Sync Memory - 2026-06-13

Current operational guardrails for the Train A/B release drain and adjacent soaks.

## Source Of Truth

- Train A final evidence: `/Volumes/Extreme/Arkova/release-evidence/train-a/soak-train-a-t3-cron-20260611T141256Z.json`.
- Train B final evidence: `/Volumes/Extreme/Arkova/release-evidence/train-b/soak-train-b-t3-cron-20260611T141256Z.json`.
- Fresh Train C #1154 main-sync repair evidence directory: `/Volumes/Extreme/Arkova/release-evidence/train-c/code/20260614T-main-sync-repair/`.
- T3 migration ledger Confluence page: `74022939`.
- SCRUM-2285 Confluence page: `72581121`.

## Current Production Proof - 2026-06-14 00:28 EDT

- #1169 (`fix(worker): type token-store fake KMS client`) merged at
  `2026-06-14T04:09:47Z` as
  `e795f8c8f4247b337d72bceef2687ced0aaf29ba`.
- `origin/main` is `e795f8c8f4247b337d72bceef2687ced0aaf29ba`.
- Deploy Worker run `27487930839` completed successfully, including
  pre-deploy quality gates, canary smoke, and 100% traffic promotion.
- Production `/health` returns `status=healthy`, `network=mainnet`,
  `git_sha=e795f8c8f4247b337d72bceef2687ced0aaf29ba`, `database=ok`,
  `anchoring=ok`, and `kms=ok`.
- Cloud Run `arkova-worker` latest ready revision is `arkova-worker-00902-gov`
  on image tag `e795f8c8f4247b337d72bceef2687ced0aaf29ba`.
- Migration Drift Check run `27487930828` passed for the same SHA with `48`
  local migrations, `67` prod applied keys, and `0` missing in prod.
- Main CI run `27487930827` completed successfully for the same SHA, including
  E2E, at the 2026-06-14T04:39Z check.

## Train A/B State

- The restarted 48h Train A/B soaks completed at `2026-06-13T14:12:58Z` / `2026-06-13T14:12:59Z`.
- Train A and Train B final evidence each report `2880` total cron requests, `2880` ok, zero failures, all HTTP 200.
- The discarded `20260611T121541Z` harnesses are gone. Any artifact from the discarded 12:15 UTC attempt remains diagnostic-only and must not be used as merge evidence.
- #1055 is already merged to `main` at `3f906c991988f9b2ed6e71e1a70b64020cebd2fb` and is not blocking the current train drain.

## Merge Queue Order

Do not let Mergify merge stale-base migration PRs out of order:

No Train A/B release-drain PRs remain. The strict-order tail completed with
#1122 / SCRUM-2285 / migration 0339 merged at `2026-06-13T22:26:18Z` as
`e51087a7990b349c09adca97797718a87c173e06`.

The final queue rule remains: queue exactly one migration PR at a time, and only
after it is merge-updated onto the real predecessor merge commit with required
checks green on the current head.

#1111 / SCRUM-2236 / migration 0335 merged to `main` at `2026-06-13T18:56:41Z` as `b4d6cad1144d330fbb42322fdee8112630d9f2b4`; Jira SCRUM-2236 is Done. #1112 / SCRUM-2252 / migration 0336 merged to `main` at `2026-06-13T20:12:01Z` as `21d72078259918df13b0f573bb30861f4afae5fe`; Jira SCRUM-2252 is Done. #1114 / SCRUM-2250 / migration 0337 merged to `main` at `2026-06-13T20:53:34Z` as `b73a0545a20bab0fb9682b4e346031af2ca986ba`; Jira SCRUM-2250 is Done. #1107 / SCRUM-2244 / migration 0338 merged to `main` at `2026-06-13T21:38:31Z` as `8e62198345932a8e9ff25c41421adf112e3af6a0`; Jira SCRUM-2244 is Done. #1122 / SCRUM-2285 / migration 0339 merged to `main` at `2026-06-13T22:26:18Z` as `e51087a7990b349c09adca97797718a87c173e06`; Jira SCRUM-2285 is Done.
#1122 / SCRUM-2285 / migration 0339 merged to `main` at
`2026-06-13T22:26:18Z` as
`e51087a7990b349c09adca97797718a87c173e06`; Jira SCRUM-2285 is Done.

After the A/B drain closed, dependency-lane PR #1155 was refreshed from old
base `3f906c991988f9b2ed6e71e1a70b64020cebd2fb` onto current main
`e51087a7990b349c09adca97797718a87c173e06`, reached head
`c18561bcae19510e63de74de1e84a66275e0453a`, passed required checks, entered
Mergify's queue, and was direct-merged with exact-head guard after the queue
remained pending past the batch tick. #1155 merged at
`2026-06-13T23:16:37Z` as
`7220fb4b41f2b0bae5662bbdfea721d867f53638`.
Confluence ledger footer comment `78413842` records this post-drain dependency
lane disposition.

Open-PR disposition after #1169:

- No open PR has the `dequeued` label; recent dequeued #1107, #1114, and #1122
  are merged.
- #1158 is not requeue-safe until its failed `Staging Soak Evidence Gate` is
  fixed and green. The current failure is a PR-body/evidence block requiring a
  `Tier: T1` or stronger justified declaration under `## Staging Soak Evidence`;
  do not manufacture evidence for the worker dependency bundle.
- #1154 remains a draft isolated Train C soak lane and must not be queued until
  its fresh 48h CTDL/OPS evidence closes cleanly, final evidence exists, and the
  PR body/evidence gate are truthful and green.
- #1153 has a stale green evidence gate from the superseded Train C prep/CE
  visibility lane, not completed merge-grade evidence. Keep it draft/out of
  Mergify unless the release owner explicitly closes or re-scopes it. It now has
  GitHub comment `4703319658` and the `do-not-merge` label as a hard queue
  guard; Jira `SCRUM-2402` and Confluence page `74022939` record the disposition.

## Already Closed In This Drain

- #1047 / SCRUM-2225: merged and Jira Done.
- #1101 / SCRUM-2193: merged and Jira Done.
- #1100 / SCRUM-2248: merged and Jira Done.
- #971 / SCRUM-2045: merged and Jira Done.
- #1038 / SCRUM-1611: merged and Jira Done.
- #1111 / SCRUM-2236: merged and Jira Done.
- #1112 / SCRUM-2252: merged and Jira Done.
- #1114 / SCRUM-2250: merged and Jira Done.
- #1107 / SCRUM-2244: merged and Jira Done.
- #1122 / SCRUM-2285: merged and Jira Done.

## Other Train Status

- Fresh Train C #1154 main-sync repair CTDL and OPS screens are the only active
  healthy merge-grade soak candidates:
  `train-c-code-main-sync-t3-ctdl-soak-20260614T172004Z` and
  `train-c-code-main-sync-t3-ops-soak-20260614T172004Z`.
- Latest live summaries at `2026-06-14T22:57Z`: CTDL `136/136` ok, OPS
  `1012/1012` ok, zero failures.
- Exact head `cfaee18e063e68145ef2113a563c20cece708c64`, base/prod
  `e795f8c8f4247b337d72bceef2687ced0aaf29ba`, revision
  `arkova-worker-staging-00285-yiv`, isolated Supabase `bwkskvbmcjodwxklpzyl`,
  minScale/maxScale `1/2`.
- Earliest merge-grade completion is `2026-06-16T17:22:34Z` /
  `2026-06-16 13:22:34 EDT`.
- Older Train C code-clean, mixed, quality-low-rate, and CE repaired runs are
  stopped/diagnostic/non-merge-grade unless a fresh counted soak is explicitly
  started and documented.

## Sync State

- Extreme mirror working tree `/Volumes/Extreme/Arkova/worktrees/hygiene-sync-20260603` is a local mirror with synchronized coordination docs; verify and fast-forward before treating its git HEAD as current `origin/main`.
- Crucial mirror working tree `/Volumes/Crucial X9/Arkova/arkova-mvpcopy-main` is a local mirror with synchronized coordination docs; verify and fast-forward before treating its git HEAD as current `origin/main`.
- Active Extreme checkout `/Volumes/Extreme/Arkova/arkova-mvpcopy-main` is intentionally dirty with release coordination docs/evidence; do not clean or reset it. Current prod/main proof is `e795f8c8f4247b337d72bceef2687ced0aaf29ba` after #1169.
- GitHub docs-sync branch `codex/release-drain-doc-sync-20260613` must carry the final #1122 closeout sync, post-drain #1155 dependency-lane disposition, and #1169 production deploy proof before any docs PR.

## Stale-State Trap

`memory/t2_t3_rollout_sync_20260608.md` is historical. Do not use it as current release state.

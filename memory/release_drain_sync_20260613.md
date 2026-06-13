# Release Drain Sync Memory - 2026-06-13

Current operational guardrails for the Train A/B release drain and adjacent soaks.

## Source Of Truth

- Train A final evidence: `/Volumes/Extreme/Arkova/release-evidence/train-a/soak-train-a-t3-cron-20260611T141256Z.json`.
- Train B final evidence: `/Volumes/Extreme/Arkova/release-evidence/train-b/soak-train-b-t3-cron-20260611T141256Z.json`.
- Train C code-clean evidence directory: `/Volumes/Extreme/Arkova/release-evidence/train-c/code/20260612T-clean-isolated/`.
- T3 migration ledger Confluence page: `74022939`.
- SCRUM-2285 Confluence page: `72581121`.

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

- Train C code-clean CTDL and ops screens are active and clean as of the latest local summaries: CTDL `642/642` ok, ops `4800/4800` ok, zero failures.
- Train C mixed, quality-low-rate, and CE repaired runs are non-merge-grade evidence unless a fresh counted soak is explicitly started and documented.

## Sync State

- Extreme mirror working tree `/Volumes/Extreme/Arkova/worktrees/hygiene-sync-20260603` is on `main` with synchronized coordination docs.
- Crucial mirror working tree `/Volumes/Crucial X9/Arkova/arkova-mvpcopy-main` is on `main` with synchronized coordination docs.
- Active Extreme checkout `/Volumes/Extreme/Arkova/arkova-mvpcopy-main` is intentionally dirty with release coordination docs/evidence; do not clean or reset it.
- GitHub docs-sync branch `codex/release-drain-doc-sync-20260613` carries the final #1122 closeout sync.

## Stale-State Trap

`memory/t2_t3_rollout_sync_20260608.md` is historical. Do not use it as current release state.

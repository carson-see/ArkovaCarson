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

Do not let Mergify merge this migration chain out of order:

1. #1107 / SCRUM-2244 / migration 0338 / `8f7fea5e46a494876671846c7d3ae2e2d8ddce76` / active checks running.
2. #1122 / SCRUM-2285 / migration 0339 / `06f5b75eb4225114859abaf91c61c33c05c3a258`

Queue exactly one remaining PR at a time. After each merge, transition the matching Jira issue to Done, add the closeout comment, update the Confluence ledger, and only then queue the next PR.

#1111 / SCRUM-2236 / migration 0335 merged to `main` at `2026-06-13T18:56:41Z` as `b4d6cad1144d330fbb42322fdee8112630d9f2b4`; Jira SCRUM-2236 is Done. #1112 / SCRUM-2252 / migration 0336 merged to `main` at `2026-06-13T20:12:01Z` as `21d72078259918df13b0f573bb30861f4afae5fe`; Jira SCRUM-2252 is Done. #1114 / SCRUM-2250 / migration 0337 merged to `main` at `2026-06-13T20:53:34Z` as `b73a0545a20bab0fb9682b4e346031af2ca986ba`; Jira SCRUM-2250 is Done. #1107 was merge-updated onto #1114, PR-body evidence metadata refreshed, and pushed at head `8f7fea5e46a494876671846c7d3ae2e2d8ddce76`. #1122 remains intentionally dequeued/held behind strict migration order.

## Already Closed In This Drain

- #1047 / SCRUM-2225: merged and Jira Done.
- #1101 / SCRUM-2193: merged and Jira Done.
- #1100 / SCRUM-2248: merged and Jira Done.
- #971 / SCRUM-2045: merged and Jira Done.
- #1038 / SCRUM-1611: merged and Jira Done.
- #1111 / SCRUM-2236: merged and Jira Done.
- #1112 / SCRUM-2252: merged and Jira Done.
- #1114 / SCRUM-2250: merged and Jira Done.

## Other Train Status

- Train C code-clean CTDL and ops screens are active and clean as of the latest local summaries: CTDL `604/604` ok, ops `4515/4515` ok, zero failures.
- Train C mixed, quality-low-rate, and CE repaired runs are non-merge-grade evidence unless a fresh counted soak is explicitly started and documented.

## Sync State

- Extreme mirror working tree `/Volumes/Extreme/Arkova/worktrees/hygiene-sync-20260603` is on `main` with synchronized coordination docs.
- Crucial mirror working tree `/Volumes/Crucial X9/Arkova/arkova-mvpcopy-main` is on `main` with synchronized coordination docs.
- Active Extreme checkout `/Volumes/Extreme/Arkova/arkova-mvpcopy-main` is intentionally dirty with release coordination docs/evidence; do not clean or reset it.

## Stale-State Trap

`memory/t2_t3_rollout_sync_20260608.md` is historical. Do not use it as current release state.

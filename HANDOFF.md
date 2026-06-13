# HANDOFF.md - Arkova Living State Snapshot

> **Purpose:** current operational state only. Older history belongs in git log,
> Confluence, Jira, or `memory/` snapshots.
>
> **Source-of-truth layering:**
> - **Jira** = story status, scope, acceptance criteria.
> - **Confluence** = topic docs, release ledgers, audit pages.
> - **Bug tracker** = Confluence master log; the Google Sheet is historical.
> - **HANDOFF.md** = current rolling snapshot.
> - **CLAUDE.md** = directive / rules.
> - **git log** = durable change history.

---

## Now

### 2026-06-13 16:59 EDT - Train A/B release drain active; #1107 checks running

**Current A/B evidence truth:** the restarted Train A/B T3 cron soaks completed
their full 48h windows at `2026-06-13T14:12:58Z` /
`2026-06-13T14:12:59Z`.

- Train A final evidence:
  `/Volumes/Extreme/Arkova/release-evidence/train-a/soak-train-a-t3-cron-20260611T141256Z.json`
  reports `2880/2880` HTTP 200 cron requests, zero failures.
- Train B final evidence:
  `/Volumes/Extreme/Arkova/release-evidence/train-b/soak-train-b-t3-cron-20260611T141256Z.json`
  reports `2880/2880` HTTP 200 cron requests, zero failures.
- Discarded `20260611T121541Z` A/B runners are gone and must remain
  diagnostic-only, never merge evidence.
- #1055 is already merged to `main` at
  `3f906c991988f9b2ed6e71e1a70b64020cebd2fb`; it is not blocking new
  development.

**Merged from this drain and Jira Done:** #1047/SCRUM-2225,
#1101/SCRUM-2193, #1100/SCRUM-2248, #971/SCRUM-2045, #1038/SCRUM-1611,
#1111/SCRUM-2236, #1112/SCRUM-2252, and #1114/SCRUM-2250. #1111 merged at
`2026-06-13T18:56:41Z` as `b4d6cad1144d330fbb42322fdee8112630d9f2b4`;
#1112 merged at `2026-06-13T20:12:01Z` as
`21d72078259918df13b0f573bb30861f4afae5fe`; #1114 merged at
`2026-06-13T20:53:34Z` as `b73a0545a20bab0fb9682b4e346031af2ca986ba`.

**Remaining merge order, do not reorder:**

1. #1107 / SCRUM-2244 / migration 0338 /
   `8f7fea5e46a494876671846c7d3ae2e2d8ddce76`
2. #1122 / SCRUM-2285 / migration 0339 /
   `06f5b75eb4225114859abaf91c61c33c05c3a258`

#1107 was merge-updated onto `b73a0545a20bab0fb9682b4e346031af2ca986ba`,
conflicts were resolved by preserving #1114 ordering behavior and #1107 DLQ
behavior, evidence metadata was refreshed, and head
`8f7fea5e46a494876671846c7d3ae2e2d8ddce76` is running CI. #1122 stays held so
Mergify cannot validate or merge the migration chain out of order.

**Live blocker now:** #1107 required checks must finish green, then #1107 can
be queued/merged. After #1107 actually merges: transition SCRUM-2244 Done, add
the Jira closeout comment, update Confluence page `74022939`,
merge-update/requeue exactly #1122.

**Jira/Confluence sync:** Confluence page `74022939` is updated to version 8
with #1114 merged and #1107 as the active next gate. Jira SCRUM-2250 is Done
with closeout comment `16505`; SCRUM-2244/SCRUM-2285 remain In Progress until
their corresponding PRs actually merge.

**SSD/Git sync:** active Extreme, Extreme mirror worktree, and Crucial mirror
worktree carry synchronized coordination docs for:

- `HANDOFF.md`
- `AGENTS.md`
- `docs/staging/agents.md`
- `docs/staging/t2-t3-rollout-status-20260608.md`
- `docs/runbooks/release-queue-drain-2026-06-08.md`
- `memory/README.md`
- `memory/release_drain_sync_20260613.md`
- `memory/t2_t3_rollout_sync_20260608.md`
- `supabase/migrations/agents.md`

The GitHub docs-sync branch is `codex/release-drain-doc-sync-20260613`; update
it after every merge-state change before making a docs PR.

**Other train soaks:** Train C code-clean CTDL and ops soaks are alive under
`/Volumes/Extreme/Arkova/release-evidence/train-c/code/20260612T-clean-isolated/`.
Latest local summaries are CTDL `604/604` ok and ops `4515/4515` ok, zero
failures. Train C mixed, quality-low-rate, and repaired CE attempts are
diagnostic-only unless a fresh counted soak is explicitly started and
documented.

**Next safe sequence:** poll #1107 checks, queue/merge #1107 after green,
update Jira/Confluence for SCRUM-2244 only after the actual merge, then repeat
for #1122. Keep Train C code-clean soaks monitored.

_Last refreshed: 2026-06-13 16:59 EDT by Codex using A/B final evidence JSONs,
`gh pr view/checks`, Jira/Confluence MCP updates, local screen/evidence checks,
and SSD mirror status._

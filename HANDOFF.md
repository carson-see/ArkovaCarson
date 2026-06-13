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

### 2026-06-13 15:50 EDT - Train A/B release drain active; #1112 queued

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
and #1111/SCRUM-2236. #1111 merged at `2026-06-13T18:56:41Z` as
`b4d6cad1144d330fbb42322fdee8112630d9f2b4`.

**Remaining merge order, do not reorder:**

1. #1112 / SCRUM-2252 / migration 0336 /
   `8fd4a7ad52bcd887b8e387fa8a3b2d80117e4f82`
2. #1114 / SCRUM-2250 / migration 0337 /
   `c564fc585a8cb066feffa3d0ca89ac3074150197`
3. #1107 / SCRUM-2244 / migration 0338 /
   `11f0b4c236ea762b0ccb512cb8fe0d9f04669634`
4. #1122 / SCRUM-2285 / migration 0339 /
   `06f5b75eb4225114859abaf91c61c33c05c3a258`

#1112 was dequeued after #1111 changed `main`, then merge-updated onto
`b4d6cad1144d330fbb42322fdee8112630d9f2b4`, evidence metadata refreshed,
and requeued via comment `4699564735`. Current Mergify draft is #1165 at
head `bcb913758bcb827ed13be81315059f7fdfd323d2`. #1114/#1107/#1122 stay
held so Mergify cannot validate or merge the migration chain out of order.

**Live blocker now:** #1165 queue draft checks must finish and Mergify must
merge #1112. After #1112 actually merges: transition SCRUM-2252 Done, add the
Jira closeout comment, update Confluence page `74022939`, merge-update/requeue
exactly #1114, and keep #1107/#1122 held.

**Jira/Confluence sync:** Confluence page `74022939` is updated to version 6
with #1112/#1165 as the active queue state. Jira SCRUM-2252 has release-drain
comment `16502` describing the requeue. SCRUM-2252/SCRUM-2250/SCRUM-2244/
SCRUM-2285 remain In Progress until their corresponding PRs actually merge.

**SSD/Git sync:** active Extreme, clean Extreme mirror, and Crucial mirror have
the same current coordination docs for:

- `HANDOFF.md`
- `AGENTS.md`
- `docs/staging/agents.md`
- `docs/staging/t2-t3-rollout-status-20260608.md`
- `docs/runbooks/release-queue-drain-2026-06-08.md`
- `memory/README.md`
- `memory/release_drain_sync_20260613.md`
- `memory/t2_t3_rollout_sync_20260608.md`
- `supabase/migrations/agents.md`

The GitHub docs-sync branch is
`codex/release-drain-doc-sync-20260613`, based on `origin/main` at #1111
merge commit `b4d6cad1144d330fbb42322fdee8112630d9f2b4`.

**Other train soaks:** Train C code-clean CTDL and ops soaks are alive under
`/Volumes/Extreme/Arkova/release-evidence/train-c/code/20260612T-clean-isolated/`.
Latest local summaries are CTDL `576/576` ok and ops `4314/4314` ok, zero
failures. Train C mixed, quality-low-rate, and repaired CE attempts are
diagnostic-only unless a fresh counted soak is explicitly started and
documented.

**Next safe sequence:** poll #1165/#1112 to merge, update Jira/Confluence for
SCRUM-2252 only after the actual merge, then repeat for #1114, #1107, and
#1122 in exact order. Keep Train C code-clean soaks monitored.

_Last refreshed: 2026-06-13 15:50 EDT by Codex using A/B final evidence JSONs,
`gh pr view/checks`, Jira/Confluence MCP updates, local screen/evidence checks,
and SSD mirror status._

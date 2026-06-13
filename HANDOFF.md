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

### 2026-06-13 17:52 EDT - Train A/B release drain active; #1122 final tail checks running

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
#1111/SCRUM-2236, #1112/SCRUM-2252, #1114/SCRUM-2250, and
#1107/SCRUM-2244. #1111 merged at `2026-06-13T18:56:41Z` as
`b4d6cad1144d330fbb42322fdee8112630d9f2b4`; #1112 merged at
`2026-06-13T20:12:01Z` as `21d72078259918df13b0f573bb30861f4afae5fe`;
#1114 merged at `2026-06-13T20:53:34Z` as
`b73a0545a20bab0fb9682b4e346031af2ca986ba`; #1107 merged at
`2026-06-13T21:38:31Z` as `8e62198345932a8e9ff25c41421adf112e3af6a0`.

**Remaining merge order, do not reorder:**

1. #1122 / SCRUM-2285 / migration 0339 /
   `6ca17b237b29f53a3f53fc9409e9ca2ef632c9e1`

#1122 is merge-updated onto #1107's main commit
`8e62198345932a8e9ff25c41421adf112e3af6a0`. Review hardening at head
`6ca17b237b29f53a3f53fc9409e9ca2ef632c9e1` narrows fingerprint lookup to
non-deleted `SECURED` anchors only, adds a deterministic
`created_at DESC, id DESC` tie-breaker, adds a malformed RPC payload guard,
uses the canonical not-found mock, and cleans the migration ledger.

**Live blocker now:** #1122 required GitHub checks and CodeRabbit/Mergify
summary must finish green on `6ca17b237b29f53a3f53fc9409e9ca2ef632c9e1`.
Only then requeue/merge #1122. Do not transition SCRUM-2285 Done until the PR
actually merges.

**Jira/Confluence sync:** Confluence page `74022939` is updated to version 10
and SCRUM-2285 page `72581121` is updated to version 3 with #1122 as final
tail. Jira SCRUM-2244 is Done; SCRUM-2285 remains In Progress with comment
`16508`.

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
Latest local summaries are CTDL `626/626` ok and ops `4680/4680` ok, zero
failures. Train C mixed, quality-low-rate, and repaired CE attempts are
diagnostic-only unless a fresh counted soak is explicitly started and
documented.

**Next safe sequence:** poll #1122 checks, queue/merge #1122 after green,
update Jira/Confluence for SCRUM-2285 only after the actual merge, then close
the Train A/B drain and keep Train C code-clean soaks monitored.

_Last refreshed: 2026-06-13 17:52 EDT by Codex using A/B final evidence JSONs,
`gh pr view/checks`, Jira/Confluence MCP updates, local screen/evidence checks,
and SSD mirror status._

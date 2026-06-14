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

### 2026-06-14 14:00 EDT - Prod current; fresh Train C #1154 soak running

**Current production truth:** `origin/main` and production worker health both
report `e795f8c8f4247b337d72bceef2687ced0aaf29ba`.

- #1169 (`fix(worker): type token-store fake KMS client`) merged at
  `2026-06-14T04:09:47Z` as
  `e795f8c8f4247b337d72bceef2687ced0aaf29ba`.
- Deploy Worker run `27487930839` completed successfully: pre-deploy quality
  gates passed, canary smoke passed, and canary was promoted to 100% traffic.
- Production `/health` is healthy on `mainnet` with `database=ok`,
  `anchoring=ok`, and `kms=ok`.
- Cloud Run `arkova-worker` latest ready revision is `arkova-worker-00902-gov`
  on image
  `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:e795f8c8f4247b337d72bceef2687ced0aaf29ba`.
- Migration Drift Check run `27487930828` passed for the same main SHA with
  `48` local migrations, `67` prod applied keys, and `0` missing in prod.
- Main CI run `27487930827` completed successfully for the same main SHA,
  including E2E.

**Finished-soak PR state:** all Train A/B finished-soak PRs are merged. There
is no finished-soak PR left waiting for Mergify pickup.

**Open queue state:** there is no open non-draft green PR currently ready for
Mergify pickup. #1158 is the only non-draft recent open PR, and it is not
queue-safe. Its failed `Staging Soak Evidence Gate` is a PR-body/evidence block:
the log requires a `Tier: T1` or stronger justified declaration under
`## Staging Soak Evidence`. Do not requeue or force it until the dependency
bundle has valid risk classification and evidence. #1154 remains a draft Train C
soak lane and must stay out of queue until its fresh 48h evidence completes.
#1153 has an old green `Staging Soak Evidence Gate`, but it is not a
completed-soak landing PR: the gate predates valid Train C 48h completion and
belongs to the superseded Train C prep/CE visibility lane. It has GitHub
comment `4703319658`, the `do-not-merge` label, and must remain draft/out of
Mergify unless explicitly closed or re-scoped by the release owner.

**Train C #1154 fresh main-sync repair soak:** the only active healthy
merge-grade candidate is under
`/Volumes/Extreme/Arkova/release-evidence/train-c/code/20260614T-main-sync-repair/`.
Active screens are `train-c-code-main-sync-t3-ctdl-soak-20260614T172004Z` and
`train-c-code-main-sync-t3-ops-soak-20260614T172004Z`. Latest local summaries at
`2026-06-14T22:57Z` are CTDL `136/136` ok and OPS `1012/1012` ok, zero failures.
Head `cfaee18e063e68145ef2113a563c20cece708c64` is based on/prod-matched to
`e795f8c8f4247b337d72bceef2687ced0aaf29ba`; revision
`arkova-worker-staging-00285-yiv`; image digest
`sha256:aaff2831bc1f68d2ba919767ac3c10a68d9f37200230d734198377253f1c0303`;
isolated Supabase `bwkskvbmcjodwxklpzyl`; minScale/maxScale `1/2`. Earliest
merge-grade completion is `2026-06-16T17:22:34Z` /
`2026-06-16 13:22:34 EDT`.

Older Train C CE, mixed, quality, and code-clean artifacts are stopped or
diagnostic/non-merge-grade. Do not cite them as healthy active soaks.

**Docs/Jira/Confluence:** Jira SCRUM-2402 comments through `16542`,
SCRUM-2295 comment `16524`, Confluence page `74022939`, and Confluence PRD page
`77758466` record this corrected state. Keep this file and
`memory/release_drain_sync_20260613.md` mirrored across the Extreme and Crucial
SSD sync worktrees.

### 2026-06-13 19:18 EDT - Train A/B drain closed; dependency lane resumed

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
#1107/SCRUM-2244, and #1122/SCRUM-2285. #1111 merged at `2026-06-13T18:56:41Z` as
`b4d6cad1144d330fbb42322fdee8112630d9f2b4`; #1112 merged at
`2026-06-13T20:12:01Z` as `21d72078259918df13b0f573bb30861f4afae5fe`;
#1114 merged at `2026-06-13T20:53:34Z` as
`b73a0545a20bab0fb9682b4e346031af2ca986ba`; #1107 merged at
`2026-06-13T21:38:31Z` as `8e62198345932a8e9ff25c41421adf112e3af6a0`;
#1122 merged at `2026-06-13T22:26:18Z` as
`e51087a7990b349c09adca97797718a87c173e06`.

**Remaining Train A/B merge order:** none. The strict-order migration tail is
complete.

#1122 was merge-updated onto #1107's main commit
`8e62198345932a8e9ff25c41421adf112e3af6a0`, required checks went green, and
the PR was direct-merged with exact-head guard after Mergify queue remained
pending. Review hardening at head
`6ca17b237b29f53a3f53fc9409e9ca2ef632c9e1` narrows fingerprint lookup to
non-deleted `SECURED` anchors only, adds a deterministic
`created_at DESC, id DESC` tie-breaker, adds a malformed RPC payload guard,
uses the canonical not-found mock, and cleans the migration ledger.

**Closeout:** no Train A/B release-drain PRs remain. Continue monitoring the
fresh Train C #1154 main-sync repair soaks separately; do not treat older Train C
CE/mixed/quality/code-clean diagnostics as merge-grade evidence.

**Post-drain dependency lane:** #1155 (`chore(deps): bump esbuild from 0.28.0
to 0.28.1`) was stale on base
`3f906c991988f9b2ed6e71e1a70b64020cebd2fb`. It was refreshed onto #1122's
main commit `e51087a7990b349c09adca97797718a87c173e06`, reached head
`c18561bcae19510e63de74de1e84a66275e0453a`, passed required checks, entered
Mergify's queue, then was direct-merged with exact-head guard after the queue
remained pending past the batch tick. #1155 merged to `main` at
`2026-06-13T23:16:37Z` as
`7220fb4b41f2b0bae5662bbdfea721d867f53638`.
Confluence ledger footer comment `78413842` records this post-drain dependency
lane disposition.

**Why no other requeue happened:** no open PR currently has the `dequeued`
label. Recent dequeued release-drain PRs #1107, #1114, and #1122 are already
merged. #1158 is not requeue-safe: it is a worker dependency bundle with a
failed `Staging Soak Evidence Gate`. Train C PRs remain drafts or isolated soak
lanes and must not be queued until their own evidence closes.

**Jira/Confluence sync:** Confluence page `74022939` is updated to version 11
and SCRUM-2285 page `72581121` is updated to version 4 with #1122 merged.
Jira SCRUM-2285 is Done with closeout comment `16509`. Parent epic SCRUM-1703
remains In Progress because it still has open non-Done children; state-sync
comment `16510` records that disposition.

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

**Other train soaks:** only fresh Train C #1154 main-sync repair CTDL/OPS soaks
are active and clean. Older Train C code-clean/CE/mixed/quality attempts are
diagnostic/non-merge-grade unless a fresh counted soak is explicitly started and
documented.

**Next safe sequence:** keep Train C #1154 main-sync repair soaks monitored
through their 48h windows and final evidence. Do not undraft, requeue, merge, or
mutate #1154 until the full evidence gate is truthful and green. Do not restart,
merge, or mutate other trains without a fresh release-owner lane decision.

_Last refreshed: 2026-06-14 14:00 EDT by Codex using A/B final evidence JSONs,
Train C #1154 fresh summary JSONs, `screen -ls`, `ps`, `gh pr view/list`, prod
`/health`, GitHub run checks, Jira/Confluence MCP reads, and SSD mirror status._

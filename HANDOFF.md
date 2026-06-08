# HANDOFF.md — Arkova Living State Snapshot

> **Purpose:** Current state of the project. Updated at the end of every session. Kept ≤150 lines — anything older goes to git log or the archive.
>
> **Source-of-truth layering (2026-04-21):**
> - **Jira** = story status, scope, acceptance criteria → https://arkova.atlassian.net/jira/software/projects/SCRUM
> - **Confluence** (space "A") = topic docs + per-epic audit pages → https://arkova.atlassian.net/wiki/spaces/A
> - **Bug tracker** = Confluence [Master Log](https://arkova.atlassian.net/wiki/spaces/A/pages/28115270) (canonical since 2026-04-26; the Google Sheet is historical archive only)
> - **HANDOFF.md** (this file) = rolling snapshot of *now*, not history
> - **CLAUDE.md** = directive / rules
> - **git log** = what changed, by whom, when

---

## Now

### 2026-06-08 10:33 EDT - T2 closure, SSD sync, and T3 synchronized launch gate

**Local/GitHub hygiene:** Extreme clean `main` worktree `/Volumes/Extreme/Arkova/worktrees/hygiene-sync-20260603` and Crucial clean `main` checkout `/Volumes/Crucial X9/Arkova/arkova-mvpcopy-main` are both fast-forwarded to `origin/main` `bf40e389fd1644aea94557366e367b7b66df7616`. The active root checkout `/Volumes/Extreme/Arkova/arkova-mvpcopy-main` remains on its existing `codex/scrum-2070-docusign-rate-limit` branch with parked local coordination/evidence files; do not reset or clean it. Active #1121 soak worktree remains untouched.

**Current prod truth:** there is no `prod` branch/ref. Production is verified by deploy/revision-drift/health evidence. `origin/main` is `bf40e389fd1644aea94557366e367b7b66df7616`; `Deploy Worker` succeeded on that SHA in run https://github.com/carson-see/ArkovaCarson/actions/runs/27112157154, Revision Drift Alert is green on that SHA in run https://github.com/carson-see/ArkovaCarson/actions/runs/27129992459, and `/health` at `https://arkova-worker-kvojbeutfa-uc.a.run.app/health` returns `status=healthy`, `git_sha=bf40e389fd1644aea94557366e367b7b66df7616`.

**T2s already merged and active in prod:** #1098 (`217a542d`), #1104 (`bf40e389`), #1108 (`b5110320`), #1110 (`f60ccef8`), #1119 (`68671aec`), and #1123 (`37d46d59`) are all merged, contained in current `origin/main`, and covered by the prod SHA above. Do not rerun those T2 soaks unless a new head/base invalidates them.

**Only live soak right now:** #1121 is the only active screen/process. Session `arkova-t2-redial-1121-79187530` is alive with node runner `/private/tmp/arkova-soaks/run-pr-1121-mcp-context-soak-template.mjs`. Candidate head `7918753029aa9b8d761930e520695e44f29bc9af`, base `bf40e389fd1644aea94557366e367b7b66df7616`. Evidence `/private/tmp/arkova-soaks/soak-pr-1121-mcp-context-redial-pvtqcpegmnoumsnklkvk-79187530-20260608T0517Z.jsonl`; stdout `/private/tmp/arkova-soaks/soak-pr-1121-mcp-context-redial-pvtqcpegmnoumsnklkvk-79187530-20260608T0517Z.stdout.log`. Latest read-only audit at `2026-06-08T14:33:57Z`: 1,552 rows, 517 health / 517 metadata / 517 `nessie_query_context`, zero bad rows/anomalies, latest context row `2026-06-08T14:33:08.227Z` HTTP 200 with valid context, 5 citations, confidence 0.79. Expected end is `2026-06-08T17:17:41.305Z` / `2026-06-08 13:17:41 EDT`. Final summary is not expected until completion.

**#1121 remaining gates before merge:** clock complete, final summary/audit, rollback proof, current required `Staging Soak Evidence Gate` green, PR body/Jira/Confluence closeout, queue/human/Mergify merge, deploy to prod, revision-drift/health proof on post-#1121 SHA, and production `nessie_query` smoke. Health evidence alone is not enough.

**Open PR queue reality:** 18 PRs are open. None of the T3s is merge-grade soaking now. #1055 is explicitly `BLOCKED / NO-START` until #1121 completes, merges, and is prod-active. #1122/#1114/#1112/#1111/#1107/#1101/#1100 are T3 migration-chain drafts on stale base `68671aec` and have PENDING deploy/preflight/smoke/rollback fields. #1047/#971/#1038 are older T3 migration-chain drafts with stale or dirty bases and stale evidence. #1087 is `do-not-merge`. #1105 is the only T0/T1 ambiguity; it is not a T2/T3 soak candidate.

**Synchronized T3 launch rule:** after #1121 prod proof exists, freeze `origin/main`, refresh or restack the eligible T3 PRs onto the same post-#1121 base/stack order, run clean-mirror or isolated preflight for each exact head, deploy exact heads with tag URL/revision/image digest, capture targeted smoke and rollback proof, then start 48h clocks as close together as the dependency graph permits. Do not start any T3 on current stale bases; that would produce non-merge-grade evidence when #1121 advances `main`.

**#1055 first T3 prep:** #1055 remains blocked/no-start, but exact-head local prep is green. `RUN_LOCAL_TESTS=1 ./pr-1055-t3-runner.sh verify-local` passed typecheck plus 6 focused worker test files / 258 tests at `2026-06-08T14:28:50Z`; log `/private/tmp/arkova-soaks/pr-1055-t3-prep/logs/local-focused-tests.20260608T142837Z.log`. Guard checks correctly reject premature start without `PR1055_ALLOW_SOAK_START=1`, reject #1121 prod-proof build while #1121 is unmerged, and reject placeholder proof text.

**Cross-system sync completed:** GitHub has rollout-sync comments on all 18 open PRs. Confluence T3 Migration Ledger Queue page `74022939` has a 2026-06-08 rollout section. Jira comments were added to SCRUM-2286 and SCRUM-2234. Confluence footer comments were added to SCRUM-2286 page `72613889` and SCRUM-2234 page `74055701`. Heartbeat automation `monitor-1104-t2-soak` was updated with the same state.

**Detailed runbook:** `docs/staging/t2-t3-rollout-status-20260608.md` and `/private/tmp/arkova-soaks/pr-1055-t3-prep/POST_1121_T3_LAUNCH_RUNBOOK.md`.

_Last refreshed: 2026-06-08 10:33 EDT by Codex using `git fetch/pull --ff-only`, `gh pr list/view/checks`, `screen -ls`, `ps`, #1121 evidence audit, #1055 guarded runner/local verification, prod `/health`, Deploy Worker run 27112157154, Revision Drift Alert run 27129992459, GitHub comment readback, Confluence readback, and Jira/Confluence write results._

### 2026-06-05 — Session close: #1022/#1031 merged, prod migrations + ledger reconciled, soak rig torn down

**12 session PRs merged to `main`** (origin/main tip `303b5fe42fdc` = PR #1031 merge): #1022 (SCRUM-2203 unembedded-records query perf), #1031 (SCRUM-1847/1869 public-anchor CPE/CLE metadata), #1023, #1025, #1029, #1034, #1043, #1045, #1050, #1051, #1061, #1066 (all confirmed merged via `gh pr list --state merged`). All 16 merged session feature branches deleted from the remote; dependabot/codex merged branches were already auto-pruned.

**Prod migrations applied + ledger reconciled to numeric versions** (verified via Supabase MCP `execute_sql` on prod `vzwyaatejekddvltxyye` `supabase_migrations.schema_migrations`): `0330_scrum2203_unembedded_records_query_perf` and `0331_scrum1847_1869_public_anchor_cpe_cle_metadata` are both in prod under their **numeric** versions (0330, 0331); the earlier `0322_bump_cloud_logging_retry_counts_rpc` + `0323_external_document_versions` catch-up are also present under numeric versions 0322/0323. Ledger reads clean numeric for 0320-0326, 0330, 0331 — no timestamp/duplicate rows in that range. (Consequence: the migration-drift gate `exempt_regex` 0322/0323 entries are now stale — see CLAUDE.md proposals below.)

**Ephemeral T3 migration-soak rig torn down** (both #1022/#1031 merged → rig no longer needed): Cloud Run `arkova-worker-migration-soak` deleted (`gcloud run services delete`, confirmed gone in `gcloud run services list`); all 4 scheduler jobs deleted (`soak-migration-health`, `soak-migration-1022-embed`, `soak-migration-1031-cpe`, `soak-migration-1031-cle`). The rig's isolated Supabase project `kihdcwoturustgpzyflj` (`arkova-migration-soak`, region us-east-2, separate from prod) could **not** be auto-paused — MCP `pause_project` requires a free-tier downgrade first (project is paid, ~$10/mo) → **flagged for Carson** to pause/delete via the Supabase dashboard. Cloud Run traffic to it is already zero.

**Endpoint hygiene (§7) — action needed:** post-teardown `gcloud run services list --project=arkova1` shows prod `arkova-worker` + 5 OTHER isolated-soak/staging services from prior sessions — `arkova-worker-staging` (PR #1045 label), `arkova-worker-pr-1052/1055/1056-staging` (open/active PRs), `arkova-worker-pr-967-staging` (PR #967). **Not deleted — flagged for Carson** (out of this session's scope; some back open PRs). `gcloud ai endpoints list --region=us-central1 --project=arkova1` shows **6 deployed Vertex endpoints — over the §7 steady-state target of 1-2**: 1× `arkova-golden-v5-reasoning-pro-20260415` + **5× duplicate `arkova-gemini-fraud-v1`** (endpoint IDs 3265.., 7543.., 7044.., 1842.., 563..). The 5 fraud-v1 duplicates are cold-spare drift; **flagged for Carson** to prune (NOT touched here — fraud detection is gated per GEMB2/Gemini-Golden state; deletes need owner sign-off).

_Last refreshed: 2026-06-05 by Claude (carson@arkova.io) — claims verified against gcloud/MCP/CI output: PRs via `gh pr list --state merged` (origin/main `303b5fe42fdc`); branch deletions via `gh api -X DELETE git/refs/heads`; prod ledger via Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye` (0330/0331/0322/0323 present under numeric versions); soak rig via `gcloud run services delete` + `gcloud scheduler jobs delete` (service+4 jobs gone, confirmed by `gcloud run services list`); Vertex via `gcloud ai endpoints list --region=us-central1 --project=arkova1` (6 deployed: 1 golden + 5 duplicate fraud-v1, flagged not touched). No new prod schema/worker state asserted beyond the migrations already merged + verified above._

### 2026-06-03 — PR queue truth + local-doc hygiene

**GitHub queue:** [PR #1078](https://github.com/carson-see/ArkovaCarson/pull/1078) (`docs: clarify copy-term baseline key`) merged via Mergify at 2026-06-03T13:36Z, merge commit `63c404cb`. [PR #1073](https://github.com/carson-see/ArkovaCarson/pull/1073) merged via Mergify at 2026-06-03T14:26Z, merge commit `0c9b891e`, after E2E and the failed-only `SonarCloud Quality Gate Config` rerun passed. Remaining open PRs are protected/evidence/draft lanes unless explicitly reclassified.

**Protected/no-touch PRs:** #1022, #1031, #1047, #1052, #1055, #1056, #967, #966, #971, #1038, #1039, #1040, #1041, #968, #958, plus #1071/#1072 evidence-gated worker dependency PRs. Treat #958 as draft/big-change prep despite docs-only label. Do not restart or invalidate any soaking/evidence PR from queue hygiene work.

**Stale PR closures (audited, not blanket stale-trust):** #1049 closed because the useful DID:web DB-error behavior is already on `main` via #1043 and the branch would regress missing/suspended-org 404s; #1016 closed after salvaging its one still-relevant doc correction into merged #1078; #1014/#1044 closed because the SearchPage bot chain did not compile and `main` already has the valid busy-state/no-results fixes; #1030 closed because it targeted a closed bot base and would move current SemanticSearch/status-display code backward. Cherry-pick nothing else from those PRs.

**Local-doc hygiene:** `docs/WORK_ITEMS.md` is demoted to a historical archive pointer; Jira remains the only live story/work-status source and Confluence remains the only live documentation source. Use `HANDOFF.md` only for current operational snapshot, not long-lived status tables.

### 2026-06-02 — Hygiene/reconciliation run: git sync, local-disk cleanup, HANDOFF trim

Cross-system hygiene pass via three parallel read-only audits (git/GitHub, Jira/Confluence, Mac-mini disk). **No prod state changed; no PRs merged; no Jira transitions.**

**Git / SSD synced:** the working checkout was sitting in detached HEAD at `a385eba7` (a stale leftover = old tip of `fix/platform-admin-org-roster-view`, already on the remote, nothing lost). Fast-forwarded local `main` `78f6c8d2` → `origin/main` **`ce407c3f`** (PR #1043 SCRUM-1922 did:web, merged 2026-06-02). `git fetch --prune` done. Removed 3 stale merged worktrees (`wt-1854`, `wt-docs`, + orphaned `superpowers` checkouts) and 2 merged branches; 3 dirty worktrees (`wt-1980/2189/2200`, uncommitted edits) left intact. 67 worktrees remain — all open-PR heads / unmerged / locked, **hands-off**.

**Open PRs: 27** — all draft / mid-iteration / soaking, treated hands-off. Migrations **0327-0331** are reserved across PRs #1047(SCRUM-2225)/#971(2045)/#1038(1611)/#1022(2203)/#1031(1847·1869) per `supabase/migrations/agents.md` — merge in prefix order. PR #1052 (the platform-admin org-roster work = the old detached HEAD) is draft, soak-gate red, **no Jira story yet** → Carson to triage/track.

**Doc drift to reconcile (not auto-fixed — needs DoD verify):** **SCRUM-1958** (semantic search, merged #964) still In Progress with **no Confluence page**; **SCRUM-1922** (did:web, merged today #1043) still In Progress and Confluence page [64258050](https://arkova.atlassian.net/wiki/spaces/A/pages/64258050) still reads "To Do — Blocked by SCRUM-1875". Both are Done-candidates (1922 also needs the >30-min-post-merge validator). Board: 56 In Progress / 28 Blocked; space-A docs otherwise fresh (≤3 days).

**Local disk (Mac-mini internal):** reclaimed **~7 GB** of regenerable junk autonomously — npm/uv/pip/node-gyp/brew/SiriTTS/Claude-ShipIt/gcloud-logs caches (~3 GB) + orphaned `~/.config/superpowers/worktrees` duplicate checkouts of merged work (~3.9 GB). Internal free **38 → 43 GiB**. Big remaining levers (Docker.raw ~25 GB, Claude Desktop `vm_bundles` 10 GB, LM Studio model 6 GB, Codex history ~4 GB) **deferred to Carson** — their apps are live or they are user data.

**Prod posture (CORRECTED 2026-06-02, self-verified):** the worker is **current**, NOT behind. Live `/health` `git_sha=ce407c3f`, `network=mainnet`, `{database,anchoring,kms}=ok`; Cloud Run rev `arkova-worker-00835-rap`, image tag `ce407c3f`, deployed 2026-06-02 14:19 UTC by [deploy-worker run 26825377305](https://github.com/carson-see/ArkovaCarson/actions/runs/26825377305) on PR #1043. The earlier "17 commits ahead → prod trails main" note was **stale/wrong**: `deploy-worker.yml` is path-filtered to `services/worker/**` and auto-deploys on every worker-touching merge (8 successful deploys 05-31→06-02); the commits after `ce407c3f` (#1023 frontend NASBA badge, this docs commit) don't touch the worker, so no deploy was owed. **did:web edge gap found + fixed:** SCRUM-1922 (#1043) shipped the worker did:web routes but missed the Vercel edge rewrites → `app.arkova.ai/.well-known/did.json` + `/orgs/:id/did.json` served the SPA, leaving `did:web:app.arkova.ai` + the SCRUM-900 published proof key `arkova-proof-2026-q2` unresolvable for external parties. Fixed via **PR #1061** (`vercel.json` rewrites, merged 2026-06-02 18:02 UTC) — **live in prod**: `app.arkova.ai/.well-known/did.json` + org did.json now return `application/did+json` with key `arkova-proof-2026-q2`. (A parallel session shipped #1061 while I built a byte-identical fix in #1064; #1064 closed as duplicate.) Also filed **SCRUM-2226** (v2/MCP `get_record`/`get_anchor` return null receipt + `Unknown` issuer for SECURED anchors; v1 correct) + **SCRUM-2227** (compliance_controls = informational CML-02 tags, mislabel risk); bug-tracker `BUG-2026-06-02-001/002`.

_Last refreshed: 2026-06-02 by Claude (hygiene run) — git claims verified against `git fetch`/`git log`/`git worktree list` (origin/main `ce407c3f`; local main fast-forwarded clean; 67 worktrees); PR set via `gh pr list` (27 open); Jira/Confluence drift via Atlassian MCP (SCRUM-1958 no page; SCRUM-1922 page 64258050 stale; 56 In Progress / 28 Blocked); disk reclaim via `df /` (38→43 GiB free). No new prod state asserted — the 2026-05-30 prod snapshot is carried forward, not re-verified._

### 2026-06-01 — audit-export org-lookup error classification (#1056, T2 draft — soak PENDING)

`services/worker/src/api/v1/audit-export.ts` misclassified a Supabase/operational failure on the `profiles.org_id` lookup as `403 Organization membership required`, hiding a 500-class fault. Both handlers (`POST /audit-export`, `POST /audit-export/batch`) used `.single()` without inspecting the returned `error`. Fix (mirrors `cpe-log-export.ts` / #1029): `.maybeSingle()` + an explicit `if (profileError) → 500` (coarse `message`/`code` log only, §1.4), reserving 403 for a successful query with a null `org_id`. TDD: two new regression cases (DB error → 500, not 403), one per handler, red→green; local check sweep clean (vitest, tsc, eslint, lint:copy). Parent feature: CML-03 / [SCRUM-267](https://arkova.atlassian.net/browse/SCRUM-267) (audit-ready GRC export, COMPLETE).

**Status:** **[#1056](https://github.com/carson-see/ArkovaCarson/pull/1056)** draft, **T2 — 12h staging soak PENDING**. No soak started: shared staging `ujtlwnoqfhtitcmsnrpq` has in-flight soaks (§1.11A). Stays draft until a clean staging window; Carson merges. No migration/RLS/schema/cron/queue surface → a clean shared-staging window suffices. Jira bug ticket + Confluence page + Bug Tracker row still outstanding.

_Last refreshed: 2026-06-01 by Claude — no prod or live-state asserted; in-flight draft PR only. Local checks (vitest / tsc --noEmit / eslint / lint:copy) clean; CI re-runs on #1056._

### 2026-05-30 (PO reconciliation pass) — last full prod-verified snapshot

A six-specialist reconciliation re-synced state against ACTUAL prod. **This is the most recent real prod verification** (carried forward above; not re-run on 2026-06-02).

**Prod truth (self-verified 2026-05-30):** last-deployed worker `git_sha 7af0ad9a` (PR #867 merge, SCRUM-1649; Cloud Run revision recorded that day), `/health` = healthy, `network=mainnet`, checks `{database:ok, anchoring:ok, kms:ok}`; last `deploy-worker.yml` run [26691941246](https://github.com/carson-see/ArkovaCarson/actions/runs/26691941246) = success. Prod DB (`vzwyaatejekddvltxyye`): RLS enabled+forced on all checked tables, **0 advisor ERRORs**, SECURITY DEFINER `search_path` 100% clean (148 funcs), migration head `0326`. `switchboard_flags`: AI_EXTRACTION/VERIFICATION_API/PROD_NETWORK_ANCHORING=`true`, SEMANTIC_SEARCH=`false`.

**Findings flagged for Carson (still open as of 2026-06-02):**
- **Bitcoin broadcast drift:** prod env `BITCOIN_UTXO_PROVIDER=mempool` → broadcast via **mempool.space**, NOT GetBlock (CLAUDE.md §1.1 asserts GetBlock-sovereign). `GetBlockHybridProvider` is built; selecting it needs `BITCOIN_UTXO_PROVIDER=getblock`. Flip = chain-touching T3. Confirm intended posture.
- **Flag env/DB divergence (fail-open hazard):** `ENABLE_SEMANTIC_SEARCH` + `ENABLE_AI_FRAUD` are OFF in DB but ON in Cloud Run env; a transient Supabase read failure trips the env fallback and silently re-enables both. Re-sync env→DB.
- **SCRUM-2203 (active prod incident):** `embed-public-records` Scheduler 500s every ~2 min (statement timeout on `get_unembedded_public_records`) since ~05-21. Fix in flight (PR #1022 / migration 0330).
- **SCRUM-1791:** `subscriptions.current_period_*` never rolls forward → entitlement gates fire on stale rows.
- **SCRUM-2193:** 2 `anchors` CHECK constraints (`cpe/cle_metadata_is_object`) are NOT VALID in prod while repo migration 0314/0315 declare them VALID — needs `VALIDATE CONSTRAINT` (`statement_timeout=0`) in a Carson psql window.
- **SCRUM-2192:** migration-ledger hygiene (54 timestamp/dup rows + 0302/0303 dup) — non-blocking; no `migration repair` without sign-off (§1.11A).

_Last refreshed: 2026-05-30 by Claude (PO reconciliation) — prod `/health` git_sha=7af0ad9a network=mainnet db/anchoring/kms=ok (self-curled); deploy-worker run [26691941246](https://github.com/carson-see/ArkovaCarson/actions/runs/26691941246) success on 7af0ad9a; prod DB via Supabase MCP on `vzwyaatejekddvltxyye` (relforcerowsecurity, get_advisors 0 ERROR, list_migrations head 0326, switchboard_flags); Cloud Run rev/env via `gcloud run services describe arkova-worker`._

---

## Open / release reference

**v1.0.0 — Platform v2 + Enterprise Hardening** (active release, Jira fixVersion `10266`, 10 epics; full status in Jira, not here):

| Priority | Epic |
|---|---|
| **Highest (P0 — blocks AI training)** | [SCRUM-1040 GEMB2](https://arkova.atlassian.net/browse/SCRUM-1040) |
| **Highest** | [SCRUM-1041 SEC-HARDEN](https://arkova.atlassian.net/browse/SCRUM-1041) |
| High | [SCRUM-1042 GCP-MAX](https://arkova.atlassian.net/browse/SCRUM-1042) · [SCRUM-1043 SOC2-TYPE2](https://arkova.atlassian.net/browse/SCRUM-1043) |
| Medium | [SCRUM-1044 MCP-EXPAND](https://arkova.atlassian.net/browse/SCRUM-1044) · [SCRUM-1046 PUBLIC-ORG](https://arkova.atlassian.net/browse/SCRUM-1046) · [SCRUM-1047 ADMIN-VIEW](https://arkova.atlassian.net/browse/SCRUM-1047) · [SCRUM-1048 CONNECTORS-V2](https://arkova.atlassian.net/browse/SCRUM-1048) · [SCRUM-1049 API-V2](https://arkova.atlassian.net/browse/SCRUM-1049) |
| Low | [SCRUM-1045 GH-CI-OPT](https://arkova.atlassian.net/browse/SCRUM-1045) |

**Gate:** [SCRUM-1040 GEMB2](https://arkova.atlassian.net/browse/SCRUM-1040) blocks further Nessie / Gemini Golden training. Vertex consolidation is Gemini-Golden-only; Nessie stays on Together.ai + Llama 3.1.

---

## Decision Log (durable)

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-24 | DocuSign completed-envelope intake uses raw-body HMAC, `organization_rule_events`, and retryable `job_queue` fetch jobs | Avoids new migrations, keeps raw Connect payloads/documents out of Postgres, gives failed fetches backoff + dead-letter. |
| 2026-04-24 | Manual rule "Run now" queues an execution row instead of synchronously running actions | Keeps the endpoint fast, preserves action-dispatch retry semantics + rate-limit controls. |
| 2026-04-23 | `search.arkova.ai` routes to `arkova.ai/o/:slug` via Cloudflare Worker | Brand-clean URL, single codebase, no auth-session leakage between public + app. |
| 2026-04-23 | Local-folder watcher deferred (cloud connectors only in v1) | Requires Electron/Tauri desktop surface; Drive + DocuSign cover ~95% of admin use cases. |
| 2026-04-23 | Vertex consolidation is Gemini-Golden-only | Nessie runs on Together.ai + Llama 3.1; no reason to migrate it. |
| 2026-04-23 | GEMB2 blocks further AI training | Avoid re-training against the old embedder; Gemini Embedding 2 is the new ground truth. |
| 2026-04-21 | `/api/treasury/health` is platform-admin-only (not org-admin) | USD aggregates are treasury state — only Arkova operators see them. |
| 2026-04-21 | Jira + Confluence are the canonical sources of truth | Repeated drift between CLAUDE.md / BACKLOG.md / Jira made the auditor view unreliable; `.md` files demoted to engineering notes. |
| 2026-04-16 | Vertex endpoint hygiene mandate | Idle intermediate-checkpoint endpoints were silently billing. Target 1–2 deployed; audit before/after tuning. |
| 2026-04-15 | Nessie strategy reset | v5 "87.2% F1" headline was measured against a non-serverless model. Narrow extraction per LoRA; deploy-proof before training. |
| 2026-03-22 | Pipeline anchoring creates individual anchors per document | Each document must appear in Treasury — batch-only is insufficient. |
| 2026-03-14 | IAIProvider as single abstraction for all AI providers | Vendor independence. |
| 2026-03-14 | MCP server uses Streamable HTTP transport | Native Cloudflare Workers compat. |

---

## Archive pointers

- Pre-2026-05-30 session narrative (2026-04 → 2026-05-29 entries): `git log HANDOFF.md` / git history.
- Pre-2026-04-21 HANDOFF.md: git history.
- CIBA release artifacts (migrations 0224–0231, worker modules, env vars): Confluence Data Model page + [ENV.md](docs/reference/ENV.md).
- `docs/archive/session-log.md` — older session notes. `docs/BACKLOG.md` — banner only, points at Jira.

---

_Last refreshed: 2026-06-05 by Claude (carson@arkova.io) — claims verified against gcloud/MCP/CI output._

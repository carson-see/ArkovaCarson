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

### 2026-06-15 — Prod migration ledger reconciled to numeric (corrects the 2026-06-05 claim)

The 2026-06-05 entry asserted 0322–0331 were reconciled to numeric versions; a later MCP `apply_migration` silently re-regressed **7** rows back to timestamp versions. Reconciled via the single §0-rule-10 operator-approved write (Carson, 2026-06-15) on prod `vzwyaatejekddvltxyye`: `UPDATE supabase_migrations.schema_migrations SET version=left(name,4) WHERE version !~ '^[0-9]{4}$' AND name ~ '^[0-9]{4}_'` (RETURNING: 0322,0323,0324,0325,0326,0330,0331 → numeric). **Verified post-write:** 0 remaining non-numeric `NNNN_` rows; numeric head **0339**; contiguous 0300–0331, 0333–0339 (**0332 is an empty gap** — never used; leave documented-dead; Train D starts at **0340**). Follow-ups (normal PR, not done here): SCRUM-2500 adds a full-ledger numeric-integrity CI audit (the migration-drift gate only checks PR-diff migrations today — which is why this re-regressed unseen); drop the stale `0322/0323` `exempt_regex` once confirmed.

Also this session (planning): §1.6A connector server-side-fingerprint carve-out committed to `main` (`f8b70d55`, DS-SEC-conditional / SCRUM-2492). MVP Train D **PRD v2** + **Sprint-1 recut** + **launch pre-mortem** in Confluence space A (pages 77758466 / 81100802 / 81199106); 21 new+amended Jira stories under label `prd-2026-06-12` (incl. launch-blockers SCRUM-2490/2491/2492/2500/2501; self-serve abuse floor 2495–2499/2478 deprioritized to fast-follow per Carson). **Train C (CE) #1146/#1148 soaks + CSI #1039/40/41 — FROZEN, untouched.**

_Last refreshed: 2026-06-15 by Claude (carson@arkova.io) — ledger reconcile verified via Supabase MCP `execute_sql` on `vzwyaatejekddvltxyye` (UPDATE … RETURNING 7 rows numeric; post-write SELECT remaining_nonnumeric=0, numeric_head=0339); §1.6A via `git push origin main` (`e795f8c8..f8b70d55`)._

### 2026-06-10 — Release queue unblocker #1141 merged; dev may resume under isolated-lane rules

**PR #1141 merged via Mergify** at 2026-06-10T15:56:23Z, merge commit `3f678e7cb7b6f0bcb954141c75094730b49ef45e`; `origin/main` now points at that SHA. The merged release-process change preserves exact PR-head evidence integrity while allowing release-owner-approved T0 docs/tests/CI/tooling-only base drift through a non-placeholder `Base drift impact:` note. Runtime, schema, migration, staging, deploy, soak-behavior, or worker-image drift still fails closed and requires re-scope/retest.

**Safe development posture:** normal dev work may resume in isolated branches/worktrees. Do not mutate shared staging, Supabase data, deployments, Mergify, branch protection, required checks, or existing release PR evidence outside an approved lane. Product/runtime/migration PRs still need their own isolated lane evidence; #1141 does not make any product PR merge-ready by itself.

**#1055 T3 soak remains active, not merge-ready:** as of 2026-06-10T15:59Z the read-only lane dashboard showed `cron ok=2495 fail=0 err=0.0% statuses[200=2495]`, final JSON missing as expected before the 48h gate completes at 2026-06-10T22:24:54Z. Main movement from #1139 was classified as T0 CI-only drift, not automatic soak invalidation; final approval still needs the evidence JSON, exact PR head verification, CI, base-drift impact approval, isolated environment verification, final preflight, and stuck-anchor smoke evidence.

**SCRUM-2312 adoption track opened:** parent Epic [SCRUM-2313](https://arkova.atlassian.net/browse/SCRUM-2313), task [SCRUM-2312](https://arkova.atlassian.net/browse/SCRUM-2312), subtasks SCRUM-2314..SCRUM-2318 plus existing SCRUM-2319 host-validation tracker and SCRUM-2324 evidence-layer taxonomy. Non-secret `staging:soak-lanes` sample captured at `/Volumes/Extreme/Arkova/release-evidence/pr-1141/scrum-2312-soak-lanes-20260610T155859Z.txt`.

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

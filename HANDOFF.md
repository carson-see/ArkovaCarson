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

### 2026-05-31 — SCRUM-2216: git commit-email fix (Vercel deploy attribution)

Repo-local git `user.email` set to the carson-see GitHub noreply `257869717+carson-see@users.noreply.github.com` (name stays `carson`). Root cause: `carson@arkova.ai` is **not** a verified email on the GitHub account, so Vercel rejected locally-authored commits — "No GitHub account was found matching the commit author email address" — and their prod/preview deploys failed (e.g. docs commit `89001140`). GitHub-authored merge commits (noreply) always deployed fine. **Validated** against Vercel deployment records (project `arkova-26`): the noreply-author commit resolved its Vercel author to `carson-see` and was no longer `BLOCKED`. Tracked as [SCRUM-2216](https://arkova.atlassian.net/browse/SCRUM-2216) (Done) + BUG-2026-05-31-002. Alternative (keeps `arkova.ai` on commits): add+verify it at github.com/settings/emails.

_Last refreshed: 2026-05-31 by Claude — root cause established using `git log --format='%ae / %ce'` (success `f4063934`=noreply, failures `89001140`/`e1ca3269`=`carson@arkova.ai`) and Vercel `list_deployments` on `arkova-26` (arkova.ai commits `state=BLOCKED`; noreply commit `e6379fde` resolved `githubCommitAuthorLogin=carson-see`). Fix = `git config --local user.email`._

### 2026-05-31 — SCRUM-2214 (PR #1002) ManageSubOrgs initial-load error state MERGED

**[PR #1002](https://github.com/carson-see/ArkovaCarson/pull/1002)** (`fix/manage-suborgs-load-error-state`, T1) is **merged to `main`** at merge commit `f4063934` (Mergify auto-merge after speculative `Tests`+`E2E` on draft #1009 passed). Bounded sibling of SCRUM-1999: `src/components/org/ManageSubOrgs.tsx` swallowed its initial sub-orgs load failure, rendering an outage as "no affiliates yet". Fix: explicit `loadError` state + `role="alert"` banner with Retry, gated to the initial-load/Retry path via `fetchSubOrgs(isInitialLoad)` so action refetch failures stay on toast. Frontend-only — no migration/worker/API/auth surface.

**Tracking:** **[SCRUM-2214](https://arkova.atlassian.net/browse/SCRUM-2214)** + subtask SCRUM-2215 → **Done** (2026-05-31); Confluence [page 68419586](https://arkova.atlassian.net/wiki/spaces/A/pages/68419586); bug **BUG-2026-05-31-001**. Vercel prod build for merge commit `f4063934` = success (17:19:26Z), fix serving in prod. TDD: 9/9 ManageSubOrgs tests green; all 14 required CI checks green.

_Last refreshed: 2026-05-31 by Claude — PR #1002 merge `f4063934` confirmed `origin/main` tip; Mergify auto-merge via queue-status bot (draft #1009); SCRUM-2214/2215 + Confluence 68419586 via Atlassian MCP; suite 9/9 (`vitest run`). Frontend-only — no prod worker/DB state asserted._

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

_Last refreshed: 2026-06-03 by Codex (queue/docs hygiene) — claims verified against `gh pr view/list`, `gh run view 26887149910`, and GitHub PR closure comments for #1049/#1016/#1014/#1044/#1030. No prod state asserted._

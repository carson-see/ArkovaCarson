# HANDOFF.md — Arkova Living State Snapshot

> **Purpose:** Current state of the project. Updated at the end of every session. Kept ≤150 lines — anything older goes to git log or the archive.
>
> **Source-of-truth layering (2026-04-21):**
> - **Jira** = story status, scope, acceptance criteria → https://arkova.atlassian.net/jira/software/projects/SCRUM
> - **Confluence** (space "A") = topic docs + per-epic audit pages → https://arkova.atlassian.net/wiki/spaces/A
> - **Bug tracker** (Google Sheet) → https://docs.google.com/spreadsheets/d/1mOReOXL7cmBNDD77TKVKF3LsdQ3mEcmDbgs5q_pTEk4
> - **HANDOFF.md** (this file) = rolling snapshot of *now*, not history
> - **CLAUDE.md** = directive / rules
> - **git log** = what changed, by whom, when

---

## Now

**End of week:** Friday 2026-04-24 EOW. 56 commits landed on main Mon–Fri across 20+ merged PRs (#466–#493). Four PRs still open at EOW: #494 (SCRUM-1161 freemail blocklist), #495 (SCRUM-727/985 live infra + 1,500 adviser records), #496 (SCRUM-1162 Middesk KYB skeleton), and an unpushed WIP on `claude/2026-04-24-scrum-1168-1169-integration-oauth` (migration 0251 + `integrations/oauth/` dir). All four await human merge per `feedback_never_merge_without_ok`.
**Network:** Bitcoin MAINNET. 1.41M+ SECURED anchors.
**Worker:** Cloud Run `arkova-worker-270018525501.us-central1.run.app` — 1GiB, max 3, KMS signing, batch 10K. Revision drifts session-to-session; check `gcloud run services describe arkova-worker` for the live revision.
**Frontend:** `arkova-26.vercel.app`, auto-deploys from main.
**DB:** Supabase `vzwyaatejekddvltxyye`.
- **Migration drift reconciled 2026-04-24 EOD** (SCRUM-1182) — all of `0224_ark105_rules_engine` through `0254_onboarding_signup_workflow` applied to prod after having been missing for ~1 week.
- Ledger drift = 0 both directions via `npx supabase migration list`.
- `0255_deferred_slow_indexes` applied as a no-op marker. All four large-table indexes (`anchors_unique_active_child_per_parent`, `idx_anchors_pipeline_status`, `idx_public_records_source_id_trgm`, `idx_anchor_proofs_batch_id`) applied on prod via Supabase MCP `execute_sql` 2026-04-24 EOD — verified via `pg_indexes` query. Runbook [docs/runbooks/supabase/long-running-migrations.md](docs/runbooks/supabase/long-running-migrations.md) documents the split-migration pattern for future large-table index adds.
- Note `0218 notifications` (org-scoped compliance alerts) and `0240 user_notifications` (user-scoped platform notifications) coexist as distinct tables.
**Tests:** 3,997 worker + 1,421 frontend green on main as of Friday EOW. +50 tests on PR #496 (Middesk KYB client/route/webhook) awaiting CI.

### 2026-04-24 — SCRUM-727 / 985 / 987 hardening pass (engineering-tractable blockers closed)

Three Sarah-Sprint-1 Priority-1 stories were already code-complete on main but Jira remained Needs Human / Blocked. This pass closed the remaining engineering DoD gaps surfaced during code review:

- **[SCRUM-987](https://arkova.atlassian.net/browse/SCRUM-987)** MCP-SEC-09 anomaly detection — fixed PII leak: `alert.summary` was shipping raw IPv4 / IPv6 / apiKeyId into Sentry's `message` field. Added `scrubFreeText` + IPv6 regex + sentinel-safe opaque-id scrub. +3 tests (`services/worker/src/mcp-anomaly-detection.test.ts`). CLAUDE.md §1.4.
- **[SCRUM-985](https://arkova.atlassian.net/browse/SCRUM-985)** MCP-SEC-08 IP allowlist — fixed `ipInCidr` out-of-range prefix (`/33`, `/-1` produced garbage mask via JS's 32-bit shift semantics); added Zod `strict()` schema for KV entries so a malformed/tampered `allow:<apiKeyId>` payload fails closed to challenge instead of silently granting access (CLAUDE.md §1.2 "Validation: Zod. Every write path"). +5 tests.
- **[SCRUM-727](https://arkova.atlassian.net/browse/SCRUM-727)** NPH-15 EDGAR Form ADV fetcher — moved the 10 req/s `delay()` inside `fetchJson` so every EDGAR call is throttled (was only on submissions, not the ticker feed); upstream non-OK now throws so the cron surfaces EDGAR outages instead of reporting "0 records, success"; if `company_tickers_exchange.json` lacks a `sic` column the fetcher now returns `[]` instead of flooding the pipeline with every public-company CIK. +4 tests covering the new behavior.

Plus test-hygiene fix: `src/ai/eval/__tests__/intelligence-eval-dataset.test.ts` was still asserting `length === 100` after KAU-06 (SCRUM-754) extended the dataset to 110; reworked to assert `>= core count` + per-core-domain exact counts + explicit Kenya/Australia coverage so future jurisdiction extensions don't flake the suite.

**Human remains on the critical path for final DoD (unchanged):**
- SCRUM-987 — bind `SENTRY_DSN` on edge worker + create Sentry saved-search across the 5 signals.
- SCRUM-985 — create Cloudflare KV namespace `MCP_ORIGIN_ALLOWLIST_KV` + bot-management rule + seed per-key allowlist entries.
- SCRUM-727 — trigger `POST /cron/fetch-edgar-form-adv` in prod (cron already wired at `services/worker/src/routes/cron.ts:779`) and verify ≥1,000 FINANCIAL records anchored.

---

## Open, current

### 2026-04-24 — HakiChain readiness documentation pass

- Created branch `codex/hakichain-readiness-docs` for documentation-only work. No app code and no migrations touched.
- Drafted `docs/compliance/hakichain-readiness-plan.md` to sequence HakiChain pilot work against existing CIBA/API/REG/PUBLIC-ORG backlog.
- Drafted `docs/compliance/africa-hakichain-readiness-matrix.md` for Kenya, Uganda, Tanzania, Rwanda, Nigeria, Ghana, and cross-border launch gating. Matrix is for counsel/product review, not legal advice.
- Updated `docs/compliance/kenya/filing-checklist.md` and Kenya README with SCRUM-1176 HakiChain local-support lane.
- Jira board updated: SCRUM-1175 and SCRUM-1176 routed to Needs Human for Claude/counsel review after the docs PR.
- Guardrail: leave `supabase/migrations` alone. Local worktree has unrelated dirty migration state and timestamp-prefixed files from other work.

### 2026-04-24 merge wave — 6 PRs landed

19 Jira stories transitioned To Do / In Progress → Done:

| PR | Commit | Scope | Stories closed |
|---|---|---|---|
| [#479](https://github.com/carson-see/ArkovaCarson/pull/479) | [8fe808d](https://github.com/carson-see/ArkovaCarson/commit/8fe808d) | CIBA-HARDEN-03 treasury health DB-error 500 + defensive env parse | SCRUM-1116 |
| [#480](https://github.com/carson-see/ArkovaCarson/pull/480) | [dc67331](https://github.com/carson-see/ArkovaCarson/commit/dc67331) | CIBA-HARDEN-04/05/06 rule wizard + worker quality + docs + migration 0236 comment-fix | SCRUM-1117, 1118, 1119 |
| [#481](https://github.com/carson-see/ArkovaCarson/pull/481) | [fe05139](https://github.com/carson-see/ArkovaCarson/commit/fe05139) | GEMB2 Vertex AI reference client + SEC-HARDEN-01/02 rotation/Secret Manager runbooks | SCRUM-1050, 1051, 1052, 1053, 1054, 1055 |
| [#483](https://github.com/carson-see/ArkovaCarson/pull/483) | [2bc9386](https://github.com/carson-see/ArkovaCarson/commit/2bc9386) | SEC-HARDEN-03 healthcheck CLI — 5 new service checks + 24 tests | SCRUM-1056 |
| [#484](https://github.com/carson-see/ArkovaCarson/pull/484) | [47a6fbe](https://github.com/carson-see/ArkovaCarson/commit/47a6fbe) | Platform v2 sprint — API v2 problem+JSON, secret rotation reminder, api_key_scopes, Vertex client, anchor revoke, cloud-logging-sink coverage, v2 search, ADMIN-VIEW copy rename, `user_notifications` table | SCRUM-1057, 1058, 1059, 1061, 1088, 1092, 1093, 1095 |
| [#485](https://github.com/carson-see/ArkovaCarson/pull/485) | [ae44be7](https://github.com/carson-see/ArkovaCarson/commit/ae44be7) | Lint-cleanup + `scripts/secrets/` secret-audit CLI (9 tests) | SCRUM-1055 (Sarah's branch; CLI prep) |

### Open cleanup PR (2026-04-24)

- [#487](https://github.com/carson-see/ArkovaCarson/pull/487) — removes 3 kenya `*3.md` Finder duplicates that were tracked before #482's gitignore pattern. Awaiting human merge. 194 untracked Finder duplicates also deleted from disk this session (dist artifacts, stale coverage files, stray docs copies). `find . -name "* [234].*" -not -path "./.claude/worktrees/*"` now returns 0 results outside worktrees.

### Migration inventory added this wave

- `0236_ark105_rules_executions_comment_fix.sql` (#480) — compensating `COMMENT ON TABLE` removes "24h" wording that contradicted the permanent unique index.
- `0239_api_key_scopes.sql` (#484) — `scopes text[]` + GIN index + RLS on `api_keys`.
- `0240_user_notifications.sql` (#484) — user-scoped platform notifications; **distinct** from 0218's org-scoped `notifications`. Five-event enum: queue_run_completed, rule_fired, version_available_for_review, treasury_alert, anchor_revoked.
- `0241_anchor_revoked_by.sql` (#484) — `revoked_by uuid` on `anchors` for ADMIN-VIEW-04 audit trail.

### Remaining CIBA v1.0 release deferrals (unchanged)

4 stories still To Do with explicit deferral rationale:

- [SCRUM-1024](https://arkova.atlassian.net/browse/SCRUM-1024) SCALE-02 — Cloud Run config human-only (`feedback_worker_hands_off`).
- [SCRUM-1027](https://arkova.atlassian.net/browse/SCRUM-1027) UX-01 — full onboarding wizard frontend; next sprint.
- [SCRUM-1028](https://arkova.atlassian.net/browse/SCRUM-1028) UX-02 — queue dashboard frontend; next sprint.
- [SCRUM-1030](https://arkova.atlassian.net/browse/SCRUM-1030) INT-13 — ATS/BGC connector; vendor + FCRA legal blocked.

**Follow-ups on the wave (not blockers):**

- Regenerate `services/worker/src/types/database.types.ts` after migrations 0236–0241 apply to prod. Blocked on human applying the migration (`feedback_worker_hands_off`).
- Human-execute SEC-HARDEN-01 rotation + SEC-HARDEN-02 Secret Manager migration per runbooks at `docs/runbooks/sec-harden/`.
- Human-run GEMB2-01 benchmark (`services/worker/scripts/benchmark-gemini2.ts`) with ADC + paste results into the Confluence "GEMB2-01 benchmark" page; unblocks GEMB2-02 implementation.

### Other elevated priorities

- [SCRUM-713](https://arkova.atlassian.net/browse/SCRUM-713) INTL — reopened 2026-04-21; 15 children (SCRUM-969..991).
- [SCRUM-550](https://arkova.atlassian.net/browse/SCRUM-550) DEP — reopened 2026-04-21; 4/23 + 9 new DEP-11..19.
- [SCRUM-551](https://arkova.atlassian.net/browse/SCRUM-551) REG — reopened 2026-04-21; 0/28 complete.
- [SCRUM-827](https://arkova.atlassian.net/browse/SCRUM-827) GME7, [SCRUM-828](https://arkova.atlassian.net/browse/SCRUM-828) GME8, [SCRUM-918](https://arkova.atlassian.net/browse/SCRUM-918) MCP-SEC — In Progress.
- [SCRUM-1000](https://arkova.atlassian.net/browse/SCRUM-1000) AUDIT-FU — story-level Confluence backfill sprint (~250 pages).
- NVI gate (epic [SCRUM-804](https://arkova.atlassian.net/browse/SCRUM-804)) = active. NDD/NSS/NTF paused.

### v1.0.0 — Platform v2 + Enterprise Hardening (filed 2026-04-23)

Single release encompassing enterprise hardening + the 2026-04-23 product-spec epics. Jira fixVersion `10266`. 10 epics:

| Priority | Epic | Stories |
|---|---|---|
| **Highest (P0 — blocks AI training)** | [SCRUM-1040 GEMB2](https://arkova.atlassian.net/browse/SCRUM-1040) | SCRUM-1050..1053 |
| **Highest** | [SCRUM-1041 SEC-HARDEN](https://arkova.atlassian.net/browse/SCRUM-1041) | SCRUM-1054..1060 |
| High | [SCRUM-1042 GCP-MAX](https://arkova.atlassian.net/browse/SCRUM-1042) | SCRUM-1061..1066 |
| High | [SCRUM-1043 SOC2-TYPE2](https://arkova.atlassian.net/browse/SCRUM-1043) | SCRUM-1072..1079 |
| Medium | [SCRUM-1044 MCP-EXPAND](https://arkova.atlassian.net/browse/SCRUM-1044) | SCRUM-1067..1071 |
| Low | [SCRUM-1045 GH-CI-OPT](https://arkova.atlassian.net/browse/SCRUM-1045) | SCRUM-1080..1083 |
| Medium | [SCRUM-1046 PUBLIC-ORG](https://arkova.atlassian.net/browse/SCRUM-1046) | SCRUM-1084..1091 |
| Medium | [SCRUM-1047 ADMIN-VIEW](https://arkova.atlassian.net/browse/SCRUM-1047) | SCRUM-1092..1098 |
| Medium | [SCRUM-1048 CONNECTORS-V2](https://arkova.atlassian.net/browse/SCRUM-1048) | SCRUM-1099..1104 |
| Medium | [SCRUM-1049 API-V2](https://arkova.atlassian.net/browse/SCRUM-1049) | SCRUM-1105..1112 |

**Gate:** [SCRUM-1040 GEMB2](https://arkova.atlassian.net/browse/SCRUM-1040) blocks any further Nessie / Gemini Golden training work. Finish Gemini Embedding 2 integration before new eval or fine-tune rounds.

**Scope clarification (from 2026-04-23 session):** Vertex consolidation covers Gemini Golden only. Nessie stays on Together.ai + Llama 3.1.

Confluence per-epic audit pages live at `/spaces/A`, watched (appear in user's Activity feed). Manual star is a one-click in the UI if desired.

---

## What just shipped (latest commits on this branch)

```
14c5bef fix(security): HMAC secret validation, PII removal, org ownership check
04cb8cb refactor: simplify sprint code — reuse gcp-auth, fix ilike injection, remove doc comments
cb33243 feat: Platform v2 sprint — 10 backlog stories (SCRUM-1056 through SCRUM-1095)
```

### Platform v2 sprint (2026-04-24) — 10 stories coded + reviewed

| Story | Title | Scope |
|---|---|---|
| SCRUM-1056 | API v2 RFC 7807 error model | `problem.ts`, `v2ErrorHandler` |
| SCRUM-1057 | Secret rotation reminder | 90-day cadence, Slack alerts |
| SCRUM-1058 | API key scopes | Migration 0236, `scopeGuard.ts` |
| SCRUM-1059 | VITE_* env audit | `src/lib/env.ts`, `vite-env.d.ts` |
| SCRUM-1061 | Vertex AI SDK client | `vertex-client.ts`, reuses `gcp-auth.ts` |
| SCRUM-1063 | Cloud Logging sink tests | 5 tests for existing sink |
| SCRUM-1088 | v2 search endpoint | cursor pagination, sanitized ilike |
| SCRUM-1092 | Copy lint enforcement | "Issue Credential" → "Secure Document" |
| SCRUM-1093 | Notifications table + dispatcher | Migration 0237, `dispatcher.ts` |
| SCRUM-1095 | Anchor revocation API | Migration 0238, org ownership check |

54 tests across 8 new test files, all passing. Security review completed: HMAC hardening, PII stripping, ilike injection fix, org ownership verification.

Full history: `git log --oneline`.

---

## CIBA artifacts (added this release)

**Schema** (migrations 0224–0231):
- `organization_rules`, `organization_rule_executions` (ARK-105)
- `SUPERSEDED` anchor status + supersede/lineage RPCs (ARK-104)
- `PENDING_RESOLUTION` + `anchor_queue_resolutions` + resolve RPC (ARK-101)
- `treasury_alert_state` singleton (ARK-103)
- `organizations.tier` + `org_daily_usage` + `increment_org_usage` RPC (SCALE-01)
- `rule_embeddings` cache (ARK-109)

**Worker modules:**
- `api/queue-resolution.ts`, `api/anchor-lineage.ts`, `api/rules-crud.ts`, `api/rules-draft.ts`
- `jobs/treasury-alert.ts`, `jobs/treasury-alert-dispatcher.ts`, `jobs/rules-engine.ts`, `jobs/queue-reminders.ts`
- `jobs/batch-anchor.audit.test.ts` (ARK-102 Trigger A/B/C pinning)
- `rules/schemas.ts`, `rules/evaluator.ts`, `rules/sanitizer.ts`
- `middleware/webhookHmac.ts` (SEC-01), `middleware/perOrgRateLimit.ts` (SCALE-01)
- `integrations/connectors/{schemas,adapters}.ts` (INT-10/12)
- `ai/ruleMatcher.ts` (ARK-109)

**Frontend:**
- `src/pages/RuleBuilderPage.tsx` (ARK-108 wizard)
- `src/components/auth/OrgRequiredGate.tsx` (UX-03)

**Env vars added** (see [ENV.md](docs/reference/ENV.md)):
- `ENABLE_WEBHOOK_HMAC` (SEC-01, default true)
- `ENABLE_RULES_ENGINE` (ARK-106, default true)
- `ENABLE_QUEUE_REMINDERS` (ARK-107, default true)
- `ENABLE_TREASURY_ALERTS` (ARK-103, default true)
- `SLACK_TREASURY_WEBHOOK_URL` (ARK-103)
- `TREASURY_ALERT_EMAIL` (ARK-103)
- `TREASURY_LOW_BALANCE_USD` (ARK-103, default 50)

---

## Decision Log (durable)

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-24 | DocuSign completed-envelope intake uses raw-body HMAC, `organization_rule_events`, and retryable `job_queue` fetch jobs | Avoids new migrations, keeps raw Connect payloads/documents out of Postgres, and gives failed fetches exponential backoff + dead-letter behavior. |
| 2026-04-24 | Manual rule "Run now" queues an execution row instead of synchronously running actions | Keeps the endpoint fast, preserves action-dispatch retry semantics, and satisfies org-admin + rate-limit controls. |
| 2026-04-24 | Clio connector is a conditional go for document-only MVP | Official Clio docs support OAuth, webhooks, documents, and region-specific API hosts; live PoC needs Carson-provisioned Clio sandbox credentials. |
| 2026-04-23 | `search.arkova.ai` routes to `arkova.ai/o/:slug` via Cloudflare Worker (option c) | Brand-clean URL, single codebase, no auth-session leakage between public + app. |
| 2026-04-23 | Local-folder watcher deferred (cloud connectors only in v1) | Requires Electron/Tauri desktop surface; 2–3 months of net-new scope. Cloud connectors (Drive + DocuSign) cover ~95% of admin use cases. |
| 2026-04-23 | Vertex consolidation is Gemini-Golden-only | Nessie runs on Together.ai + Llama 3.1; no strategic reason to migrate it. |
| 2026-04-23 | GEMB2 blocks further AI training | Avoid re-training against old embedder; Gemini Embedding 2 is the new ground truth. |
| 2026-04-23 | Feature-branch push triggers are already absent from all workflows | Audit confirmed; GH-CI-OPT epic is documentation, not workflow rewrite. |
| 2026-04-21 | `/api/treasury/health` is platform-admin-only (not org-admin) | Consistent with `/api/treasury/status`. USD aggregates are treasury state — only Arkova operators see them. |
| 2026-04-21 | Jira + Confluence are the canonical sources of truth | Repeated drift between CLAUDE.md / BACKLOG.md / Jira made auditor + stakeholder view unreliable. `.md` files demoted to engineering notes. |
| 2026-04-16 | Vertex endpoint hygiene mandate | Idle intermediate-checkpoint endpoints were silently billing. Target 1–2 deployed; always audit before/after tuning. |
| 2026-04-16 | NVI gate active for Nessie | FCRA/HIPAA/FERPA training data not verified against authoritative primary sources. Pause NDD/NSS/NTF until NVI passes. |
| 2026-04-15 | Nessie strategy reset | v5 "87.2% F1" headline was measured against a non-serverless model. Narrow extraction per LoRA; deploy-proof before training. |
| 2026-03-22 | Pipeline anchoring creates individual anchors per document | Each document must appear in Treasury — batch-only is insufficient. |
| 2026-03-22 | `VITE_CRON_SECRET` exposed to browser (admin-only pages) | Pipeline controls need auth; page gated to platform admins. |
| 2026-03-14 | IAIProvider as single abstraction for all AI providers | Vendor independence. |
| 2026-03-14 | MCP server uses Streamable HTTP transport | Native Cloudflare Workers compat. |

---

## Archive pointers

- Pre-2026-04-21 HANDOFF.md: git history.
- `docs/archive/session-log.md` — older session notes.
- `docs/BACKLOG.md` — banner only, points at Jira.

_Last refreshed: 2026-04-24 (Connectors v2 continuation: DocuSign webhook/OAuth helpers, per-rule Run now queueing, Clio spike doc. No migration files edited or pushed.)_

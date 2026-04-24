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

**Branch:** `claude/2026-04-23-ciba-harden-03-treasury-health` (SCRUM-1116 CIBA-HARDEN-03 — treasury health DB error handling + defensive env-var parse). PRs #474/476/477/478 all merged to main on 2026-04-24.
**Network:** Bitcoin MAINNET. 1.41M+ SECURED anchors.
**Worker:** Cloud Run `arkova-worker-270018525501.us-central1.run.app` — 1GiB, max 3, KMS signing, batch 10K. Revision drifts session-to-session; check `gcloud run services describe arkova-worker` for the live revision.
**Frontend:** `arkova-26.vercel.app`, auto-deploys from main.
**DB:** Supabase `vzwyaatejekddvltxyye`. 212 migrations on prod; 8 CIBA migrations (0224–0231) staged on PR #476 for merge.
**Tests:** 5,202+ green (3,841 worker + 1,361 frontend as of CIBA Sprint 3).

---

## Open, current

### CIBA v1.0 release — [SCRUM-1010](https://arkova.atlassian.net/browse/SCRUM-1010) (Jira version 10233)

20 stories. PR [#476](https://github.com/carson-see/ArkovaCarson/pull/476) is open + green (SonarCloud PASSED, CodeRabbit rate-limited not blocking), awaiting review + merge.

- **17 stories Done** (2026-04-23 closeout): SCRUM-1011..1023, 1025, 1026, 1029 (CIBA) + SCRUM-894 (API-RICH-01). All per-story Confluence pages updated + Jira transitioned. Commit chain on branch: `29349961` (Sprint 1) → `3994b2d5` (Sprint 2) → `5f4dbf14` + `d170c9a4` (Sprint 2 review) → `a77e7d9f` (Sprint 3) → `fb3b9738` (Sprint 3 review) → `8b8dc13` (treasury scope) → `0a4dfa8` (migration fix) → `38b6d03` (Sonar) → `09c9fb0` (SCRUM-894 audit).
- **4 deferred** (To Do with explicit deferral comments):
  - [SCRUM-1024](https://arkova.atlassian.net/browse/SCRUM-1024) SCALE-02 — Cloud Run config is human-only (`feedback_worker_hands_off`).
  - [SCRUM-1027](https://arkova.atlassian.net/browse/SCRUM-1027) UX-01 — full onboarding wizard frontend; next sprint.
  - [SCRUM-1028](https://arkova.atlassian.net/browse/SCRUM-1028) UX-02 — queue dashboard frontend; next sprint.
  - [SCRUM-1030](https://arkova.atlassian.net/browse/SCRUM-1030) INT-13 — ATS/BGC connector; vendor + FCRA legal blocked.

**Open follow-ups on the release:**
- Regenerate `database.types.ts` after migrations 0224–0231 apply to prod (requires live Supabase).
- Policy decision resolved 2026-04-21: `handleTreasuryHealth` is now platform-admin-only (matches `handleTreasuryStatus`).
- SCRUM-1015 (INT-10) + SCRUM-1016 (INT-12) marked **Done (scaffold)** — schemas + adapters shipped; production enablement awaits vendor onboarding (Google Cloud OAuth / Microsoft Partner / DocuSign Connect / Adobe Partner Portal).

### v1.0.0 progress (2026-04-23 session)

- **[SCRUM-1056](https://arkova.atlassian.net/browse/SCRUM-1056) SEC-HARDEN-03 (healthcheck CLI)** — PR [#483](https://github.com/carson-see/ArkovaCarson/pull/483) open. Added 5 missing service checks (github / confluence / vercel / figma / sam-gov), TDD coverage in `tests/infra/healthcheck.test.ts` (24 tests), and `scripts/healthcheck/README.md`. Awaiting review + merge.
- **Cleanup:** PR [#482](https://github.com/carson-see/ArkovaCarson/pull/482) extends `.gitignore` for `* 3.*` Finder duplicates + removes 3 stale evaluator copies in `services/worker/src/rules/`.

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
fb3b9738 fix(CIBA Sprint 3 review): correct audit category + remove unimplemented PII claim + doc drift
a77e7d9f feat(CIBA Sprint 3): SEC-01/02 + SCALE-01 + ARK-109/110 + UX-03 (6 stories)
5f4dbf14 fix(CIBA Sprint 2 review): cross-tenant rule writes + silent treasury-alert upsert
d170c9a4 fix(CIBA Sprint 2 review): remove stale deleted_at refs + tighten 5xx error code
3994b2d5 feat(CIBA Sprint 2): worker endpoints + execution worker + rules engine UI (10 stories)
29349961 feat(CIBA Sprint 1): Rules Engine data model + Document Lineage supersede + Treasury alerting
```

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

_Last refreshed: 2026-04-23 (CIBA closeout: 17 stories transitioned Jira→Done + Confluence updated; PR #476 green + awaiting human merge review). 4 deferred with rationale unchanged._

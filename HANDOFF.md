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

**Branch:** `claude/2026-04-21-compliance-intelligence-epic` (PR #474 — CIBA v1.0)
**Network:** Bitcoin MAINNET. 1.41M+ SECURED anchors.
**Worker:** Cloud Run `arkova-worker-270018525501.us-central1.run.app` — 1GiB, max 3, KMS signing, batch 10K.
**Frontend:** `arkova-26.vercel.app`, auto-deploys from main.
**DB:** Supabase `vzwyaatejekddvltxyye`. 212 migrations on prod; 8 new CIBA migrations (0224–0231) staged on PR #474 for merge.
**Tests:** 5,202+ green (3,841 worker + 1,361 frontend as of 2026-04-21, end of CIBA Sprint 3).

---

## Open, current

### CIBA v1.0 release — [SCRUM-1010](https://arkova.atlassian.net/browse/SCRUM-1010) (Jira version 10233)

20 stories. PR [#474](https://github.com/carson-see/ArkovaCarson/pull/474) is open + green, awaiting review + merge.

- **16 stories In Progress** (code shipped): SCRUM-1011..1023, 1025, 1026, 1029. 4 commits on branch: `29349961` (Sprint 1 foundation), `3994b2d5` (Sprint 2 worker layer), `5f4dbf14` (security + bug fixes), `fb3b9738` (Sprint 3 + review fixes).
- **4 deferred** (To Do with explicit deferral comments):
  - [SCRUM-1024](https://arkova.atlassian.net/browse/SCRUM-1024) SCALE-02 — Cloud Run config is human-only (`feedback_worker_hands_off`).
  - [SCRUM-1027](https://arkova.atlassian.net/browse/SCRUM-1027) UX-01 — full onboarding wizard frontend; next sprint.
  - [SCRUM-1028](https://arkova.atlassian.net/browse/SCRUM-1028) UX-02 — queue dashboard frontend; next sprint.
  - [SCRUM-1030](https://arkova.atlassian.net/browse/SCRUM-1030) INT-13 — ATS/BGC connector; vendor + FCRA legal blocked.

**Open follow-ups on the release:**
- Regenerate `database.types.ts` after migrations 0224–0231 apply to prod (requires live Supabase).
- Policy decision resolved 2026-04-21: `handleTreasuryHealth` is now platform-admin-only (matches `handleTreasuryStatus`).

### Other elevated priorities

- [SCRUM-713](https://arkova.atlassian.net/browse/SCRUM-713) INTL — reopened 2026-04-21; 15 children (SCRUM-969..991).
- [SCRUM-550](https://arkova.atlassian.net/browse/SCRUM-550) DEP — reopened 2026-04-21; 4/23 + 9 new DEP-11..19.
- [SCRUM-551](https://arkova.atlassian.net/browse/SCRUM-551) REG — reopened 2026-04-21; 0/28 complete.
- [SCRUM-827](https://arkova.atlassian.net/browse/SCRUM-827) GME7, [SCRUM-828](https://arkova.atlassian.net/browse/SCRUM-828) GME8, [SCRUM-918](https://arkova.atlassian.net/browse/SCRUM-918) MCP-SEC — In Progress.
- [SCRUM-1000](https://arkova.atlassian.net/browse/SCRUM-1000) AUDIT-FU — story-level Confluence backfill sprint (~250 pages).
- NVI gate (epic [SCRUM-804](https://arkova.atlassian.net/browse/SCRUM-804)) = active. NDD/NSS/NTF paused.

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
| 2026-04-21 | `/api/treasury/health` is platform-admin-only (not org-admin) | Consistent with `/api/treasury/status`. USD aggregates are still treasury state — only Arkova operators see them. |
| 2026-04-21 | Jira + Confluence are the canonical sources of truth | Repeated drift between CLAUDE.md / BACKLOG.md / Jira made auditor + stakeholder view unreliable. |
| 2026-04-16 | Vertex endpoint hygiene mandate | Idle intermediate-checkpoint endpoints were silently billing. |
| 2026-04-16 | NVI gate active for Nessie | FCRA/HIPAA/FERPA training data not verified against authoritative primary sources. |
| 2026-04-15 | Nessie strategy reset | v5 "87.2% F1" headline was measured against a non-serverless model. |
| 2026-03-22 | Pipeline anchoring creates individual anchors per document | Each document must appear in Treasury — batch-only is insufficient. |
| 2026-03-22 | `VITE_CRON_SECRET` exposed to browser (admin-only pages) | Pipeline controls need auth; page gated to platform admins. |
| 2026-03-14 | IAIProvider as single abstraction for all AI providers | Vendor independence. |
| 2026-03-14 | MCP server uses Streamable HTTP transport | Native Cloudflare Workers compat. |

---

## Archive pointers

- Pre-2026-04-21 HANDOFF.md: git history.
- `docs/archive/session-log.md` — older session notes.
- `docs/BACKLOG.md` — banner only, points at Jira.

_Last refreshed: 2026-04-21 (post-CIBA Sprint 3). State: 16 stories awaiting merge, 4 deferred with rationale._

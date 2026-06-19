# BigQuery / Analytics Warehouse Design — Lane 3 (Credential Network & Intelligence)

**Sprint 0 · Tier T0 (design, not build) · feeds Sprint 1+ and Roadmap Q2.5 / SCRUM-1062 (GCP-MAX-02), epic SCRUM-1042.**
**Date:** 2026-06-19 · READ-ONLY session, no repo/infra mutation.
**Status discipline (§1.5):** split into **verified** (cited file:line / MCP) vs **unverified** (flagged). No prod state asserted.

> **Headline:** the warehouse is **NOT greenfield.** SCRUM-1062 already shipped a cron-wired 5-table mirror. This design **extends** it — it does not propose it from zero.

## 1. Current-state (verified)

| Capability | State | Evidence |
|---|---|---|
| BQ dataset | `arkova1.arkova_analytics`, location US | `services/worker/src/jobs/bq-export-schemas.ts:79-81` |
| BQ schemas | **5 tables**: `anchors`, `verifications`, `audit_events` (append); `organizations`, `api_keys` (snapshot) | `bq-export-schemas.ts:120-298` |
| BQ REST client | `fetch`-based (no `@google-cloud/bigquery` dep): `ensureTable`/`insertRows`/`runQuery`, 5xx retry | `bq-export-client.ts:82-315` |
| Incremental sync | 5-min watermark, append-only, at-least-once + `insertId` dedup, per-table isolation, Sentry | `bq-export-incremental.ts:41-185` |
| Snapshot sync | Daily 02:00 UTC, partition-replace | `bq-export-snapshot.ts:201-226` |
| Watermark ledger | `public.bq_export_watermarks`, service_role-only, FORCE RLS deny-all, CHECK-constrained to 5 names | migration `0297_bq_export_watermarks.sql` |
| Cron + scheduler | `/cron/bq-export-{incremental,snapshot,backfill}`; `*/5` + `0 2 * * *` | `routes/cron.ts:1665-1720`; `scripts/gcp-setup/cloud-scheduler.sh:35,41` |
| PII allowlists + guards | `AUDIT_EVENTS_/API_KEYS_COLUMN_ALLOWLIST` exclude PII; build-time test + runtime `assertNoApiKeysPiiLeak` | `bq-export-schemas.ts:311-367`; `bq-export-snapshot.ts:77-85` |

**Jira reality (verified via getJiraIssue SCRUM-1042):** SCRUM-1042 is flagged a **duplicate of SCRUM-1034** (`Done`); board reads `To Do` but comments say "In Progress, 2/6 children done." The live BQ track is child **SCRUM-1062 (GCP-MAX-02)** — the code above is its output. Scope named only `anchors`/`verifications`/`audit_events` → everything Lane 3 adds below is **net-new analytical scope**.

**What does NOT exist (verified by grep):** no credit-ledger / CE-CTDL / connector / HakiChain BQ table; AI telemetry flows to **Arize AX via OTLP**, metadata-only (`ai/observability.ts:32-58`), NOT warehoused (`ai_usage_events` + `ai_credits` Postgres tables exist, un-warehoused); **no HakiChain code anywhere** (reserved scope); CTDL is a library/API, no event table.

**Prod-deployment status: UNVERIFIED** (read-only; rigs/prod untouched). `scripts/ci/snapshots/prod-tables.json` shows `bq_export_watermarks` applied to prod (PR #700) — strong indirect signal it's live. **Sprint-1 task-0 must verify** via `bq ls arkova1:arkova_analytics` + watermark freshness before extending.

## 2. Proposed design (extension of the shipped subsystem)

**Principle:** every new table = a new `BqTableTarget` + allowlist + `bq_export_watermarks` CHECK entry + `APPEND/SNAPSHOT_TABLES` array entry. No new client, cron, or auth path → PII guards, watermark/at-least-once semantics, and Sentry alerting come for free.

**Dataset topology:** `arkova_analytics` (mirrors), **new** `arkova_analytics_marts` (deduped scheduled-query rollups Lane-2/exec read), **new** `arkova_analytics_ai` (AI telemetry, distinct retention/PII posture).

**New mirrored tables** (append, 5-min, `created_at`-watermark, `insertId=<table>-<id>`):

| BQ table | PG source | Mode | Partition/cluster | Allowlist |
|---|---|---|---|---|
| `credit_transactions` | `credit_transactions` | append | `created_at` / `org_id`,`transaction_type` | `id,org_id,transaction_type,amount,balance_after,reason,reference_id,created_at` — **recommend dropping `user_id`** (analytics is org-level) |
| `org_credit_deductions` | `org_credit_deductions` | append | `created_at` / `org_id`,`reason` | idempotency ledger; opaque `reference_id` |
| `connector_events` | `organization_rule_events` | append | `created_at` / `org_id`,`vendor`,`trigger_type` | **PII-CRITICAL** — MUST exclude `sender_email,subject,filename,folder_path,payload,error`; warehouse only `id,org_id,trigger_type,vendor,status,attempt_count,processed_at,created_at` + derived `has_error BOOL` |
| `org_daily_usage` | `org_daily_usage` | append-by-`updated_at` | `usage_date` / `org_id`,`quota_kind` | pre-aggregated, no PII; needs synthetic `insertId` |

**Credit-ledger reconciliation (the 3-table split is verified real; SCRUM-2539 ticket# UNVERIFIED):** `org_credits` (current state → snapshot mirror), `credit_transactions` (signed/typed event log → the canonical analytical ledger), `org_credit_deductions` (idempotency → integrity audit). Legacy per-user `credits` table **deliberately excluded** (fee model is org-level). Mart `mart_credit_ledger_daily` joins all three + surfaces drift (`SUM(credit_transactions.amount) per org` vs `org_credits.balance`) — serves launch-critical credit integrity.

**CE/CTDL events:** no event table today. **Recommendation (Sprint-1, Lane-3 backend, not designed here):** verify CE publish / CTID-mint / CTDL-validation outcomes write to `audit_events` with stable `event_type` (`ctdl.published`, `ctid.minted`, `ctdl.validation_failed`). If yes → they ride the existing `audit_events` mirror (no new table) and CE-trial-value queries become `audit_events WHERE event_type LIKE 'ctdl.%'` inside the 7-year SOC2 partition. If no → add emit-points (cheaper than a new table).

**Ingestion decision:** extend the existing watermark incremental+snapshot jobs (CHOSEN — reuses PII allowlists/Sentry/at-least-once); marts via BQ scheduled queries (CHOSEN); logical-replication/Datastream (rejected — team deliberately chose watermark-poll to avoid replication-slot risk on Supabase); streaming (rejected — analytics needs no sub-minute latency). Day-partition + `org_id`-cluster every table. Retention: `audit_events` + credit mirrors 2555d (SOC2/financial); `connector_events`/`org_daily_usage` 395d; marts 90–400d.

## 3. PII / privacy boundary (load-bearing invariant)

> The `arkova_analytics*` datasets carry **NO document content, NO PII, NO raw connector bytes** — only opaque IDs, enums, counts, ratios, hashes, timestamps. Documents never leave the device (§1.6); connector bytes are fetch→hash→discard (§1.6A). The warehouse is downstream of an already-PII-minimized Postgres → it can only be *more* restrictive.

Mechanically enforced: (1) **allowlist-select, never `SELECT *`** — a new PG column needs an explicit allowlist edit at PR review; (2) **build-time PII test** (`bq-export-schemas.test.ts` forbidden-column asserts) — **extend** with `CONNECTOR_EVENTS_FORBIDDEN_COLUMNS=['sender_email','subject','filename','folder_path','payload','error']`; (3) **runtime** `assertNoApiKeysPiiLeak` → add `assertNoConnectorPiiLeak`; (4) **fingerprint nuance (verified):** the `anchors` mirror carries `fingerprint` (`bq-export-schemas.ts:131`) — a SHA-256 *identifier* computed client-side, already public on the verify surface, §1.6-consistent, **call it out so it's not mistaken for a leak**; (5) **connector events** = highest-risk new surface (`organization_rule_events` carries `sender_email`/`subject`/`filename`/`folder_path`/`payload` jsonb — `baseline:8638`) → hard-excluded; (6) verifier IP hashed (`verifier_ip_hash`), `user_agent`/`referrer`/`country_code` stay out. **Net:** the warehouse answers "how many / how fast / which org / what ratio" and **cannot** answer "who / what document / what content."

## 4. Use-cases (each → a query shape)
- **CE trial-window value capture** — CTDL publish volume + success ratio per org over the trial window (`audit_events WHERE event_type LIKE 'ctdl.%'`; prereq §2 emit-point). Hard numbers for the renewal conversation.
- **HakiChain/Kenya metrics** — **RESERVED, not buildable** (no HakiChain code). When it lands → `audit_events WHERE event_type LIKE 'hakichain.%'` or a `hakichain_usage` append mirror.
- **Ops/cost** — anchors SECURED/day vs credits consumed → `credits_per_anchor` margin tracking (serves the $1.25-credit / ~$0.25-profit / nightly-batch fee model).
- **AI eval/drift** — Arize stays primary system of record; BQ `arkova_analytics_ai.ai_usage` from `ai_usage_events` is the long-term cross-quarter cost+drift aggregate (metadata-only: provider/model/tokens/cost/drift; never prompt/extracted text). Feeds §7 Vertex hygiene + GEMB2 drift watch.
- **Connector adoption** — Drive/DocuSign events by vendor/type/day, PII-free.

## 5. Boundary vs Lane 2 (no duplication)
| Concern | Owner | Reads | Latency |
|---|---|---|---|
| Real-time admin/visibility dashboard (S0-5.1 VIS-01) | **Lane 2** | Postgres + live telemetry | seconds |
| Analytical warehouse (trends, rollups, finance reconciliation, partner-trial value) | **Lane 3** | BigQuery `arkova_analytics*` | ≤5 min / daily |

Lane 2 answers "what is happening **now**" from Postgres (never reads BQ for operational state — BQ is ≤5-min stale + at-least-once). Lane 3 answers "what happened **over time**" from BQ (never the real-time dashboard, never a write-path/source-of-truth). Single integration point: a historical-trend tile → Lane 3 exposes a read-only mart/authorized-view that Lane 2 queries. Anything correct-to-the-second (treasury, live queue depth, current entitlement) = Postgres/Lane 2.

## 6. Sprint-1+ outline + cost
**Order:** (0, blocking) **verify prod state** of the existing subsystem (`bq ls` + watermark freshness) before extending; (1) `arkova_analytics_marts` + `mart_credit_ledger_daily` (pure BQ scheduled query, lowest-risk first win, serves launch-critical credit integrity); (2) credit-ledger mirrors (**T3** — touches `supabase/migrations/` for the watermark CHECK; confirm via `check-staging-evidence.ts` path detector); (3) connector-events mirror (highest PII scrutiny — forbidden-column test FIRST, red→green); (4) CE/CTDL emit-point verify (rides `audit_events`, likely no new table); (5) `ai_usage` mirror (coordinate with Arize owner; optional); (6) HakiChain — **blocked** on the integration existing. Each story: TDD, PII review, allowlist+test, watermark migration with `-- ROLLBACK:`, soak at detected tier, Confluence Data Model update, agents.md, HANDOFF; no prod writes from Lane 3.

**Cost (order-of-magnitude, UNVERIFIED — needs prod inventory + billing export):** storage single-digit $/mo at MVP scale; streaming inserts <$1/mo; **scan is the lever** — mitigated by day-partition + org_id-cluster (10–100× prune), the marts pattern (dashboards hit small pre-aggregated tables), and a recommended `maximum_bytes_billed` cap on the BI SA. Fold BQ into the §7 end-of-sprint infra-cost sweep (orphaned scheduled queries, unread marts, non-expiring partitions).

## 7. Open items (don't assert until confirmed)
1. **SCRUM-2539** ticket# for the credit-split — fact verified, ticket-number unverified.
2. **Prod-deployment status** of the existing BQ subsystem — Sprint-1 task-0.
3. Whether **CE/CTDL publish outcomes already write `audit_events`** rows.
4. **HakiChain has zero codebase footprint** — reserved scope only, not a concrete table.

### Evidence index
`services/worker/src/jobs/bq-export-{schemas,client,incremental,snapshot,watermark,backfill}.ts`; `supabase/migrations/0297_bq_export_watermarks.sql`; `routes/cron.ts:1665-1720`; `scripts/gcp-setup/cloud-scheduler.sh:35,41`; `docs/runbooks/gcp-max-setup.md`; `ai/observability.ts:32-58`; `supabase/migrations/0326_*.sql:7-16` + baseline `:7855`(`credit_transactions`)/`:8473`(`org_credits`)/`:8480`(`credits`)/`:3235`(`ai_usage_events`)/`:8638`(`organization_rule_events`); `ctdl/{ctdl-serializer,ctdl-validation,ctdl-type-map}.ts`.

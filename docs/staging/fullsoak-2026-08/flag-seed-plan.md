# Flag seed plan — 7-day full-functionality soak (BL-3)

Rig: Cloud Run `arkova-worker-fullsoak-2026-08-staging` (project `arkova1`, us-central1) ·
Supabase `gnkuaywlpmsaezwvlvhk` · Decision source: `flag-decision-matrix.csv` (same folder).
State read 2026-08-12 from revision template `00011-bif` (serving `00010-tmj` — identical env
except `BUILD_SHA`, present only on 00011) and live `switchboard_flags` (24 rows).

**Execution order is load-bearing. Do the steps in this order:**

```
1. Seed switchboard_flags (SQL below)          <- registry-path flags MUST land before step 2
2. ONE final Cloud Run deploy (env block below) <- restarts worker; registry re-snapshots rows
3. Verify the boot-log flag snapshot            <- "Feature flag registry initialized" line
4. Run behavioural probes (row-count deltas)
5. THEN record soak clock start (§6.3 of the premortem; BL-4 gate flip is separate)
```

Why: `flagRegistry` reads `switchboard_flags` **once** at `init()` with no TTL
(`services/worker/src/middleware/flagRegistry.ts:92-147`). A row seeded after the final deploy
never reaches the running worker. `ENABLE_EXPIRY_ALERTS` is the flag this bites on this rig;
`ENABLE_BATCH_ANCHORING` is already true so it survives any restart, but any mid-soak flip of a
registry-path flag requires another restart — which resets the soak clock. Flip nothing mid-soak.

---

## (a) Env vars on the FINAL rig revision (one deploy only)

Single command (main session; values-only — all secret bindings carry over unchanged):

```bash
export CLOUDSDK_PYTHON=/opt/homebrew/opt/python@3.14/bin/python3.14
gcloud run services update arkova-worker-fullsoak-2026-08-staging \
  --region=us-central1 --project=arkova1 \
  --update-env-vars=^;^ENABLE_AI_FRAUD=true;FORCE_DYNAMIC_FEE_ESTIMATION=true;ENABLE_RULES_ENGINE=true;ENABLE_RULE_ACTION_DISPATCHER=true;ENABLE_QUEUE_REMINDERS=true;ENABLE_WEBHOOK_HMAC=true;ENABLE_ALLOCATION_ROLLOVER=false;ENABLE_CE_KEY_EXPIRY_ALERTS=false
```

| Var | Value | Why |
|---|---|---|
| `ENABLE_AI_FRAUD` | `false → true` | Mirror hygiene: DB row becomes true (SQL below); env is only the registry fallback but a contradicting pair is the 0363 trap in reverse |
| `FORCE_DYNAMIC_FEE_ESTIMATION` | `true` (new) | BL-2/DEG-2 fix: real fee estimator + ceiling + fallback under test (`chain/client.ts:250`) |
| `ENABLE_RULES_ENGINE` | `true` (new) | Already default-ON (skip only on literal `'false'`, `jobs/rules-engine.ts:344`); explicit for a self-documenting revision |
| `ENABLE_RULE_ACTION_DISPATCHER` | `true` (new) | Same default-ON pattern (`jobs/rule-action-dispatcher.ts:1030`) |
| `ENABLE_QUEUE_REMINDERS` | `true` (new) | Same default-ON pattern (`jobs/queue-reminders.ts:148`) |
| `ENABLE_WEBHOOK_HMAC` | `true` (new) | Default-ON per request (`middleware/webhookHmac.ts:66`); explicit |
| `ENABLE_ALLOCATION_ROLLOVER` | `false` (new) | Job reads raw env `!== 'false'` → unset means a stray forced run would EXECUTE a ledger-mutating rollover (`jobs/monthly-allocation-rollover.ts:33`); pin off |
| `ENABLE_CE_KEY_EXPIRY_ALERTS` | `false` (new) | boolEnvInverse default TRUE; `CE_API_KEY_EXPIRES_AT` unbound → fail-LOUD sentinel noise; prod-ops control, not a rig one |

**Keep unchanged** (already correct on the template): `USE_MOCKS=false`,
`ENABLE_PROD_NETWORK_ANCHORING=true`, `ENABLE_VERIFICATION_API=true`, `ENABLE_AI_EXTRACTION=true`,
`ENABLE_AI_REPORTS=true`, `ENABLE_DRIVE_WEBHOOK=true`, `ENABLE_DRIVE_CHANGES_RUNNER=true`,
`ENABLE_CONNECTOR_ARTIFACT_ENQUEUE=true`, `ENABLE_CONNECTOR_ARTIFACT_DRAIN=true`,
`ENABLE_DOCUSIGN_WEBHOOK=true`, `ENABLE_ORG_CREDIT_ENFORCEMENT=true`, `KMS_PROVIDER=gcp`,
`BITCOIN_NETWORK=signet`, `BITCOIN_UTXO_PROVIDER=mempool`, `BITCOIN_FEE_STRATEGY=mempool`, plus all
secret bindings.

**MUST NOT be set — boot-crash traps** (Zod `superRefine` fails the deploy, NODE_ENV=production):

| Var | Trap |
|---|---|
| `ENABLE_TREASURY_ALERTS=true` | Literal `'true'` + prod anchoring requires `SLACK_TREASURY_WEBHOOK_URL` or `TREASURY_ALERT_EMAIL` (`config.ts:761-770`) — neither bound. Leave **unset**: the job is default-ON anyway (`jobs/treasury-alert.ts:191`). Decision is ON; the env var stays absent. |
| `ENABLE_DRIVE_OAUTH=true` | Requires `GOOGLE_OAUTH_CLIENT_ID/SECRET` + `INTEGRATION_STATE_HMAC_SECRET` + `GCP_KMS_INTEGRATION_TOKEN_KEY` (`config.ts:625,645,686`) |
| `ENABLE_DOCUSIGN_OAUTH=true` | Requires `DOCUSIGN_INTEGRATION_KEY/CLIENT_SECRET` + same two secrets (`config.ts:645,675,686`) |
| `ENABLE_GRC_INTEGRATIONS=true` | Requires `GCP_KMS_INTEGRATION_TOKEN_KEY` (`config.ts:686`) |
| `ENABLE_VEREMARK_WEBHOOK=true` | Requires `VEREMARK_WEBHOOK_SECRET` (`config.ts:715`) |
| `ENABLE_DEMO_INJECTOR` / `ENABLE_SYNTHETIC_DATA` = `true` | Rejected outright in production (`config.ts:775-783`) — and ruled OFF anyway |
| `MEMPOOL_API_URL` (any value) | Known contract bug: inconsistent `/api` handling froze a prior soak's confirmation path — never set on rigs |

## (b) Idempotent switchboard_flags seed SQL (run BEFORE the final deploy)

Run via Supabase MCP `execute_sql` against `gnkuaywlpmsaezwvlvhk`. Idempotent; the
`switchboard_flag_change_trigger` fires only on enabled-value changes, so re-runs write no
spurious `switchboard_flag_history` rows (and the first run's history rows are free audit
evidence of the seed — capture them).

```sql
BEGIN;

-- 60s-TTL DB-read flags (live within a minute, no restart needed)
INSERT INTO public.switchboard_flags (flag_key, enabled, description) VALUES
  ('ENABLE_SEMANTIC_SEARCH',  true, 'fullsoak-2026-08: ON — embed producer /api/v1/ai/embed reachable (BL-3)'),
  ('ENABLE_AI_FRAUD',         true, 'fullsoak-2026-08: ON — text AI-fraud endpoints under soak (BL-3)'),
  ('ENABLE_FRAUD_DETECTION',  true, 'fullsoak-2026-08: ON — frontend-only consumer; no worker probe exists (BL-3)'),
  ('ENABLE_PARTNER_PROVISIONING', true, 'fullsoak-2026-08: ON — gate fail-closed without row; seeded for soak (BL-3)'),
-- registry-path flag: MUST land before the final deploy (boot snapshot, no TTL)
  ('ENABLE_EXPIRY_ALERTS',    true, 'fullsoak-2026-08: ON — registry boot-snapshot path; seeded pre-deploy (BL-3)'),
-- audit mirror only (worker reads the env var, migration 0363:62) — aligned to env for honesty
  ('ENABLE_ORG_CREDIT_ENFORCEMENT', true, 'fullsoak-2026-08: mirror aligned to rig env ENABLE_ORG_CREDIT_ENFORCEMENT=true; row is AUDIT MIRROR ONLY per 0363')
ON CONFLICT (flag_key) DO UPDATE
  SET enabled = EXCLUDED.enabled, updated_at = now();

COMMIT;

-- verify (expect 6 rows, all enabled=true)
SELECT flag_key, enabled, updated_at FROM public.switchboard_flags
WHERE flag_key IN ('ENABLE_SEMANTIC_SEARCH','ENABLE_AI_FRAUD','ENABLE_FRAUD_DETECTION',
                   'ENABLE_PARTNER_PROVISIONING','ENABLE_EXPIRY_ALERTS','ENABLE_ORG_CREDIT_ENFORCEMENT')
ORDER BY flag_key;
```

Deliberately **not** seeded: `ENABLE_COMPLIANCE_ENGINE` (dead — zero consumers repo-wide),
`ENABLE_ADES_SIGNATURES` (OFF — aws_kms default with no AWS account; see matrix),
`MAINTENANCE_MODE` (stays false), `ENABLE_ZK_PROOFS` (dead; existing true row gates nothing —
do not cite it as coverage). All other existing rows keep their current values.

## (c) Probes — named row-count deltas, never an HTTP 200

Auth for forced cron runs (either works; CRON_SECRET is simplest):

```bash
RIG=https://arkova-worker-fullsoak-2026-08-staging-270018525501.us-central1.run.app
CRON_SECRET=$(gcloud secrets versions access latest --secret=cron-secret --project=arkova1)
# forced run pattern:
curl -sS -X POST "$RIG/jobs/<route>" -H "X-Cron-Secret: $CRON_SECRET"
```

Record `count_before`, force the run, record `count_after`, assert the delta. A 200 body, a
`skipped:false`, or `get_flag`→true are all non-evidence (no table read distinguishes the four
resolution paths). Several probes need fixtures from the fixture-seeding backlog item (marked ⚠).

| Flag | Forced trigger | Delta assertion (SQL against `gnkuaywlpmsaezwvlvhk`) |
|---|---|---|
| ENABLE_SEMANTIC_SEARCH | ⚠ JWT user: `POST /api/v1/ai/embed/batch` (≤100 anchorIds), then `POST /api/v1/ai/search` | `SELECT count(*) FROM credential_embeddings;` baseline 0 → >0; then `ai_usage_events` +1 per search |
| ENABLE_AI_FRAUD | ⚠ JWT: `POST /api/v1/ai/integrity` on fixture anchor | `SELECT count(*) FROM integrity_scores;` +1 |
| ENABLE_FRAUD_DETECTION | none possible | **no worker consumer** — UI-only; do not claim a server probe |
| ENABLE_EXPIRY_ALERTS | ⚠ `POST /jobs/check-credential-expiry` (needs SECURED anchor `not_after` ≤7d + `webhook_endpoints` row) | `SELECT count(*) FROM webhook_delivery_logs;` +N for `compliance.document_expiring` |
| ENABLE_ORG_CREDIT_ENFORCEMENT | connector drain or anchor enqueue on a credit-initialized org | `SELECT count(*) FROM org_credit_deductions;` +1 per debit |
| ENABLE_RULES_ENGINE | ⚠ seed `organization_rules` + PENDING `organization_rule_events`; `POST /jobs/rules-engine` | `organization_rule_events` PENDING→PROCESSED delta + `organization_rule_executions` +N |
| ENABLE_RULE_ACTION_DISPATCHER | `POST /jobs/rule-action-dispatcher` after the above | `organization_rule_executions` dispatched/completed status delta |
| ENABLE_QUEUE_REMINDERS | ⚠ `POST /jobs/queue-reminders` (no rig scheduler binding — forced runs only) | `organization_rule_executions` reminder rows +N |
| ENABLE_DOCUSIGN_WEBHOOK | signed synthetic Connect POST `/api/v1/webhooks/docusign` (HMAC = `docusign_connect_hmac_secret`) | `docusign_webhook_nonces` +1 |
| ENABLE_CONNECTOR_ARTIFACT_ENQUEUE | `POST /jobs/docusign-envelope-completed` after the above | `connector_artifact` +1 (baseline 0) |
| ENABLE_CONNECTOR_ARTIFACT_DRAIN | `POST /jobs/drain-connector-artifacts` | `connector_artifact` pending→anchored delta + `anchors` +1 + `org_credit_deductions` +1 |
| ENABLE_WEBHOOK_HMAC | pair: unsigned forged POST, then signed POST to `/api/v1/webhooks/docusign` | forged leg: `docusign_webhook_nonces` delta **= 0** (this zero IS the assertion); signed leg: +1 |
| ENABLE_DRIVE_WEBHOOK / DRIVE_CHANGES_RUNNER | ⚠ synthetic push against seeded `drive_watch_state` channel | `drive_webhook_nonces` +1; `job_queue` `google_drive.file_changed` claim-transition delta (vendor fetch fails w/o tokens — count the claim, not completion) |
| ENABLE_TREASURY_ALERTS | ⚠ `POST /jobs/treasury-alert-check` with below-threshold `treasury_cache` fixture | `treasury_alert_state` row/updated_at delta (delivery legs unbound — decision path only) |
| ENABLE_PARTNER_PROVISIONING | `POST /api/partner-provisioning` request→approve→provision | `audit_events` +N (provisioning transition events) |
| ENABLE_VERIFICATION_API | `GET /api/v1/verify/<fingerprint>` | `verification_events` +1 |
| ENABLE_AI_EXTRACTION | ⚠ JWT: `POST /api/v1/ai/extract` | `ai_usage_events` +1 |
| ENABLE_AI_REPORTS | ⚠ JWT: `POST /api/v1/ai/reports` | `ai_reports` +1 |
| ENABLE_BATCH_ANCHORING | scheduler `batch-anchors` (5-min) or `?force=true` flush | `anchors` SECURING→SUBMITTED delta + `anchor_txid_journal` +N |
| ENABLE_ATTESTATION_ANCHORING | ⚠ `POST /jobs/anchor-attestations` with `attestations` fixture | `attestations` anchored-status delta |
| ENABLE_OUTBOUND_WEBHOOKS | any dispatched event with `webhook_endpoints` fixture | `webhook_delivery_logs` +1 |
| ENABLE_PUBLIC_RECORD_* | `POST /jobs/fetch-federal-register` → `/jobs/anchor-public-records` → `/jobs/embed-public-records` | `public_records` +N → anchored delta → `public_record_embeddings` +N |
| ENABLE_CONFIRMATION_PROOF_BACKFILL (scheduler-driven; env flag is a no-op here) | scheduler `populate-confirmation-proofs` (5-min) | `anchor_proofs` rows with `block_header IS NOT NULL` +N |
| FORCE_DYNAMIC_FEE_ESTIMATION | boot log of final revision | log line `fee=Dynamic` (was `fee=Static`) + fee-rate variance across `anchor_txid_journal` over the week |
| USE_MOCKS (inverse/mock detector) | continuous | `SELECT count(*) FROM anchors WHERE chain_block_height > 400000;` must stay **0** (signet tip ~317k; MockChainClient seeds 800000) |

## (d) Restart-ordering note

- **Registry-path flags** (`flagRegistry` DB_FLAGS: here only `ENABLE_EXPIRY_ALERTS` changes;
  `ENABLE_BATCH_ANCHORING` already true): the row read happens **once at worker boot, no TTL**.
  Seed (b) strictly BEFORE the deploy in (a). Verify via the final revision's
  `Feature flag registry initialized` boot log line: `ENABLE_EXPIRY_ALERTS {value:true, source:'db'}`.
- **60s-TTL DB flags** (semantic search / AI fraud / partner provisioning / verification API):
  live ≤60s after seeding, restart not required — but they are seeded pre-deploy anyway so the
  boot snapshot and every path agree from minute zero.
- **Env-path flags**: exist only on the revision; the (a) deploy is the one and only restart.
  After it, **do not deploy again** — the soak clock is Cloud Run worker uptime
  (`memory/feedback_soak_clock_is_worker_uptime.md`); any later env edit resets the period.
- Traffic must be 100% on the final revision. Today traffic sits on `00010-tmj` while
  `00011-bif` holds only the `pr-2195` tag — the (a) deploy must also route 100% traffic to the
  new revision (default behavior of `gcloud run services update`; confirm in the describe output).
- Order relative to BL-4: seed → deploy → boot-log check → probes → `SOAK_GATE_DISABLED` flip →
  recorded clock start (per premortem §6.3).

---

_Prepared 2026-08-12 (BL-3). Read-only evidence: `gcloud run services/revisions describe` on the
rig, live `switchboard_flags` SELECT, rig Cloud Scheduler job census (24 jobs), and call-site
greps at the cited `file:line`s. No infra was modified._

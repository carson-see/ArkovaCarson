# Cron route exerciser — 2026-08-12

> Run `2026-08-12T16:50:24Z` · rig `arkova-worker-fullsoak-2026-08-staging` · Supabase `gnkuaywlpmsaezwvlvhk`
> Route source: **rig frozen SHA f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58** · rig `git_sha` `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58` · uptime `6036s`
> Host `Arkovas-Mac-mini.local` · repo HEAD `49358d607b47217cfe81caf44d17b5e4a595cc88` · mode `run`
> Mgmt SQL reads: available

**What this measures.** Every cron route declared in `cron.ts` that Cloud Scheduler does *not*
bind on this rig, invoked once over the same authenticated HTTP path Scheduler uses, with its
status, latency, response body and (where a table is obvious from the handler) its row delta.

**What this does NOT assert.** That a 2xx means the job did useful work — most of these have
nothing to act on. It asserts reachability, auth, and the absence of a crash. A non-2xx is a
FINDING; a 2xx is evidence the route is not FD-2-class broken.

## Census

| | count |
|---|---|
| Routes declared in `cron.ts` | **110** |
| Scheduler-bound on this rig | **25** |
| Unbound (this script's scope) | **85** |
| Exercised OK | **30** |
| Findings | **4** |
| Denied (never invoked) | **51** |

## Cohort integrity

`anchors` 12 → 12 · `anchor_proofs` 12 → 12 — **intact**.
The exerciser is not permitted to move the BL-2 cohort; this row is the proof it did not.

## Results

| route | verdict | verb | http | ms | delta · body |
|---|---|---|---|---|---|
| `/ai-credit-reconcile` | OK | POST | 200 | 189 ms | `job_queue` 5 → 5 (0) · {"claimed":0,"reconciled":0,"failed":0} |
| `/anchor-attestations` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/anchor-expiry-sweep` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/anchor-public-records` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/batch-anchors` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/bq-export-backfill` | DENIED | — | — | — | D7 — unbounded full-table export; needs an explicit ?table= param |
| `/bq-export-incremental` | OK | POST | 200 | 2268 ms | — · {"results":[{"table":"anchors","rowsScanned":12,"rowsInserted":12,"newWatermark":"2026-08-12T14:11:51.215839+00:00","errors":0},{"table":"verifications","rowsScanned":0,"rowsInserted":0,"newWatermark":null,"errors":0},{"… |
| `/bq-export-snapshot` | OK | POST | 200 | 6967 ms | — · {"results":[{"table":"organizations","snapshotDate":"2026-08-12","rowsInserted":2,"errors":0},{"table":"api_keys","snapshotDate":"2026-08-12","rowsInserted":11,"errors":0}]} |
| `/calibration-refit` | FINDING | POST | 500 | 249 ms | — · {"error":"Processing failed"} |
| `/ce-key-expiry-check` | OK | POST | 200 | 145 ms | — · {"ok":true,"fired":false,"window":"OK","days_until_expiry":null} |
| `/ce-registry-drift-check` | OK | POST | 200 | 129 ms | — · {"checked":0,"match":0,"drifted":0,"withdrawn":0,"unreachable":0,"truncated":false,"loadFailed":false,"reportFailures":0,"skipped":true} |
| `/check-attestation-expiry` | OK | POST | 200 | 347 ms | `attestations` 1 → 1 (0) · {"checked":0,"expiring_30d":0,"expiring_7d":0,"newly_expired":0,"webhooks_queued":0} |
| `/check-confirmations` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/check-credential-expiry` | FINDING | POST | 500 | 242 ms | — · {"error":"Query failed"} |
| `/check-stuck-anchors` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/classify-proof-backcatalog` | DENIED | — | — | — | D6 — persists a durable job_queue checkpoint and advances the census cursor even in dry-run |
| `/cleanup-retention` | DENIED | — | — | — | D2 — calls cleanup_expired_data() — GDPR retention purge, deletes rows the soak measures |
| `/connector-health-check` | OK | POST | 200 | 375 ms | — · {"ok":true,"checked":2,"alertsFired":0} |
| `/consolidate-utxos` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/credit-expiry` | OK | POST | 200 | 271 ms | `credit_transactions` 0 → 0 (0) · {"processed":0} |
| `/db-health` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/detect-reorgs` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/docusign-connect-failures-poll` | OK | POST | 200 | 246 ms | — · {"ok":true,"integrations_checked":0,"failures_polled":0,"gaps_inserted":0,"duplicates_skipped":0,"errors":[],"token_refreshes":0} |
| `/docusign-envelope-completed` | OK | POST | 200 | 546 ms | `job_queue` 5 → 5 (0) · {"claimed":1,"completed":0,"failed":1,"dead":0,"updateFailed":0,"jobIds":["a0c334ed-b98a-48c5-9af8-4a2e5f973113"]} |
| `/docusign-listener-drift` | OK | POST | 200 | 307 ms | — · {"ok":true,"integrations_checked":0,"drift_detected":0,"in_sync":0,"errors":[],"drifts":[]} |
| `/docusign-notarization-completed` | OK | POST | 200 | 271 ms | `job_queue` 5 → 5 (0) · {"claimed":0,"completed":0,"failed":0,"dead":0,"updateFailed":0,"jobIds":[]} |
| `/docusign-queue-reconciliation` | OK | POST | 200 | 133 ms | — · {"skipped":true,"reason":"ENABLE_DOCUSIGN_QUEUE_RECONCILIATION disabled"} |
| `/docusign-reconciliation` | OK | POST | 200 | 219 ms | — · {"ok":true,"integrations_checked":0,"envelopes_polled":0,"gaps_detected":0,"gaps_inserted":0,"duplicates_skipped":0,"errors":[],"token_refreshes":0} |
| `/drain-connector-artifacts` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/drive-file-changed` | OK | POST | 200 | 191 ms | `job_queue` 5 → 5 (0) · {"claimed":0,"completed":0,"failed":0,"dead":0,"updateFailed":0,"jobIds":[]} |
| `/drive-subscription-renewal` | DENIED | — | — | — | D8 — mutates the seeded google_drive org_integrations row P9b's daily probe addresses |
| `/edgar-backfill` | DENIED | — | — | — | D1 — historical backfill of the same ingestion family; unbounded |
| `/edgar-bulk` | DENIED | — | — | — | D1 — bulk ingestion of the same family; unbounded |
| `/embed-public-records` | DENIED | — | — | — | D1 — embeds the ingested corpus; spends AI credits on rows the cohort must not gain |
| `/fetch-acnc` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-acra-sg` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-all-state-bills` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-australia` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-brazil-compliance` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-calbar` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-certifications` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-cle` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-cms-physicians` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-cnpj-br` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-continuing-education` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-courtlistener` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-dapip` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-ecfr` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-edgar` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-edgar-form-adv` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-enforcement` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-fcc` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-federal-register` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-finra` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-insurance-licenses` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-ipeds` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-kenya` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-licensing-board` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-medical-boards` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-mexico-compliance` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-moh-sg` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-npi` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-openalex` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-sam-entities` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-sam-exclusions` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-sec-iapd` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-singapore-compliance` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-sos` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-state-bills` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-state-courts` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/fetch-uspto` | DENIED | — | — | — | D1 — external registry ingestion -> public_records -> bound anchor-public-records -> anchors |
| `/financial-report` | OK | POST | 200 | 469 ms | — · {"month":"2026-07","stripeRevenueUsd":0,"x402RevenueUsd":0,"totalRevenueUsd":0,"bitcoinFeeSats":0,"bitcoinFeeUsd":0,"totalAnchors":0,"avgCostPerAnchorUsd":0,"grossMarginUsd":0,"grossMarginPct":0} |
| `/generate-reports` | OK | POST | 200 | 192 ms | `report_artifacts` 0 → 0 (0) · {"processed":0,"failed":0} |
| `/grace-expiry-sweep` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/lock-wait` | OK | POST | 200 | 254 ms | — · {"ok":true,"degraded":false,"waitCount":0,"waits":[]} |
| `/mainnet-migration` | DENIED | — | — | — | D3 — mainnet migration must never run on a signet rig |
| `/materialize-proof-backcatalog` | DENIED | — | — | — | D5 — INSERTs anchor_proofs when armed; inertness rides on an env var |
| `/migration-status` | OK | GET | 200 | 393 ms | — · {"total":0,"pending":0,"secured":0,"submitted":0,"migrated":0,"migratedCapped":false,"remaining":0} |
| `/monitor-fees` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/monitor-stuck-txs` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/monthly-allocation-rollover` | OK | POST | 200 | 135 ms | `org_monthly_allocation` 0 → 0 (0) · {"total_orgs":0,"rolled":0,"skipped":0,"errors":0} |
| `/nonce-sweep` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/openalex-bulk` | DENIED | — | — | — | D1 — bulk ingestion of the same family; unbounded |
| `/org-queue-scheduler` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/payment-recovery` | OK | POST | 200 | 256 ms | `payment_grace_periods` 0 → 0 (0) · {"processed":0,"downgraded":0,"anchorsDisabled":0} |
| `/pipeline-health` | OK | POST | 200 | 316 ms | — · {"healthy":true,"stuckGroups":[],"totalStuck":0,"checkedAt":"2026-08-12T16:53:24.494Z","alertSent":false} |
| `/pipeline-throughput-monitor` | OK | POST | 200 | 303 ms | — · {"healthy":true,"alertFired":false,"windowHours":24,"linkerStallThresholdHours":48,"latestUnlinkedAgeHours":null,"oldestUnlinkedAgeHours":null,"lastSecuredAgeHours":2,"unlinkedTotal":0,"batchProgress":{"total":0,"PENDING… |
| `/populate-confirmation-proofs` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/process-anchors` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/process-revocations` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/professional-education-extraction` | FINDING | POST | 503 | 135 ms | `job_queue` 5 → 5 (0) · {"error":"professional_education_schema_unavailable","message":"Professional education schema is not ready in this environment; PR #841 CPE/CLE runtime paths are disabled until schema and migration-ledger reconciliation … |
| `/proof-coverage-monitor` | OK | POST | 200 | 220 ms | — · {"healthy":true,"decision":{"shouldFire":false,"severity":"warning","reason":"insufficient_sample","coverageRatio":1,"missingCount":0,"windowHours":24,"securedInWindow":11,"proofsInWindow":11}} |
| `/queue-digest` | OK | POST | 200 | 139 ms | `audit_events` 145 → 145 (0) · {"admins":0,"sent":0,"suppressed":0,"skippedEmpty":0,"alreadySent":0,"failed":0} |
| `/queue-reminders` | DENIED | — | — | — | G4 guard failed — enabled scheduled/digest rules = 1 |
| `/rebroadcast-txs` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/reconcile-credit-conservation` | OK | POST | 200 | 256 ms | — · {"healthy":true,"alertFired":false,"divergedCount":0,"orgsChecked":2,"error":null,"checkedAt":"2026-08-12T16:53:59.579Z"} |
| `/reconcile-stripe` | OK | POST | 200 | 817 ms | `reconciliation_reports` **0 → 1** · {"month":"2026-07","totalSubscriptions":2,"discrepancies":[]} |
| `/recover-broadcasts` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/refresh-stats` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/refresh-treasury-cache` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/regulatory-change-scan` | DENIED | — | — | — | D1 — live external registry scan + AI spend |
| `/report-metered-usage` | DENIED | — | — | — | G2 guard failed — active/trialing subscriptions = 2 |
| `/rule-action-dispatcher` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/rules-engine` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/smoke-test` | FINDING | POST | 503 | 555 ms | `audit_events` **145 → 146** · {"status":"fail","passed":5,"failed":1,"total":6,"gitSha":"f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58","timestamp":"2026-08-12T16:54:16.310Z","results":[{"name":"database","status":"pass","durationMs":99,"detail":"Query OK… |
| `/smoke-test/history` | OK | GET | 200 | 213 ms | — · {"history":[{"timestamp":"2026-08-12T16:54:16.262Z","passed":5,"failed":1,"total":6,"results":[{"name":"database","status":"pass","durationMs":99,"detail":"Query OK"},{"name":"anchor-count","status":"fail","durationMs":9… |
| `/supplementary-proof-anchor` | DENIED | — | — | — | D4 — only job in the repo that spends real mainnet BTC across the 2.97M backlog |
| `/treasury-alert-check` | OK | POST | 200 | 247 ms | — · {"fired":false,"reason":"Balance above threshold","below_threshold":false,"price_unknown":false} |
| `/webhook-retries` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/workspace-subscription-renewal` | OK | POST | 200 | 198 ms | — · {"checked":0,"renewed":0,"failed":0} |

## Findings

#### `/calibration-refit` — HTTP 500 (249 ms)

```
{"error":"Processing failed"}
```

#### `/check-credential-expiry` — HTTP 500 (242 ms)

```
{"error":"Query failed"}
```

#### `/professional-education-extraction` — HTTP 503 (135 ms)

```
{"error":"professional_education_schema_unavailable","message":"Professional education schema is not ready in this environment; PR #841 CPE/CLE runtime paths are disabled until schema and migration-ledger reconciliation …
```

#### `/smoke-test` — HTTP 503 (555 ms)

```
{"status":"fail","passed":5,"failed":1,"total":6,"gitSha":"f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58","timestamp":"2026-08-12T16:54:16.310Z","results":[{"name":"database","status":"pass","durationMs":99,"detail":"Query OK…
```

## Denied — never invoked, with the reason

- `/bq-export-backfill` — **D7**: unbounded full-table export; needs an explicit ?table= param
- `/classify-proof-backcatalog` — **D6**: persists a durable job_queue checkpoint and advances the census cursor even in dry-run
- `/cleanup-retention` — **D2**: calls cleanup_expired_data() — GDPR retention purge, deletes rows the soak measures
- `/drive-subscription-renewal` — **D8**: mutates the seeded google_drive org_integrations row P9b's daily probe addresses
- `/edgar-backfill` — **D1**: historical backfill of the same ingestion family; unbounded
- `/edgar-bulk` — **D1**: bulk ingestion of the same family; unbounded
- `/embed-public-records` — **D1**: embeds the ingested corpus; spends AI credits on rows the cohort must not gain
- `/fetch-acnc` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-acra-sg` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-all-state-bills` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-australia` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-brazil-compliance` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-calbar` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-certifications` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-cle` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-cms-physicians` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-cnpj-br` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-continuing-education` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-courtlistener` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-dapip` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-ecfr` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-edgar` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-edgar-form-adv` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-enforcement` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-fcc` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-federal-register` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-finra` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-insurance-licenses` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-ipeds` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-kenya` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-licensing-board` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-medical-boards` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-mexico-compliance` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-moh-sg` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-npi` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-openalex` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-sam-entities` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-sam-exclusions` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-sec-iapd` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-singapore-compliance` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-sos` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-state-bills` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-state-courts` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/fetch-uspto` — **D1**: external registry ingestion -> public_records -> bound anchor-public-records -> anchors
- `/mainnet-migration` — **D3**: mainnet migration must never run on a signet rig
- `/materialize-proof-backcatalog` — **D5**: INSERTs anchor_proofs when armed; inertness rides on an env var
- `/openalex-bulk` — **D1**: bulk ingestion of the same family; unbounded
- `/queue-reminders` — **G4 guard failed**: enabled scheduled/digest rules = 1. Policy: enabled SCHEDULED_CRON/QUEUE_DIGEST organization_rules must be 0.
- `/regulatory-change-scan` — **D1**: live external registry scan + AI spend
- `/report-metered-usage` — **G2 guard failed**: active/trialing subscriptions = 2. Policy: active/trialing subscriptions must be 0.
- `/supplementary-proof-anchor` — **D4**: only job in the repo that spends real mainnet BTC across the 2.97M backlog


---

`CRON_EXERCISER: 30 ok / 4 findings / 51 denied`

_Produced by `scripts/staging/fullsoak-cron-exerciser.sh`. No rig env, flag, secret, scheduler job,
revision or traffic split was modified; the soak clock was not touched._

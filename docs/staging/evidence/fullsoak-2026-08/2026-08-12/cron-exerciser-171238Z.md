# Cron route exerciser — 2026-08-12

> Run `2026-08-12T17:12:38Z` · rig `arkova-worker-fullsoak-2026-08-staging` · Supabase `gnkuaywlpmsaezwvlvhk`
> Route source: **rig frozen SHA f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58** · rig `git_sha` `f5d1070fcca2027fd7ab56a596d8e1ae27ae4a58` · uptime `7370s`
> Host `Arkovas-Mac-mini.local` · repo HEAD `36faca5b88f4e8b29c43bb4d4267689e0bd52330` · mode `plan`
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
| Exercised OK | **0** (of which **0** are a documented gate answering non-2xx by design) |
| Findings | **0** |
| Denied (never invoked) | **51** |

## Cohort integrity

`anchors` 12 → 12 · `anchor_proofs` 12 → 12 — **intact**.
The exerciser is not permitted to move the BL-2 cohort; this row is the proof it did not.

## Results

| route | verdict | verb | http | ms | delta · body |
|---|---|---|---|---|---|
| `/ai-credit-reconcile` | PLAN-ALLOW | POST | — | — | drains ai-credit reconcile job_queue rows; no DML of its own |
| `/anchor-attestations` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/anchor-expiry-sweep` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/anchor-public-records` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/batch-anchors` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/bq-export-backfill` | DENIED | — | — | — | D7 — unbounded full-table export; needs an explicit ?table= param |
| `/bq-export-incremental` | PLAN-ALLOW | POST | — | — | no BigQuery dataset wired to the rig; exercises the missing-config path |
| `/bq-export-snapshot` | PLAN-ALLOW | POST | — | — | no BigQuery dataset wired to the rig; exercises the missing-config path |
| `/calibration-refit` | PLAN-ALLOW | POST | — | — | reads calibration_features and RETURNS a proposal; writes nothing |
| `/ce-key-expiry-check` | PLAN-ALLOW | POST | — | — | read + alert only; no CE credentials on the rig |
| `/ce-registry-drift-check` | PLAN-ALLOW | POST | — | — | read + alert; no CE credentials on the rig |
| `/check-attestation-expiry` | PLAN-ALLOW | POST | — | — | expires attestations past their own expiry — the same lifecycle the bound anchor-expiry-sweep runs |
| `/check-confirmations` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/check-credential-expiry` | PLAN-ALLOW | POST | — | — | FD-2: read-only up to the failing SELECT; this is the known prod-exposed 500 |
| `/check-stuck-anchors` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/classify-proof-backcatalog` | DENIED | — | — | — | D6 — persists a durable job_queue checkpoint and advances the census cursor even in dry-run |
| `/cleanup-retention` | DENIED | — | — | — | D2 — calls cleanup_expired_data() — GDPR retention purge, deletes rows the soak measures |
| `/connector-health-check` | PLAN-ALLOW | POST | — | — | read + alert |
| `/consolidate-utxos` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/credit-expiry` | PLAN-ALLOW | POST | — | — | G3 guard passed (0 credits rows due for cycle rollover) |
| `/db-health` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/detect-reorgs` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/docusign-connect-failures-poll` | PLAN-ALLOW | POST | — | — | no DocuSign tenant; exercises the unreachable-vendor path |
| `/docusign-envelope-completed` | PLAN-ALLOW | POST | — | — | drains job_queue rows of that type; bounded last_error, no bytes (§1.6A) |
| `/docusign-listener-drift` | PLAN-ALLOW | POST | — | — | detection only; no DocuSign listener writes |
| `/docusign-notarization-completed` | PLAN-ALLOW | POST | — | — | drains job_queue rows of that type |
| `/docusign-queue-reconciliation` | PLAN-ALLOW | POST | — | — | ENABLE_DOCUSIGN_QUEUE_RECONCILIATION off — exercises the skip path |
| `/docusign-reconciliation` | PLAN-ALLOW | POST | — | — | no tenant; gap detection only |
| `/drain-connector-artifacts` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/drive-file-changed` | PLAN-ALLOW | POST | — | — | drains job_queue rows of that type |
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
| `/financial-report` | PLAN-ALLOW | POST | — | — | read-only aggregation over billing_events / x402_payments / anchors |
| `/generate-reports` | PLAN-ALLOW | POST | — | — | drains pending `reports` rows into report_artifacts — real product behaviour |
| `/grace-expiry-sweep` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/lock-wait` | PLAN-ALLOW | POST | — | — | pg_locks observability read |
| `/mainnet-migration` | DENIED | — | — | — | D3 — mainnet migration must never run on a signet rig |
| `/materialize-proof-backcatalog` | DENIED | — | — | — | D5 — INSERTs anchor_proofs when armed; inertness rides on an env var |
| `/migration-status` | PLAN-ALLOW | GET | — | — | GET; mainnet-migration STATUS read only, no migration |
| `/monitor-fees` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/monitor-stuck-txs` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/monthly-allocation-rollover` | PLAN-ALLOW | POST | — | — | G5 guard passed (ENABLE_ALLOCATION_ROLLOVER=false on the rig) |
| `/nonce-sweep` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/openalex-bulk` | DENIED | — | — | — | D1 — bulk ingestion of the same family; unbounded |
| `/org-queue-scheduler` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/payment-recovery` | PLAN-ALLOW | POST | — | — | G1 guard passed (0 expired active grace periods) |
| `/pipeline-health` | PLAN-ALLOW | POST | — | — | read + alert |
| `/pipeline-throughput-monitor` | PLAN-ALLOW | POST | — | — | read + alert |
| `/populate-confirmation-proofs` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/process-anchors` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/process-revocations` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/professional-education-extraction` | PLAN-ALLOW | POST | — | — | ENABLE_PROFESSIONAL_EDUCATION_SCHEMA_READY off — exercises the 503 gate |
| `/proof-coverage-monitor` | PLAN-ALLOW | POST | — | — | read + alert over anchor_proofs; no writes |
| `/queue-digest` | PLAN-ALLOW | POST | — | — | ENABLE_QUEUE_DIGEST off — no-ops before enumerating admins or sending mail |
| `/queue-reminders` | DENIED | — | — | — | G4 guard failed — enabled scheduled/digest rules = 1 |
| `/rebroadcast-txs` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/reconcile-credit-conservation` | PLAN-ALLOW | POST | — | — | reconciler; read + alert |
| `/reconcile-stripe` | PLAN-ALLOW | POST | — | — | DB-only reconciliation; upserts one reconciliation_reports row |
| `/recover-broadcasts` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/refresh-stats` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/refresh-treasury-cache` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/regulatory-change-scan` | DENIED | — | — | — | D1 — live external registry scan + AI spend |
| `/report-metered-usage` | DENIED | — | — | — | G2 guard failed — active/trialing subscriptions = 2 |
| `/rule-action-dispatcher` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/rules-engine` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/smoke-test` | PLAN-ALLOW | POST | — | — | read-only checks + one audit_events row |
| `/smoke-test/history` | PLAN-ALLOW | GET | — | — | GET; audit_events read |
| `/supplementary-proof-anchor` | DENIED | — | — | — | D4 — only job in the repo that spends real mainnet BTC across the 2.97M backlog |
| `/treasury-alert-check` | PLAN-ALLOW | POST | — | — | read + alert |
| `/webhook-retries` | BOUND | — | — | — | Scheduler-bound; exercised continuously |
| `/workspace-subscription-renewal` | PLAN-ALLOW | POST | — | — | drive/graph renewers are wired to throw; exercises the not-configured path |

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

`CRON_EXERCISER: 0 ok / 0 findings / 51 denied`

_Produced by `scripts/staging/fullsoak-cron-exerciser.sh`. No rig env, flag, secret, scheduler job,
revision or traffic split was modified; the soak clock was not touched._

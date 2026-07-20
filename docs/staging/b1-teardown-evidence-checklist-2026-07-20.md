# SCRUM-2978 — B1 Rig Teardown-to-$0 Evidence Checklist

**Prepared:** 2026-07-20T18:35Z by Release/Train lane (RTE), for the founder to relay to the release-ops session **before** its Jul-21 teardown sweep.
**Target:** the parked fired-team rig `arkova-worker-s33-rig-b1-staging` ONLY.

## ⚠️ Scope guard — what the sweep must NOT touch

| Service | Why it is out of scope |
|---|---|
| `arkova-worker-railb220260719-staging` (rev 00002-cus) | **ACTIVE #1552 T3 soak, matures 2026-07-21T17:13Z.** Any mutation invalidates the chain-rail evidence. |
| `arkova-worker-rca20260719-staging`, `-rcb...`, `-rcd...` | RC rigs stay up (scale-to-zero) until their rails fully merge; separate teardown after rail close. |
| `arkova-worker-staging` (rev 00294-tev) | Permanent shared staging worker. |

The B1 rig and railb2 are **different Cloud Run services**; a name-pattern sweep (`*rig*`, `*staging*`) would catch both. Delete by exact resource names below only.

## A. Pre-teardown inventory (captured 2026-07-20 ~18:30Z, read-only gcloud, verified this session)

**A1. Cloud Run (region us-central1, project arkova1)**
- Service: `arkova-worker-s33-rig-b1-staging`
- Latest ready revision: `arkova-worker-s33-rig-b1-staging-00003-rk9`
- Created: 2026-07-17T11:31:10Z; minScale unset (scale-to-zero — idle cost ≈ $0 compute, but service must go for a clean $0 story)
- Image (shared repo, do NOT delete the repo): `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker@sha256:9ed624c58431ca62db4299915bd0de9f1838079b7b8faf1a873e750167a8a344`

**A2. Cloud Scheduler jobs (us-central1) — 6 jobs, all `*/5 * * * *`:**
| Job | State at capture |
|---|---|
| `arkova-worker-s33-rig-b1-staging-check-confirmations` | ENABLED |
| `arkova-worker-s33-rig-b1-staging-org-queue-scheduler` | ENABLED |
| `arkova-worker-s33-rig-b1-staging-batch-anchors-forced-flush` | **PAUSED** (parked 07-19) |
| `arkova-worker-s33-rig-b1-staging-populate-confirmation-proofs` | ENABLED |
| `arkova-worker-s33-rig-b1-staging-batch-anchors` | ENABLED |
| `arkova-worker-s33-rig-b1-staging-recover-broadcasts` | ENABLED |

Note: 5 of 6 are still ENABLED and firing every 5 min into a treasury-empty no-op loop. They are billable invocations + Cloud Run wakeups; deleting them is the largest live cost lever.

**A3. Supabase**
- Project ref: `hyhfundpysaydvejweia` (from secret `supabase-url-s33-rig-b1-staging`)
- Paid-tier caveat (standing): paid projects **cannot be paused via MCP** — either DELETE the project, or founder downgrades/pauses from the dashboard. Teardown-to-$0 requires delete (or downgrade-then-pause); "parked" still bills.

**A4. Secret Manager — 9 rig-scoped secrets:**
`arkova-s33-rig-b1-api-key-hmac`, `arkova-s33-rig-b1-bitcoin-core-signet-rpc-auth`, `arkova-s33-rig-b1-bitcoin-core-signet-rpc-url`, `arkova-s33-rig-b1-cron-secret`, `arkova-s33-rig-b1-stripe-secret-key`, `arkova-s33-rig-b1-stripe-webhook-secret`, `arkova-s33-rig-b1-treasury-wif-signet`, `supabase-service-role-key-s33-rig-b1-staging`, `supabase-url-s33-rig-b1-staging`

**A5. Treasury:** `arkova-s33-rig-b1-treasury-wif-signet` is a signet (test) key; rig treasury verified empty 07-19. Confirm zero signet balance before secret deletion (address recorded in rig standup notes) so no residual funds are orphaned.

## B. Evidence to bank BEFORE deleting anything

1. `gcloud run services describe arkova-worker-s33-rig-b1-staging --region=us-central1 --format=json` → save full JSON (revision history + env + image digest).
2. `gcloud scheduler jobs list --location=us-central1 --filter="name~s33-rig-b1"` full output.
3. `gcloud secrets list --filter="name~rig-b1"` full output.
4. Supabase: `staging_deploy_log` rows + migration ledger snapshot from `hyhfundpysaydvejweia` (the hollow-soak incident record on tracker 88768514 references this project's 0-provenance state — this snapshot is the audit artifact; losing it un-proves the incident).
5. Last 24h Cloud Run request-log sample showing no-op loop (supports "nothing of value was running").

## C. Teardown order (release-ops executes)

1. Delete the 6 scheduler jobs FIRST (stops invocations; prevents error-spam against a deleted service).
2. Delete Cloud Run service `arkova-worker-s33-rig-b1-staging`.
3. Delete Supabase project `hyhfundpysaydvejweia` (or founder downgrade→pause if data retention is wanted — but that is NOT $0).
4. Delete the 9 Secret Manager secrets (after B-snapshots banked; active secret *versions* bill per-version-month).
5. Do NOT touch the shared Artifact Registry repo `arkova-worker-images` (shared with prod/other rigs).

## D. Post-teardown zero-resource + $0 proof (capture in sweep session, attach to SCRUM-2978)

1. `gcloud run services list --region=us-central1 | grep s33-rig-b1` → **empty**.
2. `gcloud scheduler jobs list --location=us-central1 --filter="name~s33-rig-b1"` → **0 rows**.
3. `gcloud secrets list --filter="name~rig-b1"` → **0 rows**.
4. Supabase org project list (API or dashboard) no longer contains `hyhfundpysaydvejweia`.
5. Billing: GCP Billing report filtered to Cloud Run + Scheduler SKUs, label/service = b1 resources, date-bounded from teardown timestamp → trending to $0 (note: billing export lags ~1 day; the $0 assertion is "no billable resources exist" on day 0, confirmed by report on day +1). Supabase: invoice/usage page shows project removed from the paid org.
6. One-line attestation in the sweep log: resource names deleted + timestamps + operator identity — HANDOFF claims-lint compatible.

## E. Acknowledgment

Release-ops session: reply/ack against SCRUM-2978 (or via founder) that this checklist is in hand **before** starting the sweep. Per the safe-work order pre-mortem ("B1 teardown evidence loss — evidence front-runs sweep"), if unacknowledged by Jul-21 morning ET the RTE lane escalates to hold the sweep by minutes until the B-section snapshots are banked.

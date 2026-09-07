# Arkova Infrastructure Cost Report

**Date:** 2026-09-05
**Scope:** Supabase organization `byhkazrpmivhcsuqjtva` and Google Cloud project `arkova1` (region `us-central1`)
**Mode:** Read-only audit. Nothing was deleted, paused, resized, or reconfigured.
**Prepared for:** CTO, for hand-off to the founder.

---

## 1. Headline

| Question | Answer |
|---|---|
| Reclaimable **today**, no work blocked | **$92 / month** (plus **$262 / month** more if the Sekura scanning VM is finished) |
| Reclaimable **after the current pull-request queue clears** | **$332 / month** additional |
| Total addressable if everything closes | **$686 / month** |
| Largest single line item | `sekura-arkova` Compute Engine VM, **$262 / month** |
| Largest structural line item | 14 per-soak Supabase projects plus their 14 Cloud Run services, **$324 / month** combined |

The estimate is derived from published list prices, not from billing data. The Cloud Billing API is not enabled on project `arkova1` and the active service account (`270018525501-compute@developer.gserviceaccount.com`) cannot enable it, so actual invoiced cost by service could not be pulled. That is a gap worth closing: enabling `cloudbilling.googleapis.com` and granting the auditing identity Billing Account Viewer would let this report be produced from real spend instead of list price.

Estimating method for Cloud Run: a service with `minScale >= 1` is billed continuously for its reserved instances. At the us-central1 Tier-1 minimum-instance idle rate ($0.0000025 per vCPU-second and $0.0000025 per GiB-second) across 2,628,000 seconds per month, an always-on 1 vCPU / 1 GiB instance costs **$13.14 / month** and a 1 vCPU / 256 MiB instance costs **$8.21 / month**. Request-driven CPU above that idle floor is additional and is not included.

---

## 2. What another session already did today

A peer session (Codex, evidence under `/Volumes/Extreme/offload/codex-release-evidence/2026-09-05/`) ran two rig retirements earlier today. This report accounts for the state **after** those retirements, so the savings below are not double counted.

| Retirement batch | Supabase projects deleted | Cloud Run services deleted | Recovered |
|---|---|---|---|
| `first-retirement` (14:22 UTC) | `vmfsmtilaovdjypqhjob` (arkova-soak-flag-live-2438), `bwkxdehfjedynnjmnsos` (arkova-soak-decl2499) | `arkova-worker-flag-live-2438-staging`, `arkova-worker-decl2499-staging` | approx. $46 / month |
| `older-retirement` (15:10 UTC) | `kyaecvotcbalsfahwslt` (docusign-guard), `yfqgxycaiwgvvvbzhkma` (mig-docusign-trust), `rvdgwynxoapdzysoaayr` (rc-batch-0902) | the three matching `*-staging` services | approx. $69 / month |

Five projects and five services were removed, along with 12 dedicated secrets. Evidence: `first-retirement/completion/first-pair-retirement-result.json` and `older-retirement/completion/older-three-retirement-result.json`.

---

## 3. Supabase

Organization `byhkazrpmivhcsuqjtva` ("carson-see's Org") is on the **Pro** plan. `get_cost` returns **$10 per month per additional project**. There are **16 projects**, all `ACTIVE_HEALTHY`, all in `us-east-2`.

Per CLAUDE.md section 7 a paid project cannot be paused through the MCP (pausing requires a free-tier downgrade first), so the only two choices are **delete** or **keep**.

Two projects are permanent:

- **`vzwyaatejekddvltxyye`** ("carson-see's Project") is **production**. Never touch.
- **`fizyjojbebyalirtjjht`** ("arkova-staging-2026-08", created 2026-08-19) is the **standing shared staging rig**. Keep. Note it currently carries a pull-request-only ledger row (0420), so it is not clean-mirror for every soak.

The other 14 are per-soak isolated rigs. Every one of them is currently bound to at least one open pull request.

### 3.1 Per-project inventory

| # | Name | Ref | Created | Serves (PRs) | Soak driver running now | Verdict |
|---|---|---|---|---|---|---|
| 1 | arkova-soak-oldest2314-0905 | `bzzmjnfrzqkxihdtsbyl` | 2026-09-05 00:46 | #2314, #2434 | Yes (`soak2314-recovery.py`) | DELETE AFTER #2314 and #2434 merge |
| 2 | arkova-soak-oldest-worker-0905 | `txvvrxngyfnnqahujbld` | 2026-09-05 01:00 | #2436, #2437, #2438 | Yes (`soak_worker_batch.py`) | DELETE AFTER #2436, #2437, #2438 merge |
| 3 | arkova-soak-oldest-migrations-0905 | `euyzkmmstcyuuwhwtbqz` | 2026-09-05 01:17 | #2440, #2442 | Yes (`soak_migration_batch.py`) | DELETE AFTER #2440 and #2442 merge |
| 4 | arkova-soak-oldest-docusign-0905 | `zjwtnkwnwjpcmclkuvdf` | 2026-09-05 01:49 | #2472, #2474, #2476, #2485, #2486, #2496 | Yes (`soak_esign_batch.py`) | DELETE AFTER the DocuSign stack merges |
| 5 | arkova-soak-oldest-evidence-0905 | `iyswrdnxitoyxavrlmmz` | 2026-09-05 02:35 | #2499 | Yes (`soak_evidence2499.py`) | DELETE AFTER #2499 merges |
| 6 | arkova-soak-oldest-reorg-0905 | `itenuyhkhktferocxgwa` | 2026-09-05 12:24 | #2495 | Yes (`soak_reorg2495.py`) | DELETE AFTER #2495 merges |
| 7 | arkova-soak-oldest-proof-0905 | `bajuefkqhizsyycaeqff` | 2026-09-05 12:41 | #2524, #2527 | Yes (`soak_proof_batch.py`) | DELETE AFTER #2524 and #2527 merge |
| 8 | arkova-soak-oldest-attest-0905 | `hlbddnfpxisjlthmklig` | 2026-09-05 12:45 | #2525 | Yes (`soak_attest2525.py`) | DELETE AFTER #2525 merges |
| 9 | arkova-soak-oldest-adobe-0905 | `ixekmrkkhqyqtycerihq` | 2026-09-05 13:29 | #2519, #2529, #2569, and #2564 is planned onto it | Yes (Adobe CI repair drivers) | KEEP until the Adobe stack and #2564 close |
| 10 | arkova-soak-mfa-3167 | `nesuwjlscilzzbhpvbkt` | 2026-09-03 06:21 | #2637 | Yes (`security-soak-supervisor.py`) | DELETE AFTER #2637 merges. Window restarted 2026-09-05 16:32 UTC, earliest completion 2026-09-07 16:32 UTC |
| 11 | arkova-soak-suborg-3863 | `jpdhektjeawfjkznmpfe` | 2026-09-02 01:11 | #2572 | Yes (`docs/staging/suborg-3863/run-soak.sh`, pid 42611) | DELETE AFTER #2572 merges |
| 12 | arkova-soak-provisioning-3873 | `owieixqcnigfpiowptop` | 2026-09-01 21:20 | #2571 | Yes | DELETE AFTER #2571 merges. Window restarted 2026-09-05 16:45 UTC, earliest completion 2026-09-07 16:45 UTC |
| 13 | arkova-soak-admin-rpc-0428 | `vofhfzyosxlneupohsem` | 2026-09-01 20:41 | #2564, #2565 | **No driver attached** | **REVIEW.** Both pull-request bodies state the soak has not started, and #2564 proposes moving onto the existing Adobe rig instead of holding a second paid project. If the CTO confirms that redirection, this rig is a **DELETE NOW** and returns $23 / month immediately |
| 14 | arkova-soak-reorg-3836 | `hgmluvnqgfcigevqeebu` | 2026-08-30 22:07 | #2655 (still a draft) | **No driver found** | **REVIEW.** Oldest non-standing rig, 6 days old. Its only claimant is a draft pull request. Confirm #2655 will actually use it, otherwise **DELETE NOW** for $23 / month |

### 3.2 Supabase cost summary

| Bucket | Projects | Monthly |
|---|---|---|
| Production | 1 | $10 (keep) |
| Standing shared rig | 1 | $10 (keep) |
| Per-soak rigs bound to a running window | 12 | $120 (blocked until their PRs merge) |
| Per-soak rigs with no running driver (rows 13 and 14) | 2 | **$20 reclaimable subject to one CTO confirmation each** |
| **Total Supabase project charges** | **16** | **$160 / month** |

Reclaimable after the queue clears, keeping production and the standing rig: **$140 / month**.

---

## 4. Google Cloud

### 4.1 Cloud Run (20 services, us-central1)

| Service | Class | minScale | Shape | Est. monthly | Verdict |
|---|---|---|---|---|---|
| `arkova-worker` | **Production** | 2 | 2 vCPU / 2 GiB | $52.56 idle floor plus request CPU | KEEP |
| `arkova-worker-staging` | Standing staging | 1 | 1 vCPU / 1 GiB | $13.14 | KEEP |
| `arkova-worker-oldest2314-0905-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER #2314 and #2434 |
| `arkova-worker-oldest-worker-0905-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER #2436, #2437, #2438 |
| `arkova-worker-oldest-migrations-0905-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER #2440 and #2442 |
| `arkova-worker-oldest-docusign-0905-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER the DocuSign stack |
| `arkova-worker-oldest-evidence-0905-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER #2499 |
| `arkova-worker-oldest-reorg-0905-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER #2495 |
| `arkova-worker-oldest-proof-0905-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER #2524 and #2527 |
| `arkova-worker-oldest-attest-0905-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER #2525 |
| `arkova-worker-oldest-adobe-0905-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | KEEP until the Adobe stack and #2564 close |
| `arkova-worker-mfa2637-0905-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER #2637 |
| `arkova-worker-suborg-3863-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER #2572 |
| `arkova-worker-provisioning-3873-staging` | Per-soak rig | 1 | 1 vCPU / 1 GiB | $13.14 | DELETE AFTER #2571 |
| `arkova-worker-admin-rpc-0428-staging` | Per-soak rig, idle | 1 | 1 vCPU / 1 GiB | $13.14 | REVIEW, see Supabase row 13 |
| `arkova-worker-reorg-3836-staging` | Per-soak rig, idle | 1 | 1 vCPU / 1 GiB | $13.14 | REVIEW, see Supabase row 14 |
| `arkova-release-proof-provider-0905-staging` | Signet RPC provider for the proof soak | 1 | 1 vCPU / 256 MiB | $8.21 | DELETE AFTER #2524 and #2527 |
| `arkova-release-reorg-provider-0905-staging` | Signet RPC provider for the reorg soak | 1 | 1 vCPU / 256 MiB | $8.21 | DELETE AFTER #2495 |
| `cft-webhook-sink` | **Orphan** | 1 | 1 vCPU / 256 MiB | $8.21 | **DELETE NOW.** Created 2026-08-30, referenced nowhere in the repository, and its only log lines in the last 7 days are container start-up probes. It has served no request |
| `chaindump-mcp` | Orphan, scales to zero | none | 1 vCPU / 512 MiB | approx. $0 | DELETE for hygiene. No cost benefit. Referenced only in historical August soak documentation |

**Every non-production service in this project runs `minScale >= 1`, which means all 18 of them bill continuously whether or not a soak driver is pointing at them.** That is the structural cost driver: $170.61 per month of always-on non-production Cloud Run capacity, plus $24.63 of always-on 256 MiB helpers.

A standing recommendation for the CTO: the per-soak worker template should set `minScale = 0` unless the soak specifically measures cold-start or continuous-uptime behavior. Several of these windows are driven by an external polling script that would tolerate a cold start. That single template change would cut idle rig cost by roughly 90 percent without changing evidence quality for most tiers. It does not apply to windows that explicitly assert continuous worker uptime, such as #2637.

### 4.2 Vertex AI

| Check | Result |
|---|---|
| `gcloud ai endpoints list --region us-central1` | **Empty** |
| `gcloud ai endpoints list --region us-east1` | **Empty** |
| `gcloud ai models list --region us-central1` | 18 model artifacts, oldest 2026-03-29, newest 2026-05-31 |

**Zero deployed endpoints. Vertex serving cost is $0 / month.** This is fully compliant with CLAUDE.md section 0 rule 7, and in fact below the 1 to 2 steady-state target, which is the correct posture while no tuning or evaluation run is in flight. The 18 model artifacts cost effectively nothing to retain and preserve the redeploy path, so they should be left alone.

### 4.3 Artifact Registry

| Repository | Size | Image versions |
|---|---|---|
| `arkova-worker-images` | **101.8 GiB** | 918 |
| `cloud-run-source-deploy` | 7.9 GiB | 140 |
| `arkova-worker` | 3.3 GiB | 63 |
| `gcr.io` | 1.2 GiB | not counted |
| **Total** | **approx. 114 GiB** | |

At $0.10 per GiB per month beyond the 0.5 GiB free tier this is approximately **$11.4 / month**. The 918 versions in `arkova-worker-images` are one per worker build since 2026-03-12. Production and every rollback target need only a small recent window plus any digest referenced by a live revision or a frozen soak. A cleanup policy that keeps, for example, the last 60 days plus all digests referenced by an existing Cloud Run revision would recover most of it, on the order of **$8 to $10 / month**. Risk is low but not zero: deleting a digest referenced by a frozen soak revision would invalidate that evidence, so the policy must exclude in-use digests.

### 4.4 Compute Engine

| Instance | Machine type | Created | Disks | Est. monthly | Verdict |
|---|---|---|---|---|---|
| `sekura-arkova` | n2d-standard-8 (8 vCPU, 32 GiB) | 2026-08-29 | 100 GiB pd-balanced | **$262** ($252 compute, $10 disk) | **DECISION NEEDED.** This is the Sekura security-scanning appliance. It is the single most expensive resource in the estate. If the Sekura engagement has moved past the scanning phase, deleting it recovers $262 / month immediately. If scanning is ongoing, it should stay, but consider stopping the instance between scan windows, which recovers the $252 compute portion while keeping the disk and its configuration for $10 / month |
| `arkova-s33-rig-b1-bitcoin-core-signet` | e2-standard-2 (2 vCPU, 8 GiB) | 2026-07-27, last started 2026-08-12 | 20 GiB boot plus 100 GiB data | **$64** ($49 compute, $12 disk, $3 external IP) | **DELETE NOW, pending one confirmation.** This was the Sprint 3.3 signet Bitcoin Core node. No current soak points at it: the two rigs that anchor to a Production Network test environment (`oldest-proof`, `oldest-reorg`) resolve their node URL to the two `arkova-release-*-provider-0905-staging` Cloud Run services, not to this VM's RPC address `10.33.10.10`. Its only references in the repository are historical August soak documents, one of which is a teardown checklist |

Also in the estate and correctly retained: the Cloud NAT router `arkova-bot-router-uscentral1` holding static egress address **136.112.181.65**. That address is the allowlisted scan-source IP, so it must not be released.

### 4.5 Secret Manager

**297 secrets.** 165 carry a `-staging` suffix and are scoped to a named rig. Cross-referencing the rig token in each name against the list of live Cloud Run services:

| Bucket | Count |
|---|---|
| Bound to a service that still exists | 29 |
| **Orphaned: the rig they name no longer exists** | **136**, spanning 88 dead rig identities |
| Not rig-scoped (production, shared, provider credentials) | 132 |

At $0.06 per active version per month the orphaned set costs approximately **$8.2 / month**. The dead rig identities include the whole Sprint 3 wave (`s3-ai`, `s3-batch-anchor`, `s3-ce`, `s3-chain-resil`, `s3-class-0354`, `s3-classifier`, `s3-cpe-cle`, `s3-fe-proof`, `s3-ops-slo`, `s3-queue10`, `s3-verifier`, `s3-webhooks`), the July release candidates (`rca20260719`, `rcb20260719`, `rcd20260719`, `railb220260719`, `rc-t2-20260726`, `rc-t2-docusign-20260726`), the Sprint 0 Epic 4 lanes (`s0e4-lane-a`, `s0e4-lane-b`), the S3.3 group rigs (`s33-g1-a`, `s33-g1-b`, `s33-rig-b1`), the August wave (`launch-72h-2026-08`, `legacy-soak-2026-08`, `node22-2026-08`, `connector-sidecar-2026-08`, `ferpa-2314-2026-08`, `consolidated-mm-2026-08`, `cleanup-2335`, `credits-2442`, `docusign-bilateral`, `attest-park-0902`, `cron-chain-batch`), and assorted bug-hunt and numbered soak rigs.

The dollar value is small. The reason to clean this up is **security surface, not cost**: 136 live credential secrets naming environments that no longer exist. Several are service-role keys and treasury WIF values. Recommended action is a scripted sweep that deletes only secrets whose rig token matches no live Cloud Run service and no live Supabase project, with a dry run reviewed first. Risk: a secret that looks rig-scoped but is actually shared. The `older-retirement` evidence file shows the peer session already established a "confirmed unshared secrets" check for exactly this, so that logic can be reused rather than reinvented.

### 4.6 Cloud Scheduler

**62 jobs** in us-central1. 54 enabled, 8 paused.

At $0.10 per job per month beyond the 3 free jobs, this is approximately **$5.9 / month**. Two observations that matter more than the dollars:

- Eight paused jobs are still billed: `arkova-worker-reorg-3836-staging-detect-reorgs`, `bq-export-incremental`, `chaindump-desk-daily`, `fetch-state-courts-ca`, `fetch-state-courts-ny`, `fetch-state-courts-tx`, `generate-reports`, `workspace-subscription-renewal`. Deleting rather than pausing the ones that are permanently retired recovers about $0.80 / month and removes ambiguity about intent.
- `arkova-worker-reorg-3836-staging-detect-reorgs` is a rig-scoped job that will be orphaned when that rig is retired. Rig teardown should delete matching scheduler jobs, which the peer session's retirement script already does.
- `lock-wait-monitor` runs every minute. That is 43,200 worker invocations per month against production. It is cheap on Scheduler but it is not free on the Cloud Run side, and it deserves a look at whether every-minute cadence is still needed after the 2026-08-11 lock-barrier incident was closed.

### 4.7 Cloud Storage

| Bucket | Size |
|---|---|
| `run-sources-arkova1-us-central1` | 8.03 GiB |
| `arkova1_cloudbuild` | 6.69 GiB |
| `arkova-training-data` | 0.18 GiB |
| `arkova1-s33-immutable-authority-ledger` | 0.01 GiB |
| `arkova1-sekura-tfstate` | under 0.01 GiB |
| `cloud-ai-platform-babb4f00-...` | under 0.01 GiB |
| **Total** | **approx. 14.9 GiB, roughly $0.30 / month** |

Not worth acting on. `run-sources` and `cloudbuild` are build-artifact scratch and would benefit from a 90-day lifecycle rule purely as hygiene.

### 4.8 Compute snapshots

**31 snapshots, 40.8 GiB, approximately $1.06 / month.** Every one of them belongs to a virtual machine that no longer exists: `arkova-intern-1` (11 snapshots), `sarah-bot-1-australia-southeast` (14), `logindefense2` (3), plus single snapshots of `arkova-bot`, `arkovaintern`, and `experiment-1`. Dates run from 2026-02-03 to 2026-03-12.

Two daily snapshot schedules named `default-schedule-1` are still active, in us-central1 and australia-southeast1. They are producing nothing today because their source disks are gone, but they should be deleted so they do not silently start snapshotting a future disk.

**Handle the three `logindefense2` snapshots separately.** Login Defense is a live partner organization and has been deprovisioned in error before. These are snapshots of a deleted virtual machine, not the partner's production data, but they should be confirmed with the founder before deletion rather than swept automatically.

### 4.9 Logging

Two buckets, both `global`: `_Default` at 30-day retention and `_Required` at 400-day retention (the latter is fixed by Google and not billable). Only the two default sinks exist, so nothing is being exported to a second paid destination.

Per-bucket stored volume is not exposed by `gcloud logging buckets list`, and without the Billing API the ingestion volume cannot be measured. Logging ingestion is $0.50 per GiB beyond 50 GiB free per month. With 54 enabled scheduler jobs, an every-minute monitor, and 18 always-on non-production Cloud Run services all emitting request logs, this is a plausible but unquantified cost. **Recommendation: enable the Billing API and check the Logging line before assuming it is small.** An exclusion filter dropping `arkova-worker-*-staging` request logs from `_Default` is the obvious lever if it turns out to be material.

### 4.10 Not present

- **Cloud SQL:** the API is not enabled on the project. There are no Cloud SQL instances and therefore no cost.

---

## 5. Ranked savings table

| Rank | Item | Monthly | Action | Risk | Blocked until |
|---|---|---|---|---|---|
| 1 | `sekura-arkova` VM (n2d-standard-8) | **$262** | Delete, or stop between scan windows to recover $252 and keep the $10 disk | **High if the engagement is live.** Deleting ends the vendor's scanning capability | Founder or CTO confirms the Sekura scanning phase is complete |
| 2 | 14 per-soak Supabase projects | **$140** | Delete each rig as its pull requests merge | Low if the window is closed. **Destroying a rig mid-window invalidates frozen evidence and forces a full re-soak** | Each rig's pull requests merge. Earliest known completions: 2026-09-07 16:32 UTC (#2637) and 2026-09-07 16:45 UTC (#2571) |
| 3 | 14 per-soak Cloud Run services | **$184** | Delete alongside the matching Supabase rig | Same as above. Delete the service and the project together so neither is left orphaned | Same as row 2 |
| 4 | `arkova-s33-rig-b1-bitcoin-core-signet` VM | **$64** | Delete the instance, both disks, and the two reserved addresses | Low. No live rig resolves to its RPC address | Confirm no off-repository tooling dials `10.33.10.10` |
| 5 | Two `arkova-release-*-provider-0905-staging` services | **$16.42** | Delete with the proof and reorg rigs they serve | Low, but they are the node endpoint for two running windows | #2495, #2524, #2527 merge |
| 6 | Artifact Registry retention policy | **approx. $10** | Keep the last 60 days plus every digest referenced by a live revision, delete the rest | Medium. Deleting a digest referenced by a frozen soak revision breaks that evidence | Policy written and dry-run reviewed |
| 7 | `cft-webhook-sink` | **$8.21** | **Delete now.** Zero requests, zero repository references | Very low | Nothing |
| 8 | 136 orphaned rig secrets | **$8.2** | Scripted sweep against live services and projects, dry run first | Medium. A shared secret misclassified as rig-scoped would break a live path. Reuse the peer session's unshared-secret check | Dry run reviewed |
| 9 | `arkova-soak-admin-rpc-0428` rig plus service | **$23** | Delete if #2564 is redirected onto the Adobe rig as its own body proposes | Low. No driver is attached and no window has started | CTO confirms the redirection |
| 10 | `arkova-soak-reorg-3836` rig plus service | **$23** | Delete if draft #2655 is not going to use it | Low. No driver found | CTO confirms #2655's rig plan |
| 11 | 31 orphan snapshots plus 2 dead schedules | **$1.06** | Delete, handling the three `logindefense2` snapshots separately | Low, except the Login Defense items | Founder confirms the Login Defense snapshots |
| 12 | 8 paused scheduler jobs | **$0.80** | Delete the permanently retired ones | Very low | Nothing |
| 13 | `chaindump-mcp` | **$0** | Delete for hygiene | Very low | Nothing |

**Reclaimable now with no blocker:** rows 7, 12, 13 give $9.01, plus row 4 at $64 and row 8 at $8.2 once their single confirmations are answered, plus row 6 at approximately $10 once a policy is written. Call it **$92 / month** in the immediate window.

**Reclaimable after the pull-request queue clears:** rows 2, 3, 5, 9, 10 total **$386.42**, of which rows 9 and 10 ($46) may land sooner. Net additional after the queue: **$332 / month** counting rows 9 and 10 in the immediate bucket, or $386 if they wait.

**Reclaimable if the Sekura engagement is complete:** a further **$262 / month**.

---

## 6. Local evidence directories, so nothing is lost on deletion

Every rig below has its evidence persisted on the local SSD, outside the cloud resources being deleted. Deleting a rig destroys the running database, not the recorded evidence.

Root: `/Volumes/Extreme/offload/codex-release-evidence/2026-09-05/`

| Rig ref | Evidence paths |
|---|---|
| `bzzmjnfrzqkxihdtsbyl` | `migration-audit/2434-corrected-window-body.md`, `migration-audit/bzzmjnfrzqkxihdtsbyl-readonly.json`, `migration-audit/edge2434-corrected-window/`, `migration-audit/pr2314-function-parity.json`, `recovery-2314-auth-1540/` |
| `txvvrxngyfnnqahujbld` | `harness-enospc-1407/worker-batch--docs--staging--oldest-worker-0905--status.json`, `migration-audit/2436-body-clock-corrected.md`, `first-retirement/private/pr-2438-current.json` |
| `euyzkmmstcyuuwhwtbqz` | `migration-audit/2440-body-clock-corrected.md`, `migration-audit/2442-body-clock-corrected.md`, `adobe-ci-repair/adobe_catalog.py` |
| `zjwtnkwnwjpcmclkuvdf` | `harness-enospc-1407/docusign-batch--docs--staging--oldest-docusign-0905--status.json`, `migration-audit/2472-body-clock-corrected.md`, `migration-audit/2474-body-clock-corrected.md` |
| `iyswrdnxitoyxavrlmmz` | `first-retirement/private/pr-2499-current.json`, `migration-audit/2499-body-clock-corrected.md`, `migration-audit/active-rig-auth-baseline-audit.json` |
| `itenuyhkhktferocxgwa` | `migration-audit/2495-body-clock-corrected.md`, `migration-audit/auth-behavior/itenuyhkhktferocxgwa/`, `migration-audit/all-active-catalog-comparisons.json` |
| `bajuefkqhizsyycaeqff` | `migration-audit/2524-body-clock-corrected.md`, `migration-audit/2527-body-clock-corrected.md` |
| `hlbddnfpxisjlthmklig` | `migration-audit/2525-body-clock-corrected.md`, `migration-audit/attest-corrected-window/cycles/` |
| `ixekmrkkhqyqtycerihq` | `adobe-ci-repair/` (full tree, including `admin-admission/` and `catalog-current/`) |
| `nesuwjlscilzzbhpvbkt` | `mfa-full-catalog-1557/` (admission, audited worker result, auth behavior, baseline correction plan), `mfa-security-restart-1635/` |
| `jpdhektjeawfjkznmpfe` | `pr2528-active/HANDOFF.md`, `pr2569-review/HANDOFF.md`, `pr2570-atomic-review/HANDOFF.md`, and in-repository `docs/staging/suborg-3863/` |
| `owieixqcnigfpiowptop` | `pr2528-active/HANDOFF.md`, `pr2569-review/HANDOFF.md`, `older-retirement/completion/older-three-retirement-result.json` |
| `vofhfzyosxlneupohsem` | `older-retirement/completion/`, `adobe-frontend-rollback-review/HANDOFF.md` |
| `hgmluvnqgfcigevqeebu` | `older-retirement/private/hgmluvnqgfcigevqeebu-project-metadata.json`, `older-retirement/private/older-three-durable-retention-verified.json`, `adobe-frontend-rollback-review/docs/staging/cron-chain-batch/` |
| `fizyjojbebyalirtjjht` (standing) | `adobe-ci-repair/migration-catalog-*.json`, `adobe-frontend-rollback-review/docs/reference/STAGING_RIG.md` |

In-repository evidence for retired and historical rigs additionally lives under `docs/staging/` in directories including `batch-b-2026-08/`, `batch-c-2026-08/`, `batchA-2026-08-28/`, `cleanup-2335-2026-08-29/`, `consolidated-mm-2026-08/`, `credits-2442-2026-08-29/`, `decl2499/`, `dependabot-2026-08-23/`, `docusign-bilateral-2026-08/`, `hakichain-suborgs-2026-09/`, `migration-t3-soak-2026-08/`, and `suborg-3863/`.

---

## 7. Recommended sequence

1. **Today, no approval needed:** delete `cft-webhook-sink` and `chaindump-mcp`, delete the 8 permanently retired scheduler jobs, delete the 2 dead snapshot schedules.
2. **Today, one confirmation each:** delete the signet Bitcoin node VM with its disks and addresses ($64), run the orphan-secret sweep as a dry run and then apply it ($8.2 and a real reduction in credential surface).
3. **This week:** get a decision on `sekura-arkova` ($262). This is the single biggest lever in the estate and it is a business question, not an engineering one.
4. **This week:** write the Artifact Registry retention policy, excluding digests referenced by any live Cloud Run revision.
5. **As each pull request merges:** delete the matching Supabase project, Cloud Run service, rig-scoped scheduler jobs, and dedicated secrets together, as one atomic retirement, following the pattern the peer session already established.
6. **Structural fix, next rig template change:** default per-soak workers to `minScale = 0` unless the window explicitly measures continuous uptime. This is the change that stops the problem recurring.
7. **Enable `cloudbilling.googleapis.com`** and grant the auditing identity Billing Account Viewer so the next edition of this report is built on invoiced spend rather than list price.

---

_Prepared 2026-09-05. Read-only audit. All figures are list-price estimates because the Cloud Billing API is not enabled on project `arkova1`. Verified against: Supabase MCP `list_projects` / `get_organization` / `get_cost`, `gcloud run services list` and `describe`, `gcloud ai endpoints list` in us-central1 and us-east1, `gcloud ai models list`, `gcloud artifacts repositories list`, `gcloud artifacts docker images list`, `gcloud secrets list`, `gcloud scheduler jobs list`, `gcloud compute instances/disks/addresses/snapshots/resource-policies list`, `gcloud storage ls` and `du -s`, `gcloud logging sinks list` and `buckets list`, `gcloud logging read`, and `gh pr list --search <project ref>`._

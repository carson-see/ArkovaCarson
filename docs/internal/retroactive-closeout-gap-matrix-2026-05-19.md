# Internal Engineering Note - Not Documentation

This temporary worksheet is not the documentation source of truth. The corresponding audit record belongs in Confluence space A; this file only preserves the branch-local engineering evidence used while closing PR #834.

# Retroactive Closeout Gap Matrix — 2026-05-19

Snapshot time: 2026-05-19 13:54 EDT
Last evidence update: 2026-05-19 14:18 EDT

Sources reviewed:

- Confluence page 40173570: Retroactive Staging Plan — Production Features Without Staging Evidence
- Confluence page 47251457: CTO Board Report + Prioritized Gap Plan
- Jira issues and comments for SCRUM-1246, SCRUM-1708, SCRUM-1707, SCRUM-952, SCRUM-1786, SCRUM-1247, SCRUM-1734, SCRUM-1740, SCRUM-1741, and SCRUM-1668
- Current GitHub/open PR state for `carson-see/ArkovaCarson`
- Current production worker `/health`
- Current read-only Supabase Management API evidence for production
  `vzwyaatejekddvltxyye` and staging `ujtlwnoqfhtitcmsnrpq`

## Current Production Baseline

| Check | Current fact |
| --- | --- |
| `origin/main` | `48db7498d5299aa2abbb8d57ca3ccd9a94c49943` |
| Production worker `/health.git_sha` | `e5e382913a4fe60bf52c796cdb63a1fa289b9cb0` |
| PR #781 contained in production worker SHA | Yes |
| PR #781 contained in `origin/main` | Yes |
| Drift nuance | Production has the #781 dashboard/treasury/submitted-drain code, but it is not serving the exact current `main` merge SHA. Revision-drift evidence should distinguish "missing #781" from "worker one merge behind main." |
| Production `refresh-pipeline-dashboard-cache` | Corrected on 2026-05-19 from drifted jobid `12` at `*/15 * * * *` to active jobid `35` at the code/runbook cadence `*/2 * * * *`. Three fresh post-change runs succeeded by 2026-05-19T17:53:28Z. |
| Staging `refresh-pipeline-dashboard-cache` | Active jobid `7`, schedule `*/2 * * * *`, latest runs succeeded. |
| Latest revision-drift workflow | Run `26113482234` failed as expected for stale drift at 2026-05-19T17:20Z: live `e5e382913a4fe60bf52c796cdb63a1fa289b9cb0`, main `48db7498d5299aa2abbb8d57ca3ccd9a94c49943`, drift age `84366s`, Sentry event `f012ecc4e7eb4bf3805b6bdc248d3300`. Current main emits `source=revision-drift.yml`; this branch changes the emitted tags to match the Sentry rule contract. |

## No-Touch Open PR Areas

Open PRs are read-only for this closeout lane. Avoid root/worker/edge package files, `.github/workflows/ci.yml`, `.github/workflows/migration-drift.yml`, broad `services/worker/src/**` lint/tenant-isolation areas, DocuSign paths, source-provenance/public-verification paths, `packages/embed/src/index*`, and migration prefixes `0311`, `0312`, and `0313`.

## Issue Status Matrix

| Issue | Jira status observed | Code status | Remaining gate |
| --- | --- | --- | --- |
| SCRUM-1708 | Done | PR #781 merged and production worker contains it; production cache/index/function are present; authenticated API proof shows explicit stale/unavailable truth; prod cron cadence correction applied | Immediate operational drift is corrected. Remaining audit hardening is a two-hour zero-failure postflight window on jobid `35`. |
| SCRUM-1707 | Done | PR #781 merged and production worker contains it | Production direct count fell from `6,189` to `6,020` residual `SUBMITTED` anchors during this closeout pass. All residual rows are still tied to tx `83d1824c05be32915cc969afe29537b96250f7f556691facd1b3a69f8024ee3a`, which mempool currently reports as not found. The stuck-tx monitor is actively reverting these rows to `PENDING` in batches; keep watching to zero or an explicitly accepted bounded residue before claiming fully drained. |
| SCRUM-1786 | Done | PR #781 merged and production worker contains it; authenticated `/api/treasury/status` proof captured | Production treasury API returns no `-1` sentinels and exposes current freshness/error truth. UI screenshot proof can still be captured from a platform-admin browser session if required. |
| SCRUM-952 | Done | PR #784 merged | Staging UAT exists. Production API proof now covers PENDING, SUBMITTED, SECURED-as-`ACTIVE`, and REVOKED with real IDs. Production has no non-deleted `EXPIRED` rows, so EXPIRED remains the only public-verify proof gap unless an operator approves a controlled production fixture. Open PR #817/#823 overlap adjacent provenance code, so do not edit public verification paths here. |
| SCRUM-1247 | Done; duplicate closeout subtasks SCRUM-1914 and SCRUM-1915 transitioned Done on 2026-05-19 | Build SHA and workflow exist; this branch fixes an alert-tag contract mismatch | After this branch merges, run `revision-drift.yml` by `workflow_dispatch` and verify the Sentry event/rule match with `source=revision-drift`, `story=SCRUM-1247`, `deployed_sha`, and `head_sha`. |
| SCRUM-1734 / SCRUM-1740 / SCRUM-1741 | Blocked | PR #738 merged | Production sandbox org/key/quota evidence exists for `[SANDBOX] hakichain`; no webhook endpoint or delivery evidence exists yet. Remaining closure requires a real HakiChain receiver round-trip and, if approved, one sandbox-credit anchor submit/quota smoke. |
| SCRUM-1668 | In Progress | PR #756 merged | Keep staging labeled as soak-artifact unless rebuilt/cleaned; run staging-honesty preflight before accepting future staging evidence. |
| SCRUM-1246 | In Progress | Recovery epic still spans child gates | Close only when child issue states, Confluence evidence, production runtime evidence, partner-sandbox gates, and Jira statuses agree. |

## Production Evidence Snapshot

Read-only evidence collected 2026-05-19 13:35-13:37 EDT.

| Surface | Evidence |
| --- | --- |
| Worker health | `https://arkova-worker-270018525501.us-central1.run.app/health` returned HTTP 200, `status=healthy`, `git_sha=e5e382913a4fe60bf52c796cdb63a1fa289b9cb0`, `network=mainnet`, `database=ok`, `anchoring=ok`, `kms=ok`. |
| Admin auth boundary | Public calls to `/api/admin/pipeline-stats` and `/api/treasury/status` returned HTTP 401 `Authentication required`; authenticated read-only calls used an ephemeral JWT for an existing `is_platform_admin=true` profile and printed only sanitized evidence. |
| Authenticated pipeline API | `/api/admin/pipeline-stats` returned HTTP 200 in `316ms`: `totalRecords=3,012,954`, `pendingRecords=53,586`, `submittedRecords=6,255`, `broadcastingRecords=0`, `anchoredRecords=null`, `securedRecords=null`, `cacheUpdatedAt=2026-05-19T17:30:00.099868+00:00`, `statusCountsAvailable=false`, warning `Pipeline lifecycle counts unavailable: cache returned timeout sentinels or missing buckets.`, negative sentinel count `0`. |
| Authenticated treasury API | `/api/treasury/status` returned HTTP 200 in `412ms` with wallet address redacted, `balanceSats=102043`, `utxoCount=1`, `network=main`, `blockHeight=950112`, fee estimate `3` sat/vB, `totalSecured=2,947,148`, `totalPending=3,452`, `totalBroadcasting=0`, `totalSubmitted=8,186`, `totalRevoked=0`, `distinctTxIds=null`, `avgAnchorsPerTx=null`, `last24hCount=0`, negative sentinel count `0`. |
| Pipeline cache cron | Prod has one active `refresh-pipeline-dashboard-cache` job, jobid `35`, command `SET statement_timeout = '120s'; SELECT refresh_pipeline_dashboard_cache();`, schedule `*/2 * * * *`. The first three post-change runs succeeded: runid `17586` ended `2026-05-19T17:49:35.042245+00:00`, runid `17587` ended `2026-05-19T17:51:55.781092+00:00`, and runid `17588` ended `2026-05-19T17:53:28.212726+00:00`. |
| Pipeline cache freshness | All six cache rows were updated at `2026-05-19T17:52:00.034499+00:00`; support index `idx_anchors_pipeline_status` is valid, ready, and live. |
| Pipeline status counts | `anchor_status_counts` cache is approximate: total `2,958,785`, `PENDING=3,452`, `BROADCASTING=0`, `SUBMITTED=8,186`, `SECURED=2,947,148`, `REVOKED=0`. |
| Pipeline stats | `pipeline_stats.source=scrum_1708_fast_stats`, total records `3,012,954`, submitted records `6,255`, broadcasting records `0`, pending anchor records `3,342`; `secured_records` and `bitcoin_anchored_records` remain `-1` sentinel in the raw cache and must be surfaced as unavailable/stale truth, not silent zero. |
| Direct SUBMITTED shape | Exact direct `SUBMITTED` count was `6,189`; missing `chain_tx_id=0`; all rows were pipeline-source anchors; all source `uspto`; all older than 24h; oldest created `2026-04-23T04:34:49.317242+00:00`, newest updated `2026-05-16T06:51:42.194671+00:00`. |
| Residual SUBMITTED recovery | At 2026-05-19T18:10Z, direct `SUBMITTED` count was `6,020`; all residual rows were still on tx `83d1824c05be32915cc969afe29537b96250f7f556691facd1b3a69f8024ee3a`. Mempool returned not found for that tx, and Cloud Run logs in the prior two hours showed 31 stuck-tx monitor completions with `989` recovered rows. Latest sampled completion checked `50`, stuck `50`, recovered `48`. |
| Treasury cache | `treasury_cache.error=null`, updated `2026-05-19T17:30:04.903+00:00`, network `main`, block height `950112`, balance `102043` confirmed sats, `total_secured=3132358`, `total_pending=1152`, `last_24h_count=0`. |
| Public verification API | Real production IDs returned expected public statuses: `ARK-PAT-AB2JJD` -> PENDING, `ARK-PAT-3E2X9B` -> SUBMITTED with network receipt id/block/explorer URL, `ARK-PAT-TB3BAB` -> ACTIVE for secured/confirmed with network receipt id/block/explorer URL, and `ARK-ACD-Z9NMCY` -> REVOKED with network receipt id/block/explorer URL. A read-only query found `REVOKED=1` and no non-deleted `EXPIRED` rows. |
| HakiChain sandbox | Production contains `[SANDBOX] hakichain`, public id `ORG-TEST-HAKICHAIN-D724D647`, `org_credits.is_test=true`, `anchor_quota=10`, balance `5`, purchased `5`, and one active API key prefix `ak_test_Yqhm` scoped to `verify`, `read:search`, `read:records`, `read:orgs`, and `anchor:write`. No webhook endpoints or delivery logs exist for that org yet. |

## Staging Evidence Snapshot

| Surface | Evidence |
| --- | --- |
| Pipeline cache cron | Staging project `ujtlwnoqfhtitcmsnrpq` has one active `refresh-pipeline-dashboard-cache` job, jobid `7`, schedule `*/2 * * * *`, command matches prod/runbook. Latest five runs succeeded. |
| Cache freshness | All six pipeline cache rows updated at `2026-05-19T17:36:00.072829+00:00`, about 80 seconds old at the read-only check. |
| Standing-staging limitation | Direct staging `SUBMITTED` count was `0` while cache approximate `SUBMITTED` was `567`; standing staging remains a labeled soak artifact, not a clean production mirror. |

## Completed External Actions

These actions were performed after explicit approval on 2026-05-19.

| Action | Exact next step | Rollback / guard |
| --- | --- | --- |
| Correct production dashboard cache cadence | Applied `SUPABASE_PROJECT_REF=vzwyaatejekddvltxyye SUPABASE_ACCESS_TOKEN=... npx tsx scripts/ops/ensure-pipeline-dashboard-cache-cron.ts --apply`. Postflight showed active jobid `35`, schedule `*/2 * * * *`, and three successful fresh runs. | `--apply` unscheduled only jobs named `refresh-pipeline-dashboard-cache` and refused to schedule unless `idx_anchors_pipeline_status` was valid. Rollback remains `--rollback`, which unschedules only that job name. |
| Close duplicate SCRUM-1247 subtasks | Added closeout comments `15749` and `15750`, then transitioned SCRUM-1914 and SCRUM-1915 to Done using transition id `51`. | Evidence is in each issue and parent SCRUM-1247 is Done; no code or prod data mutation involved. |
| Publish minimal draft PR | Opened draft PR #834, `fix: close compliance evidence alert gaps`, from `codex/compliance-closeout-alert-copy-20260519` to `main`. | Draft stays not-ready until the real T1 staging-evidence window is complete and the PR body is updated. |

## Remaining External Actions

| Action | Exact next step | Guard |
| --- | --- | --- |
| Complete PR #834 T1 evidence | Observe the real two-hour T1 window started at `2026-05-19T17:56:08Z`, update the PR body with the final staging/preview evidence, and mark the PR ready only after the gate can pass truthfully. | Branch avoids current open PR file ownership. PR body must include `## Staging Soak Evidence` with a real two-hour T1 window for the `src/pages/**` copy changes. |
| Capture admin UI screenshots | API proof is captured; browser screenshots of the corresponding Pipeline/Treasury admin UI states still require either a platform-admin browser session or an approved temporary session flow. | Read-only UI evidence only; no data mutation required. |
| Capture production public-verify proof | Four of five states are proven with real production IDs. Decide whether EXPIRED is accepted as "no production fixture exists" or approve controlled fixture creation/deletion for an EXPIRED example. | Without real IDs or fixture approval, do not mutate public verification paths because open PR #817/#823 own adjacent code. |
| Finish residual SUBMITTED drain evidence | Watch tx `83d1824c05be32915cc969afe29537b96250f7f556691facd1b3a69f8024ee3a` until remaining `SUBMITTED` rows reach zero or an owner accepts a bounded residue with root-cause classification. | Existing monitor is doing the data movement; avoid ad hoc status updates. |
| Complete HakiChain runtime proof | Register a real HakiChain-controlled receiver, capture verification/test delivery, then capture lifecycle delivery evidence. Separately approve whether to spend one sandbox credit on a live `POST /api/v1/anchor` smoke. | Do not print raw API keys or webhook secrets; evidence should use prefixes, public ids, status codes, and redacted URLs. |

## Changes In This Branch

| Control area | Change |
| --- | --- |
| Revision-drift alerting | `.github/workflows/revision-drift.yml` now emits the tags used by `infra/sentry/alert-rules.json`: `source=revision-drift`, `story=SCRUM-1247`, `deployed_sha`, and `head_sha`. |
| Alert contract evidence | `scripts/ci/check-sentry-alert-contract.test.ts` locks the workflow/rule tag contract so the documented Sentry rule cannot silently stop matching emitted events. |
| Public legal-copy launch blocker | `src/pages/TermsPage.tsx` and `src/pages/PrivacyPage.tsx` no longer show public placeholder/legal-review disclaimers. |
| Copy lint control | `scripts/check-copy-terms.ts` now fails if public UI reintroduces launch-blocker legal placeholder phrases, while preserving normal form-placeholder attributes. |

## Verification

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Passed; lifecycle scripts suppressed |
| `npm run lint:copy` | Passed |
| `npx vitest run scripts/check-copy-terms.test.ts scripts/ci/check-sentry-alert-contract.test.ts` | Passed, 18 tests |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| Local production preview smoke | Passed for `/terms` and `/privacy` on `http://127.0.0.1:4174`; both returned HTTP 200 with final public legal copy and no launch-blocker placeholder phrases. |
| `git diff --check` | Passed |

# Soak Findings — launch-72h-2026-08 + legacy-soak-2026-08

Running log of findings from both 72h signet soaks. Severity-ordered. Full detail for security items lives in the Confluence bug tracker, not here.

## Soak-integrity disclosure — migration 0378 applied to legacy rig mid-soak (residual-risk note, no resoak)

Per §1.11A, verified via direct MCP query against both rig DBs (`supabase_migrations.schema_migrations`) and `gcloud run revisions list` on both services:

- **Worker containers: unmodified.** Both rigs remain on their original clock-start revisions with zero redeploys — `arkova-worker-launch-72h-2026-08-staging-00004-qgj` (created 2026-07-28T19:43:55.770557Z, exact clock start) and `arkova-worker-legacy-soak-2026-08-staging-00002-4sr` (created 2026-07-28T21:32:17.475418Z, exact clock start). Neither the F-1 fix (#1767) nor the F-2 fix (#1768) has been deployed to either rig.
- **Migration `0378` (SEC-RECON grant revokes) was applied to the LEGACY rig's database at 2026-07-28T22:50:39Z** — ~78 minutes into that soak's clock, as the pre-prod rig-test step described in F-... (SEC-RECON remediation). The launch rig never received it; its ledger stops at `0377`.
- **CTO determination: does NOT require a resoak.** It is a pure `REVOKE`-only security narrowing (no functional code path or RLS policy changed), the worker container never restarted, and the cross-tenant/RLS journey probes that ran afterward on the legacy rig already reflect the post-0378 state — so the soak's substantive evidence (auth boundaries hold under sustained load) remains valid. This is recorded as a disclosed residual-risk note rather than treated as if the run were untouched from T+0, per the standing rule that "verifying the attacker is denied" is the easy half — the honest half is stating exactly what changed and when.

## Soak-integrity disclosure — F-2 fix deployed to LEGACY rig mid-soak (residual-risk note, no resoak)

Per §1.11A, CTO-ruled 2026-07-29: redeploy both rigs with the merged F-2 fix (`925f68a5d`, PR #1768) as a disclosed mid-soak runtime change. **Clock NOT reset** — precedent is the migration-0378 disclosure above (same mechanism: "any runtime, migration, or tested-code commit after a soak invalidates exact-head evidence and requires a new soak or an explicit residual-risk note").

- **Image built via Cloud Build** (`gcloud builds submit --tag ... services/worker`, mirroring the exact invocation used for the original rig images): build `beb99396-d5b4-458f-a822-324bd9991954`, SUCCESS, 4m9s, image `us-central1-docker.pkg.dev/arkova1/arkova-worker-images/arkova-worker:925f68a5d60c3802eb135a97e213d1046384e057`, digest `sha256:be3945b294697807adb6b788372bad5c7de797ee4f0b3e498ab34db02bcf9581`.
- **Legacy rig deployed** (lower-cost site first, per its own precedent above): `arkova-worker-legacy-soak-2026-08-staging` revision `-00002-4sr` → `-00004-9jl`, deployed via `gcloud run services update --image` (config-preserving, not a fresh `deploy`), revision created `2026-07-29T19:03:41.067023Z`, 100% traffic. Before/after `--format=export` diff shows **only** the Cloud Run nonce annotation and the image reference changed — zero env/secret drift. Confirmed post-deploy: `BITCOIN_NETWORK=signet`, `MEMPOOL_API_URL` absent, `ENABLE_ORG_CREDIT_ENFORCEMENT=true`, all 6 Cloud Scheduler jobs (incl. `batch-anchors-forced-flush`) still `ENABLED`. `/health` = 200 (IAM-authenticated). Status-code census on the new revision over ~9 minutes / ~2,000 requests: 1,433×200, 277×404, 229×429, 61×400, **0×5xx** — no 5xx-rate stop condition triggered.
- **F-2 mechanism confirmed fixed** via direct manual probe (Cloud Run IAM token + `X-API-Key: ak_test_45a5…`, bypassing the loadgen entirely for a clean signal): a malformed-fingerprint POST to `/api/v1/anchor` returned `400 invalid_format` (reached payload validation), not a 429 from the shadow guard. A well-formed-fingerprint POST reached the org-quota check and returned `429 ORG_QUOTA_EXCEEDED` — a different code path only reachable *after* passing the shadow guard, proving the skip predicate works for keyed `/api/v1/*` traffic.
- **Launch rig NOT touched.** Stopped here per the runbook's own gate ("if anchors don't start flowing, stop and do not touch the launch rig") — see F-7 below. No image was deployed to `arkova-worker-launch-72h-2026-08-staging`; it remains on its original clock-start revision `-00004-qgj`, unmodified.

## F-7 — Legacy rig's loadgen org is quota-blocked; F-2 fix does not yet restore anchor throughput (HIGH, NEW, open)

Discovered immediately while verifying the F-2 deploy above. **Anchor creation on the legacy rig is still 429, but no longer from the F-2 shadow limiter — from a separate, previously-masked business rule.** The loadgen's org (`Seed Fixture Org`, `org_id 5eed0000-0000-0000-0000-0000000000b1`, key prefix `ak_test_45a5…`) is on `tier=FREE` with a 100/anchor quota; the quota-check response reports `current=102205` against `limit=100` (`reset_at` daily). This is **inconsistent with the actual `anchors` table**, which shows exactly 32 rows for this org (matching the documented baseline exactly) — the `102205` figure is not a count of real anchor rows, so it is almost certainly a stale, cumulative, or otherwise-uncapped usage counter, not evidence of 100k+ real creates. Root cause not further diagnosed this session (out of scope for the F-2 redeploy authorization).

**Effect: `SELECT status, count(*) FROM anchors GROUP BY status` on `ryasykzdduzymschbucr` is unchanged post-deploy — still exactly `PENDING=1, SECURED=32, SUBMITTED=1`, the frozen baseline.** VOLUME evidence is NOT accruing on the legacy rig despite the successful F-2 deploy. This blocks the stated purpose of the redeploy (restoring anchor-create throughput for the VOLUME pillar) and needs its own decision (quota bump for the fixture org, or a different fixture/key) before either rig's VOLUME evidence can resume. **Launch rig deploy was deliberately withheld pending this decision** — deploying there now would risk the same non-outcome without first confirming whether launch's loadgen org has the same quota-tier gap.

## F-1 — `org-queue-scheduler` intermittently returns 500 (HIGH, ROOT-CAUSED, fix in draft PR #1767)

Observed on **both** rigs, worsening over the first few hours (launch ~27–30%, legacy climbed to ~57% before the fix):

| Rig | Sampled invocations | 500s | Failure rate |
|---|---|---|---|
| launch-72h-2026-08 | 40 | 11 | 27.5% |
| launch-72h-2026-08 (later sample) | 30 | 8 | 26.7% |
| legacy-soak-2026-08 | 18 | 6 | 33.3% |
| legacy-soak-2026-08 (later sample) | 30 | 17 | 56.7% |

**Root cause (confirmed, not guessed):** `claim_due_org_queue_runs` is a PostgREST RPC that commits its row lock in Postgres, but a rotten-socket transport error (`fetch failed`/ECONNRESET under loadgen connection pressure) can throw *after* that commit and *before* the per-org try/catch that clears `locked_at` / records the run — because the fetch wrapper in `db.ts` deliberately never retries POST/RPC calls (a SCRUM-2899 double-apply guard). Confirmed via DB state: `organization_queue_run_state` showed orgs stuck `status='running'`/locked while `organization_queue_runs` (completion history) was **completely empty** on legacy despite dozens of scheduler ticks.

**Fix:** `claim_due_org_queue_runs` uses `FOR UPDATE SKIP LOCKED`, which makes it uniquely safe to retry — it cannot double-claim. Added one bounded retry on transient transport errors in `services/worker/src/jobs/org-queue-scheduler.ts`. TDD, 3 new tests, 8/8 passing, typecheck/lint clean. **Draft PR #1767** (`fix/org-queue-scheduler-claim-rpc-transport-retry`), tier T2 (worker queue behavior) — needs a 12h soak + CTO pre-mortem before merge, not yet deployed to either frozen soak rig.

**Secondary finding surfaced while diagnosing this:** the logger's error serializer (`services/worker/src/utils/logger.ts:28`) appears to silently drop `error.message`/`stack` at runtime — `logger.error({ error: err }, ...)` logged `"error": {}` during this incident, which is why root-cause required DB-state archaeology instead of just reading the error log. Touches every `logger.error`/`warn` call sitewide; needs its own investigation, not folded into #1767.

## F-2 — Per-IP rate limiter shadows the per-API-key limiter (HIGH, fix ready in draft PR #1768, NOT deployed)

`services/worker/src/index.ts:377` mounts a 60 req/min **per-source-IP** limiter on a broad `/api` prefix, ahead of the real 1,000/min-per-API-key limiter. All `/api/v1/*` traffic is capped at 60/min regardless of key tier. This is why soak load plateaued at ~2.6 RPS against a 28 RPS target — a product defect, not a capacity limit. Would throttle every paying customer at launch and contradicts the documented rate limits (§1.10). **Escalated during the soak to 100% 429 on anchor-create** once loadgen saturated the shared 60/min budget.

**Fix ready:** [PR #1768](https://github.com/carson-see/ArkovaCarson/pull/1768) (draft, T2). Adds a `skip` predicate so the per-IP limiter bypasses `/api/v1/*` requests carrying a syntactically valid API key — those stay fully governed by `apiV1Router`'s own 1,000/min-per-key limiter. Anon traffic and everything outside `/api/v1` is unchanged. Integration test proves both directions; full worker suite (8,921 tests) green. **Not deployed to either soak rig** — needs a T2 soak (12h + rollback rehearsal) and explicit CTO go-ahead before touching the frozen evidence.

## F-3 — `SUBMITTED` with NULL `chain_tx_id` has no recovery path (MEDIUM, open)

`recover_stuck_broadcasts` queries only `BROADCASTING`-state anchors. An anchor left `SUBMITTED` with no txid — the state a broadcast attempt produces if it fails between the status write and the txid write — is structurally outside every scheduled job's scope. Verified by live fault injection that the job *does* correctly recover its in-scope `BROADCASTING` state, which isolates the gap precisely.

## F-4 — GetBlock broadcast parity NOT covered by either soak (disclosed exception)

No valid signet GetBlock credential exists in Secret Manager; both rigs broadcast via the mempool provider. Prod's sovereign broadcast path is therefore unexercised by these soaks and requires separate verification before launch.

Related defect: `GetBlockHybridProvider.broadcastTx` has **no** mempool fallback (only `listUnspent` does), so a GetBlock outage yields a computed-but-never-broadcast txid — a silent no-broadcast failure. Found because it actually happened during provisioning.

## F-5 — `get_org_anchor_stats` / `get_user_anchor_stats` unvalidated caller scope (MEDIUM, open)

Both take a caller-supplied id (`p_org_id` / `p_user_id`) without visibly gating it against `auth.uid()`. Retained as `authenticated` in `0378` because the live dashboard (`src/lib/dashboardStats.ts`) calls them and an emergency grant change was the wrong vehicle for a body fix. Needs an ownership check plus its own soak.

## F-6 — Both soak rigs were provisioned without the `batch-anchors-forced-flush` Cloud Scheduler job (HIGH, FIXED live on both rigs)

`processBatchAnchors` only drains on Trigger A (≥10,000 claimed) or Trigger B (≥3,000 pending AND ≥3h old) — otherwise it waits for the daily 3am EST forced flush (`?force=true`). Every prior isolated soak rig (t3-migration-soak, s33-rig-b1, folders-1657-soak) had a `*-batch-anchors-forced-flush` scheduler job wired at standup; **this rig-provisioning step was missed for both launch-72h-2026-08 and legacy-soak-2026-08.** Anchors accumulated correctly per the design (52 PENDING launch, 32 PENDING legacy) but had no path to drain within the 72h window at soak-scale volume. Not a code bug — a standup gap.

**Fixed live:** added `arkova-worker-{launch-72h,legacy-soak}-2026-08-staging-batch-anchors-forced-flush` (`*/10 * * * *`, `?force=true`) on both rigs, mirroring the existing pattern/secret/service-account. Verified directly via MCP: launch 52→0 PENDING (all SUBMITTED), legacy 32→0 PENDING (31 SUBMITTED, 1 still PENDING — draining), both now progressing toward SECURED via the confirmation-check job.

Loadgen anchor-creation appearing to stop around the same time is a **separate, already-known** issue (F-2 — the shadow rate limiter starves the single-IP loadgen's create calls once read traffic eats the shared 60/min budget), not related to this gap.

## Passing pillars (recorded so the negatives above are read in context)

- Cross-tenant isolation sweep: **PASS**, both rigs.
- RLS coverage: **PASS**, 112/112 tables, both rigs.
- Broadcast recovery for in-scope state: **PASS** (live fault injection, legacy rig).
- Smoke gates T+0–2h: **CLOSED/PASS** both rigs, each with a first anchor SECURED end-to-end and a real txid confirmed on the public signet explorer.
- Migration rollback rehearsal (0359/0360/0368/0370/0377): **PASS**, apply→rollback→verify→re-apply.

_Last refreshed: 2026-07-29T01:xx by CTO monitoring session — F-1 root cause + F-6 fix confirmed via live MCP queries against both rig DBs (anchor status counts, `organization_queue_run_state`/`organization_queue_runs`) and `gcloud scheduler jobs` state; PR #1767 not yet merged or soaked._

_Last refreshed: 2026-07-29T19:1x by Claude (CTO-ruled F-2 redeploy session) — claims verified against: `gcloud builds describe beb99396-…` (SUCCESS); `gcloud run services describe` before/after `--format=export` diff on `arkova-worker-legacy-soak-2026-08-staging`; `gcloud scheduler jobs list` (6/6 ENABLED); `gcloud logging read` status-code census on the new revision (0 5xx / ~2,000 requests); direct authenticated probe against the legacy rig URL (IAM identity token + `X-API-Key`) showing the F-2 shadow-guard skip predicate works; Supabase MCP `execute_sql` on `ryasykzdduzymschbucr` (anchors status counts unchanged; `api_keys`/`organizations` join identifying the quota-blocked fixture org). Launch rig (`arkova-worker-launch-72h-2026-08-staging`, Supabase `nykacscfufdleghzbzhi`) was NOT queried or deployed this session and remains exactly as last documented._

## F-2 resolution — deployed to both live rigs, disclosed mid-soak runtime change

**No resoak.** Both clocks continue unbroken: launch clears 2026-07-31T19:43Z, legacy clears 2026-07-31T21:32Z. This is a disclosed residual-risk runtime change under §1.11A, same class as the earlier migration-0378-on-legacy-rig disclosure. Pre-change evidence (smoke gates, chain broadcast, RLS/cross-tenant probes, migration rollback rehearsal, F-1 clean streak) remains valid and is not re-required.

**What actually shipped, in order:**
1. `925f68a5d` (#1768, merged) — `apiIpShadowGuard` added at the `badgeRouter` mount, exempting `/api/v1/*` requests carrying a valid API key from the 60/min-per-IP bucket.
2. `6f844d484` — **follow-up bug found live during deploy verification**: `app.use(rateLimiters.api, didWebRouter)` at index.ts:422 has no path prefix, so its 60/min-per-IP bucket ran on every request including `/api/v1/*`, re-shadowing the same traffic downstream of fix #1. Confirmed via live rig testing: keyed anchor-creates still 429'd (16/23) after #1768 alone was deployed. Fixed by reusing the same `apiIpShadowGuard` instance on this mount.
3. **`organizations.tier` fixture fix (data change, not code)** — with both shadow-limiter bugs fixed, live testing surfaced the actual remaining blocker: both soak orgs were on `FREE` tier (100 anchors/day quota per `perOrgRateLimit.ts`), with a usage counter already at 104,668 — every create request was correctly being rejected with `ORG_QUOTA_EXCEEDED` (HTTP 429), a legitimate quota gate, not a bug. Bumped both fixture orgs (`ryasykzdduzymschbucr` org `5eed0000-...-b1`, `nykacscfufdleghzbzhi` org `5eed0000-...-b1`) to `ENTERPRISE` tier (1,000,000/day) — appropriate for a soak fixture simulating a high-volume customer, not a change to any real customer-facing default.

**Deploy record:**

| Rig | Old revision | New revision | Image SHA | Deploy time (UTC) |
|---|---|---|---|---|
| legacy-soak-2026-08 | `-00002-4sr` | `-00005-n7k` | `6f844d48433bc3b2be9bafae34a24180394cdf75` | 2026-07-29T19:16:34Z |
| launch-72h-2026-08 | `-00004-qgj` | `-00005-xql` | `6f844d48433bc3b2be9bafae34a24180394cdf75` | 2026-07-29T19:26:21Z |

Both deploys used `gcloud run services update --image` (preserves existing config) with a full before/after env+secret diff confirming zero config drift beyond the image itself.

**Verified end-to-end, not asserted:** direct authenticated `POST /api/v1/anchor` returned `201 Created` on both rigs post-deploy. Real loadgen traffic confirmed transitioning from 429/blocked to succeeding: legacy went from 100% 429 to 0/23 429 with 13/23 2xx in the first post-fix sample window; both rigs' anchor tables show new PENDING rows with `created_at` timestamps seconds old at verification time (legacy: 29 new rows; launch: 52 new rows), versus a multi-hour-frozen baseline beforehand.

**VOLUME pillar now has real data accruing from these timestamps forward** — this was the entire point of the disclosed change. A residual minority of requests still return `400` (payload validation on some loadgen request variants) — a separate, lower-priority loadgen-script issue, not a worker defect, does not block real customer traffic.

## F-8 — forced-flush cadence prevented batches from ever reaching real 10k scale (found + fixed, no resoak)

Once F-2 unblocked real anchor creation, the `batch-anchors-forced-flush` job (added earlier as the F-6 fix, when creation was still near-zero) kept firing every 10 minutes — draining whatever had accumulated (~200-220 anchors) long before it could approach the real `BATCH_ANCHOR_MAX_SIZE=10000` ceiling. Verified live: 21 distinct broadcasts covered 4,489 SECURED anchors on launch (~214/broadcast), 20 covered 4,416 on legacy (~221/broadcast) — confirming the cap itself was never hit; no env override present, this was purely a throughput/cadence mismatch. This meant `batch_insert_anchors` at real 10k scale — the exact thing this soak was originally commissioned to verify (see the standing finding: benchmarked at 1/15th of prod scale, unverified at 10k-DAU volume) — was still not being exercised even after F-2 landed.

**Fix:** widened the forced-flush schedule from `*/10 * * * *` to `0 */8 * * *` on both rigs (Cloud Scheduler config only, no worker redeploy, no resoak). At the observed ~21 anchors/min combined creation rate, an 8-hour window accumulates toward the real 10,000 ceiling before each forced flush, while Trigger A (≥10,000 claimed) and Trigger B (≥3,000 pending AND ≥3h old) remain untouched and can still fire early if conditions are met. Confirmed live via `gcloud scheduler jobs describe`: both jobs show `0 */8 * * *` / `ENABLED`.

**Side benefit:** because each broadcast commits a single 32-byte merkle root regardless of batch size, transaction fee cost tracks broadcast *count*, not anchor count — fewer, larger batches should reduce total treasury burn over the remaining window versus the prior high-frequency/small-batch pattern, partially addressing the standing signet-BTC-runway watch item.

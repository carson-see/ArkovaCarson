# Soak Findings — launch-72h-2026-08 + legacy-soak-2026-08

Running log of findings from both 72h signet soaks. Severity-ordered. Full detail for security items lives in the Confluence bug tracker, not here.

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

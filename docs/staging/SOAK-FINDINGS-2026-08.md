# Soak Findings — launch-72h-2026-08 + legacy-soak-2026-08

Running log of findings from both 72h signet soaks. Severity-ordered. Full detail for security items lives in the Confluence bug tracker, not here.

## F-1 — `org-queue-scheduler` intermittently returns 500 (HIGH, open)

Observed on **both** rigs, so not caused by any single change:

| Rig | Sampled invocations | 500s | Failure rate |
|---|---|---|---|
| launch-72h-2026-08 | 40 | 11 | **27.5%** |
| legacy-soak-2026-08 | 18 | 6 | **33.3%** |

The job runs on a 5-minute cron and succeeds on subsequent cycles (most recent sampled run: 200), so it is flapping rather than hard-down — but roughly one invocation in three failing is far outside the gate matrix's 0.5% 5xx threshold for a scheduled job.

Confirmed **not** caused by migration `0378` (grant revokes): the launch rig never received `0378` and shows the same rate. Timeline places it from soak start.

Needs root-cause: likely contention or a partial-failure path in the org-queue claim/scheduling logic under concurrent load. `claim_due_org_queue_runs` is the natural first read.

## F-2 — Per-IP rate limiter shadows the per-API-key limiter (HIGH, open)

`services/worker/src/index.ts:377` mounts a 60 req/min **per-source-IP** limiter on a broad `/api` prefix, ahead of the real 1,000/min-per-API-key limiter. All `/api/v1/*` traffic is capped at 60/min regardless of key tier. This is why soak load plateaued at ~2.6 RPS against a 28 RPS target — a product defect, not a capacity limit. Would throttle every paying customer at launch and contradicts the documented rate limits (§1.10).

## F-3 — `SUBMITTED` with NULL `chain_tx_id` has no recovery path (MEDIUM, open)

`recover_stuck_broadcasts` queries only `BROADCASTING`-state anchors. An anchor left `SUBMITTED` with no txid — the state a broadcast attempt produces if it fails between the status write and the txid write — is structurally outside every scheduled job's scope. Verified by live fault injection that the job *does* correctly recover its in-scope `BROADCASTING` state, which isolates the gap precisely.

## F-4 — GetBlock broadcast parity NOT covered by either soak (disclosed exception)

No valid signet GetBlock credential exists in Secret Manager; both rigs broadcast via the mempool provider. Prod's sovereign broadcast path is therefore unexercised by these soaks and requires separate verification before launch.

Related defect: `GetBlockHybridProvider.broadcastTx` has **no** mempool fallback (only `listUnspent` does), so a GetBlock outage yields a computed-but-never-broadcast txid — a silent no-broadcast failure. Found because it actually happened during provisioning.

## F-5 — `get_org_anchor_stats` / `get_user_anchor_stats` unvalidated caller scope (MEDIUM, open)

Both take a caller-supplied id (`p_org_id` / `p_user_id`) without visibly gating it against `auth.uid()`. Retained as `authenticated` in `0378` because the live dashboard (`src/lib/dashboardStats.ts`) calls them and an emergency grant change was the wrong vehicle for a body fix. Needs an ownership check plus its own soak.

## Passing pillars (recorded so the negatives above are read in context)

- Cross-tenant isolation sweep: **PASS**, both rigs.
- RLS coverage: **PASS**, 112/112 tables, both rigs.
- Broadcast recovery for in-scope state: **PASS** (live fault injection, legacy rig).
- Smoke gates T+0–2h: **CLOSED/PASS** both rigs, each with a first anchor SECURED end-to-end and a real txid confirmed on the public signet explorer.
- Migration rollback rehearsal (0359/0360/0368/0370/0377): **PASS**, apply→rollback→verify→re-apply.

_Last refreshed: 2026-07-28 by CTO session — rates computed from live `gcloud logging read` output; grant states verified via MCP against prod._

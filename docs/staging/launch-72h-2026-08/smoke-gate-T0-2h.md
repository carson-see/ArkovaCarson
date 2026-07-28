# T+0–2h Smoke Gate — CLOSED (PASS)

Soak: `launch-72h-2026-08` · Clock start: `2026-07-28T19:43:55.770557Z` · Revision `arkova-worker-launch-72h-2026-08-staging-00004-qgj` · Head `3afb79ba6fe63604df6b11bf6541ee44a0f6f8c0` · Supabase `nykacscfufdleghzbzhi`

| Check | Result | Evidence |
|---|---|---|
| Health / signet / migrations / schedulers / auth / zero 5xx | PASS | recorded at clock start (see isolated-rig-provision JSON) |
| First anchor SECURED end-to-end | **PASS at 2026-07-28T20:00:59.409Z (T+17m)** | anchor `37dbae4c-29af-4fb1-8c92-5cb3570d5621`, status `SECURED`, txid `6ab6d7539e7129fe1efbedf4138d1916cbc4cd3915f67cde8108dc841d1a482f` (independently visible on mempool.space/signet), verified via MCP `execute_sql` against `nykacscfufdleghzbzhi` |

Gate closed at T+~45m. Clock stands — no restart required.

## Disclosed exceptions / open observations

1. **GetBlock broadcast parity NOT covered by this soak** (residual-risk exception, recorded in provenance JSON): no valid signet GetBlock credential exists; rig broadcasts via mempool provider. Must be verified separately before launch. Additionally, `GetBlockHybridProvider.broadcastTx` has **no mempool fallback** (only `listUnspent` does) — silent no-broadcast failure mode; filed to backlog.
2. **Fixture anchor `5eed0000-…c1`** left at `SUBMITTED` with NULL txid after a manual reset during blocker triage. Soft-delete blocked by `anchors_legal_hold_no_delete` (fixture is legal-hold by design); backwards status transition correctly refused by `protect_anchor_status_transition()`. Deliberately left in place as a live test of the `recover-broadcasts` job — if unrecovered by next check, that is a genuine soak finding against broadcast recovery, and the stuck-SUBMITTED monitor firing on it is the monitor working.

## 2026-07-28T22:xx follow-up (RTE session — SCRUM-2980 load-gen gap closure)

1. **Fixture anchor `5eed0000-…-c1` — NOT recovered by `recover-broadcasts`, root cause found.** Still `status=SUBMITTED`, `chain_tx_id=NULL`, `updated_at` unchanged since 2026-07-28T19:09:07Z (~2h45m with no change as of this check). Read `services/worker/src/jobs/broadcast-recovery.ts`: `recoverStuckBroadcasts()` calls the `recover_stuck_broadcasts` RPC, which per its own doc comment "finds `BROADCASTING` anchors older than stale threshold **with no chain_tx_id**." The fixture is `SUBMITTED`, not `BROADCASTING` — it is structurally outside this job's query scope, not merely unprocessed yet. **This is a genuine finding, not just "hasn't run yet":** a `SUBMITTED`-with-NULL-txid anchor (the state a broadcast attempt would leave behind if it failed after the status write but before the txid write landed) has no scheduled recovery path in the current job set. Filed as a real gap for backlog, not fixed this session (out of scope — this session's mandate was load-gen + evidence-gap closure, not a code fix to recovery logic).
2. **Load generation — STARTED.** Same design as the legacy rig; see `loadgen-launch-72h-2026-08.json` for config, achieved rate (~9.9 RPS during the post-deploy burst window, settling to a configured 3 RPS sustained), and honest gaps vs the runbook's 28/83 RPS target. Real traffic confirmed landing via the worker's own Cloud Run request logs.
3. **JWT/secret expiry — VERIFIED, no fix needed.** `supabase-service-role-key-launch-72h-2026-08-staging` decodes to `exp=2100841347` (2036-07-28). Cloud Scheduler OIDC tokens are minted per-invocation (no static expiry). No action needed.
4. **Org fixture note:** `org_credits.balance` was 0 for the seeded org (`5eed0000-…-b1`) prior to this session — the very first live loadgen create attempt returned a real `402 insufficient_credits`, then the balance was topped up to 200000 so the VOLUME pillar isn't credit-starved. A separate hardcoded `anchor_quota` gate (`anchorQuotaGate.ts`) was also found capping this org at 10 real anchors regardless of credit balance — raised to 50000. See `loadgen-launch-72h-2026-08.json` `org_fixture_adjustments_made_this_session` for full detail.

_Last refreshed: 2026-07-28 by CTO session (RTE follow-up appended same day) — claims verified against MCP output, live gcloud/curl checks, and `broadcast-recovery.ts` source, not asserted from prior-session prose alone._

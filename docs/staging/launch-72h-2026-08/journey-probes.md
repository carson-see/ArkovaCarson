# Journey probes — launch-72h-2026-08 (mirror of legacy-soak-2026-08/journey-coverage.md)

Source table + methodology: [`legacy-soak-2026-08/journey-coverage.md`](../legacy-soak-2026-08/journey-coverage.md) — same 8-row SS4.3 subsystem table, same 2026-07-28T22:xx RTE two-follow-up session, same `scripts/soak/journey-probes.sh` (PR #1765). This file records the launch-rig-specific evidence where it differs from legacy; rows with identical code paths and results just point back to the legacy doc rather than duplicating prose.

Rig: `launch-72h-2026-08` · Worker: `arkova-worker-launch-72h-2026-08-staging` · Supabase: `nykacscfufdleghzbzhi`.

| Subsystem | Status | Launch-rig-specific evidence |
|---|---|---|
| **worker — auth/tenant boundary** | **PASS (bounded)** | Second org `5eed0000-…-c1` seeded (own `api_keys` row, key_prefix `ak_test_17fb`). Org A's key (`ak_test_042d…`) against org C1's anchor (`ARK-2026-91390B74`) lifecycle → `404 {"error":"Anchor not found"}`. `GET /api/v1/usage` with org A's key correctly scoped to org A only (`used:1`, `keys:[{"key_prefix":"ak_test_042d",...}]`). Same caveats as legacy row (API-key-scoped only, no full JWT cross-org pass, no repo-wide `x-org-id` grep this session). |
| **worker — SECURITY DEFINER RPC family** | **DONE — CRITICAL finding confirmed live (same as legacy)** | Ran the same `aclexplode(proacl)` grant enumeration against `nykacscfufdleghzbzhi`. Identical result pattern: the 6 functions 0377 names are `service_role`-only (guarded); `finalize_public_record_anchor_batch`, both `drain_submitted_to_secured_for_tx` overloads, `bulk_promote_confirmed`, and `archive_old_audit_events` are all still anon+authenticated EXECUTE-granted. Live-confirmed via anonymous PostgREST `POST /rest/v1/rpc/bulk_promote_confirmed` (fake `p_tx_ids`, using the project's legacy anon JWT key) → `HTTP 200`, body `0` (zero rows matched — safe probe, but proves the anon call executes fully, unauthenticated). See legacy doc for the full finding writeup and recommended fix (`services/worker/src/index.ts:377` mount-order bug). |
| **worker — credit/billing fail-open paths** | **PARTIALLY COVERED** | Same code-level review as legacy (identical `services/worker/src/ai/cost-tracker.ts` and `paymentTierRouter.ts` — not rig-specific code). Org fixture `5eed0000-…-c1` seeded at 200,000 balance / 50,000 anchor_quota, same pattern as the original session's org-A top-up; no independent 0-balance live re-test run against org C1 on this rig this session (time-bounded — the legacy rig's original-session evidence for the identical code path was judged sufficient not to duplicate). `allocate_monthly_credits()`/`roll_over_monthly_allocation()` not independently triggered here either. |
| **worker — chain/broadcast/treasury** | **NOT COVERED on this rig this session** | The bounded fault-injection probe (forced-BROADCASTING-null-txid → `recover-broadcasts` → verify `PENDING` recovery) was run on the **legacy rig only**, per task scope ("LEGACY rig only" for this probe). Not duplicated on launch — see legacy doc for the full result. Launch rig's `recover-broadcasts` Cloud Scheduler job continues to run on its normal cadence, unmodified. |
| **frontend — client-side privacy boundary (§1.6)** | **NOT COVERED** | Same as legacy — code-review-only exercise, not rig-specific, not attempted this session. |
| **migrations — RLS + SECURITY DEFINER surface** | **PASS (RLS-enabled check) / PARTIAL (adversarial pass)** | `select count(*), count(*) filter (where relrowsecurity and relforcerowsecurity)` against `nykacscfufdleghzbzhi`: **112/112** `public` tables fully RLS + FORCE RLS enabled, zero exceptions. Adversarial anon PostgREST reads (`anchors`, `api_keys`, `org_credits`, `webhook_endpoints`) all returned `HTTP 200` with `[]` (RLS denying at row level). This is the rig the adversarial pass was actually run against (see legacy doc's note that it wasn't independently re-run there). |
| **edge** (`services/edge/`) | **STILL LARGELY NOT COVERED** | Same shallow prod check as legacy doc (`edge.arkova.ai` is prod's shared edge surface, not rig-specific) — `/health` → 200, root → 404, no reflected CORS origin. Not a substitute for the plan's asked-for enumeration + auth/rate-limit + volume pass. |
| **integrations** (`bullhorn`, `clio`, `zapier`) | **NOT COVERED** | Same as legacy — plan itself de-scopes this to a code-review pass; none run. |

## Load-generation ramp (Task A) — launch-rig-specific numbers

See [`loadgen-launch-72h-2026-08.json`](./loadgen-launch-72h-2026-08.json)'s `2026-07-28T22:xx follow-up` block for the full writeup (identical root-cause finding to legacy — same worker code, same shadow-rate-limiter bug at `services/worker/src/index.ts:377`). Summary:

- Scaled loadgen: cpu 1→2, memory 512Mi→1Gi, min/max-instances 1→3→8, retuned `SUSTAINED_RPS`/`BURST_RPS` 3/9 → 0.9/0.9 once the per-source-IP ceiling was understood.
- **Achieved (worker-verified, clean 5-min window): ~2.63 RPS 2xx sustained**, zero 5xx from loadgen traffic.
- Runbook target (28 RPS sustained / 83 RPS burst) **NOT reached** — structurally blocked by the shadow 60 req/min-per-source-IP limiter described in the legacy doc's finding, not by this rig's own capacity (rig is sized cpu=2/mem=2Gi/max-instances=10, matching prod tier, and was never itself pushed to its limit).
- Zero-5xx confirmed via `gcloud logging read` against `arkova-worker-launch-72h-2026-08-staging`'s own httpRequest logs, excluding the pre-existing unrelated `/jobs/org-queue-scheduler` 500s (present before this session, unrelated to loadgen traffic).

## Legacy smoke-gate cross-reference

Not applicable to this rig — see [`legacy-soak-2026-08/smoke-gate-T0-2h.md`](../legacy-soak-2026-08/smoke-gate-T0-2h.md)'s 2026-07-28T22:2x follow-up for the legacy rig's first-anchor-SECURED closure (txid `60b0b574…f5cc0`, confirmed at block 315206, DB row `status=SECURED`).

_Last refreshed: 2026-07-28 by RTE two-follow-up session — claims verified against live SQL grant introspection, live HTTP probes against the worker, and `gcloud logging read`, not asserted from the legacy rig's results alone._

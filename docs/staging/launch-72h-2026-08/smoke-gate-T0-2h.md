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

_Last refreshed: 2026-07-28 by CTO session — claims verified against MCP output._

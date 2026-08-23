# Anchor traffic — 2026-08-18T043702Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `b12bad22ab55581b…` | 201 | `ARK-2026-05849E25` | accepted |
| 2 | `415606b33fa675a3…` | 201 | `ARK-2026-9ECEF019` | accepted |
| 3 | `6a3beae952723c97…` | 201 | `ARK-2026-4C486980` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 106816s (unchanged by this instrument — it only calls the API).

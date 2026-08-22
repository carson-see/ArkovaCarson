# Anchor traffic — 2026-08-18T003701Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `a0083caeba520dc1…` | 201 | `ARK-2026-1D18C5AE` | accepted |
| 2 | `ab220049deee2e9d…` | 201 | `ARK-2026-B8B7DB64` | accepted |
| 3 | `51c8e73836c4a606…` | 201 | `ARK-2026-568F8A87` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 92416s (unchanged by this instrument — it only calls the API).

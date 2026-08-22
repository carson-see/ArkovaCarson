# Anchor traffic — 2026-08-17T183700Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `ee9df77b8d021b65…` | 201 | `ARK-2026-0603A9DC` | accepted |
| 2 | `5a94ddb441455280…` | 201 | `ARK-2026-F19F8AB3` | accepted |
| 3 | `39d8ad88ac8ff4e0…` | 201 | `ARK-2026-BB44304F` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 70811s (unchanged by this instrument — it only calls the API).

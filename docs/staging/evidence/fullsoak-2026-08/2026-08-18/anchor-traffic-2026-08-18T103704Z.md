# Anchor traffic — 2026-08-18T103704Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `59e0cde36e21748c…` | 201 | `ARK-2026-0746209D` | accepted |
| 2 | `43b8151400d32455…` | 201 | `ARK-2026-99AB9D87` | accepted |
| 3 | `0c1073468242dfaa…` | 201 | `ARK-2026-21EB163C` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 128411s (unchanged by this instrument — it only calls the API).

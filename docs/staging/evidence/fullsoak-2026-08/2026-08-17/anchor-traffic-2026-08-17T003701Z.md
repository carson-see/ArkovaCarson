# Anchor traffic — 2026-08-17T003701Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `bc3570deb31a1f29…` | 201 | `ARK-2026-B47F0D3E` | accepted |
| 2 | `f00dd37eb26c9d6d…` | 201 | `ARK-2026-A8A6F4F4` | accepted |
| 3 | `c7e3c746a06da592…` | 201 | `ARK-2026-8D652FD1` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 6006s (unchanged by this instrument — it only calls the API).

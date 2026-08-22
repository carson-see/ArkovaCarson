# Anchor traffic — 2026-08-17T223714Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `d65611a612c93ca7…` | 201 | `ARK-2026-0918CC83` | accepted |
| 2 | `e01a0126142ae2f4…` | 201 | `ARK-2026-49244D62` | accepted |
| 3 | `77063bfc9f23d493…` | 201 | `ARK-2026-18D3A6CD` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 85328s (unchanged by this instrument — it only calls the API).

# Anchor traffic — 2026-08-17T063705Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `8b331df67741c25b…` | 201 | `ARK-2026-99459D7C` | accepted |
| 2 | `6662d921f4e87a41…` | 201 | `ARK-2026-F252E840` | accepted |
| 3 | `99042192cfe43f53…` | 201 | `ARK-2026-4C4819CD` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 27610s (unchanged by this instrument — it only calls the API).

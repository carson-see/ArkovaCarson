# Anchor traffic — 2026-08-17T143706Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `f66d5d6e7a7011df…` | 201 | `ARK-2026-0D39EC03` | accepted |
| 2 | `f29192e090d0dca7…` | 201 | `ARK-2026-F2B1B9C9` | accepted |
| 3 | `a44890ad759d2c9b…` | 201 | `ARK-2026-66CA5CA2` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 56410s (unchanged by this instrument — it only calls the API).

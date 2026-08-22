# Anchor traffic — 2026-08-16T143700Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `b2dcd180c2553e27…` | 201 | `ARK-2026-0D8191E3` | accepted |
| 2 | `566aa89b0c543c04…` | 201 | `ARK-2026-C1CCFA91` | accepted |
| 3 | `3b81dede05202869…` | 201 | `ARK-2026-D3093205` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 210631s (unchanged by this instrument — it only calls the API).

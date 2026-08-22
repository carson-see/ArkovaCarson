# Anchor traffic — 2026-08-18T023705Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `c3fbabc52c06f7bf…` | 201 | `ARK-2026-52281D36` | accepted |
| 2 | `e78e14f4ddd12ba9…` | 201 | `ARK-2026-A3270D05` | accepted |
| 3 | `cc55798c13101a6b…` | 201 | `ARK-2026-7D311529` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 99622s (unchanged by this instrument — it only calls the API).

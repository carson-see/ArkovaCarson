# Anchor traffic — 2026-08-16T141937Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `ae1ece69b78c78fa…` | 201 | `ARK-2026-BA3C97F0` | accepted |
| 2 | `ed9fa320803f1dab…` | 402 | — | **REJECTED** |

**ANCHOR_TRAFFIC: FAIL** (1 accepted / 1 rejected)

Rig worker uptime at submission: 209584s (unchanged by this instrument — it only calls the API).

# Anchor traffic — 2026-08-17T103702Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `ffcaa33a0744d218…` | 201 | `ARK-2026-4370A80E` | accepted |
| 2 | `80de5a7ca5f9c49a…` | 201 | `ARK-2026-15420CBB` | accepted |
| 3 | `f89db2c61a89f808…` | 201 | `ARK-2026-4840BB76` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 42007s (unchanged by this instrument — it only calls the API).

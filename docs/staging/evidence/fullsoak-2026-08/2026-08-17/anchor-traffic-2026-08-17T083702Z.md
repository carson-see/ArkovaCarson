# Anchor traffic — 2026-08-17T083702Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `4916290b140ca727…` | 201 | `ARK-2026-8EA56BE0` | accepted |
| 2 | `b4a4089fd4c43af1…` | 201 | `ARK-2026-BE94D4AD` | accepted |
| 3 | `c1a11083955105ee…` | 201 | `ARK-2026-09AB8906` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 34808s (unchanged by this instrument — it only calls the API).

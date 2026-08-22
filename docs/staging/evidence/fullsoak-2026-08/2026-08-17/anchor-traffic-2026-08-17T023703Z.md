# Anchor traffic — 2026-08-17T023703Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `31eec3b0a90f46cf…` | 201 | `ARK-2026-766932C3` | accepted |
| 2 | `aae966b55623c3b2…` | 201 | `ARK-2026-4C16D919` | accepted |
| 3 | `c634f69ea1e1fe0f…` | 201 | `ARK-2026-1F233788` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 13208s (unchanged by this instrument — it only calls the API).

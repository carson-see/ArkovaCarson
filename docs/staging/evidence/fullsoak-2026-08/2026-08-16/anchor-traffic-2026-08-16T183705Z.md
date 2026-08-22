# Anchor traffic — 2026-08-16T183705Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `6f0051ea9d2dbf91…` | 429 | — | **REJECTED** |
| 2 | `99f3e1084d499877…` | 429 | — | **REJECTED** |
| 3 | `e2135fed8ab64587…` | 429 | — | **REJECTED** |

**ANCHOR_TRAFFIC: FAIL** (0 accepted / 3 rejected)

Rig worker uptime at submission: 225035s (unchanged by this instrument — it only calls the API).

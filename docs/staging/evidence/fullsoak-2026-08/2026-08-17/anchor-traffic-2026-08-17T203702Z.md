# Anchor traffic — 2026-08-17T203702Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `7b98cf891944d2b5…` | 201 | `ARK-2026-FCC03592` | accepted |
| 2 | `57265046af6bc104…` | 201 | `ARK-2026-073F3C1D` | accepted |
| 3 | `e00753193b7ecf5d…` | 201 | `ARK-2026-D489BFDB` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 78012s (unchanged by this instrument — it only calls the API).

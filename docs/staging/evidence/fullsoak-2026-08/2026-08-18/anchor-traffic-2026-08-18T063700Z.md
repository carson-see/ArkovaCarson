# Anchor traffic — 2026-08-18T063700Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `99bba130f1dd06df…` | 201 | `ARK-2026-A23E4652` | accepted |
| 2 | `84952258d9b88408…` | 201 | `ARK-2026-9346A5D6` | accepted |
| 3 | `4fe49b078ce536fe…` | 201 | `ARK-2026-622DC8AC` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 114009s (unchanged by this instrument — it only calls the API).

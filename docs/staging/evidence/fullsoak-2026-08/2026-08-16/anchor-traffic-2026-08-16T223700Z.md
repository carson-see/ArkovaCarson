# Anchor traffic — 2026-08-16T223700Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `fc53a098d93dc042…` | 429 | — | **REJECTED** |
| 2 | `be2ddb7f677d468a…` | 429 | — | **REJECTED** |
| 3 | `a7832e4715e77159…` | 429 | — | **REJECTED** |

**ANCHOR_TRAFFIC: FAIL** (0 accepted / 3 rejected)

Rig worker uptime at submission: 239430s (unchanged by this instrument — it only calls the API).

# Anchor traffic — 2026-08-18T083700Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `a82f3ab34223c4ac…` | 201 | `ARK-2026-36424EC3` | accepted |
| 2 | `f4ab9632c47c1a66…` | 201 | `ARK-2026-B96E2E8C` | accepted |
| 3 | `2d4f94f926d9c2a5…` | 201 | `ARK-2026-0A1A23A1` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 121207s (unchanged by this instrument — it only calls the API).

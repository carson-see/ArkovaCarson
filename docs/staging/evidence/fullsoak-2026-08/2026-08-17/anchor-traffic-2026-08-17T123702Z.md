# Anchor traffic — 2026-08-17T123702Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `630b53d10c2ecc79…` | 201 | `ARK-2026-37791C9D` | accepted |
| 2 | `11248530ef860dbe…` | 201 | `ARK-2026-774FDC06` | accepted |
| 3 | `d8d954b672cbdbbf…` | 201 | `ARK-2026-6E0433F9` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 49209s (unchanged by this instrument — it only calls the API).

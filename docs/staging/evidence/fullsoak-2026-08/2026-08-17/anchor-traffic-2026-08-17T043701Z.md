# Anchor traffic — 2026-08-17T043701Z

Window 2026-08-12T15:51:30Z → 2026-08-19T15:51:30Z. **Traffic generation began 2026-08-16 (Day 4).**
Days 0–3 of this window carry NO anchor throughput evidence — see the provenance rule
in this script's header. Do not describe throughput as covering the full 7 days.

Submitted via the real product API (`POST /api/v1/anchor`, API-key auth,
`anchor:write` scope). No direct DB writes; no status set by this instrument.
PENDING → batch → broadcast → SECURED is driven by the rig's own bound cron.

| # | fingerprint | HTTP | public_id | result |
|---|---|---|---|---|
| 1 | `d2a11dca235997b7…` | 201 | `ARK-2026-744C343E` | accepted |
| 2 | `023e800edb9eb8d7…` | 201 | `ARK-2026-BF3C8670` | accepted |
| 3 | `6205d5dc68823606…` | 201 | `ARK-2026-C9D726BD` | accepted |

**ANCHOR_TRAFFIC: PASS** (3 accepted / 0 rejected)

Rig worker uptime at submission: 20407s (unchanged by this instrument — it only calls the API).

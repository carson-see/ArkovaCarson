# Anchor traffic generation — begins Day 4 (2026-08-16)

**Read this before citing any throughput number from this soak.**

## The finding that caused it

The daily probe suite was deliberately built non-destructive, so it never created anchors.
Anchor creation therefore happened **only on Day 0**. Verified 2026-08-16:

| Observation | Value |
|---|---|
| Anchors on the rig | 12 |
| Created since clock start (2026-08-12T15:51:30Z) | **0** |
| `checks.anchoring.lastSecuredAt` | 2026-08-12T14:11:51Z — **before** the window opened |
| Daily-parity assertion A16c (lastSecuredAt advancing) | correctly **FAILING** |

For Days 0–3 the rig was proving a system **at rest**: availability, configuration
stability and control operation, on a pipeline with nothing flowing through it.
A16c was not a broken assertion. It was the only thing reporting the truth.

## Provenance rule — DO NOT BACKDATE

Traffic generation starts **Day 4 (2026-08-16)**. The evidence pack must say
**"continuous anchor traffic from Day 4 onward"** and must never describe throughput
as covering the 7-day window. Days 0–3 carry no throughput evidence and no amount of
Day 4–6 volume changes that. The chain lifecycle *was* proven end-to-end on Day 0
(12/12 SECURED, 12/12 `anchor_proofs.block_header` at 80 raw bytes, verified against an
independent RPC node plus two explorers) — and then went idle. Both facts stand.

## The instrument

`scripts/staging/fullsoak-anchor-traffic.sh`, LaunchAgent `ai.arkova.soak.anchor-traffic`,
every 2 hours at :37, 3 anchors per run.

Submissions go through the **real product API** — `POST /api/v1/anchor`, API-key auth,
`anchor:write` scope — the same path a customer uses. The instrument does **not** write
to `anchors` directly, does **not** set status, and does **not** touch the chain client.
`PENDING → batch → broadcast → SECURED` is driven entirely by the rig's own bound
schedulers (`batch-anchors` and `process-anchors` and `check-confirmations`, all `*/30`,
all verified ENABLED and firing), which is precisely the pipeline under test.

It never mutates existing rows, never deletes, and never changes rig config, env or
revision — **the soak clock (worker uptime) is untouched**. It self-limits to a no-op
once the window closes. Credentials reach curl through a mode-0600 `--config` file,
never argv.

## A control fired during setup — record it as evidence, not as a problem

The second submission returned **HTTP 402 `quota_exhausted`**:

> `This sandbox org has used all 10 of its allotted anchors. Contact Arkova for a top-up.`
> `"used": 10, "quota": 10`

That is `ensureAnchorQuotaAvailable` (SCRUM-1740, migration 0297) working exactly as
specified: sandbox orgs (`org_credits.is_test = true AND anchor_quota IS NOT NULL`) are
hard-capped on lifetime non-deleted anchors. **This is the first operating-effectiveness
evidence the anchor quota gate has ever had.** It was proven by hitting it, in production
code, on the real API path — not by reading the source.

**Change made, and it is a change:** to give the remaining ~3.3 days headroom, both rig
orgs had `org_credits.anchor_quota` raised 10 → 5000 on 2026-08-16.

- This is a **data** change to the rig database, not a configuration change. The frozen
  worker revision `arkova-worker-fullsoak-2026-08-staging-00013-mrw`, its image digest,
  its env and its git_sha are untouched; uptime did not reset.
- The gate remains **armed** — 5000 is a finite cap, not `NULL`. The control is still
  enforceable and still provable.
- Anyone auditing throughput after 2026-08-16 must know the cap was raised. It is stated
  here rather than left for a reader to discover in a diff.

## What this evidences, and what it does not

**Measured:** submission acceptance through the real API; the quota control refusing
traffic at its cap; anchor rows created and entering the drain path from Day 4 onward.

**Asserted:** that Day 4–6 throughput is representative of the pipeline's steady-state
behavior, on the grounds that cadence and code are prod-parity.

**NOT asserted:** that the 7-day window carries continuous anchor throughput. It does
not. Days 0–3 are availability-and-controls evidence only, and any report implying
otherwise is wrong.

# S0-E6 — Infra & SSD Hygiene (READ-ONLY inventory + proposal)

> **Sprint-0 deliverable S0-E6 / Story 6.1.** Status: **INVENTORY COMPLETE — no destructive action taken. All teardown/prune/delete is GATED to Carson.**
> Verified 2026-06-17 via `gcloud run services list` + `gcloud ai endpoints list` (project `arkova1`), Supabase MCP `list_projects`, and `df -h`. Active soaks were identified from HANDOFF and left **untouched**.

## Headline: steady-state is already clean. No deletes needed this session.

The prior-session sprawl (PR-1052/1055/1056/967 Cloud Run rigs; 5 duplicate Vertex fraud-v1 endpoints; `arkova-migration-soak` Supabase project) is **already gone**. One paid orphan Supabase project remains → flagged below.

## 1. Cloud Run (`arkova1`, us-central1) — 4 services, ZERO teardown candidates

| Service | Last deployed | Classification | Action |
|---|---|---|---|
| `arkova-worker` | 2026-06-16 | **PROD** | none |
| `arkova-worker-staging` | 2026-06-15 | **ACTIVE SOAK** — Train C #1154 rides this via tag `train-c-1154-cfaee18e` | **DO NOT TOUCH** (HANDOFF: a shared-service env rewrite killed the CE soak 06-13) |
| `arkova-worker-train-d-proof-staging` | 2026-06-15 | **ACTIVE** — Train D proof rig | DO NOT TOUCH |
| `arkova-worker-train-d-queue-staging` | 2026-06-15 | **ACTIVE** — Train D queue/credit rig | DO NOT TOUCH |

The old merged-PR rigs from the 2026-06-05 HANDOFF entry are no longer present → nothing to tear down. The S0-E4 isolated-rig **automation** (RTE/RelMgr epic, not this report) is what prevents future sprawl.

## 2. Vertex AI endpoints (`arkova1`, us-central1) — 1 endpoint, AT TARGET

| Endpoint ID | Display name | Action |
|---|---|---|
| `8811908947217743872` | `arkova-golden-v5-reasoning-pro-20260415` | keep (Gemini-Golden; gated per GEMB2) |

The 5 duplicate `arkova-gemini-fraud-v1` endpoints flagged 2026-06-05 are **gone**. Vertex is within the §7 1–2 steady-state target. *Caveat:* only `us-central1` enumerated; if any tuning ran in another region, sweep there too (none expected — golden is us-central1).

## 3. Supabase projects — 8 total; 1 paid orphan to flag

| Ref | Name | Classification | Action |
|---|---|---|---|
| `vzwyaatejekddvltxyye` | carson-see's Project | **PROD** | none |
| `ujtlwnoqfhtitcmsnrpq` | arkova-staging | **shared staging** (active) | none — do not mutate |
| `bwkskvbmcjodwxklpzyl` | arkova-train-c-t3-rc-20260612 | **Train C #1154 isolated soak** | **DO NOT TOUCH** |
| `ykbkueelkxngyrwkutxt` | arkova-train-d-proof-20260615 | **Train D rig** (active) | DO NOT TOUCH |
| `bkstqckfldajpaehveaa` | arkova-train-d-queue-20260615 | **Train D rig** (active) | DO NOT TOUCH |
| `xrefmwydaatppieoxfxn` | **arkova-pr-1055-exact-head-project** | **ORPHAN** — PR #1055 merged 2026-06-10T23:35Z; exact-head rig no longer needed | **⚠ FLAG CARSON: delete/downgrade via dashboard** (paid ~$10/mo; MCP `pause_project` needs free-tier downgrade first — can't auto-pause) |
| `urcfkogluhrjshscrevb` | cacti-technologies | **non-Arkova** (different product, same org) | leave alone |
| ~~`kihdcwoturustgpzyflj`~~ | ~~arkova-migration-soak~~ | already removed since 2026-06-05 | n/a |

## 4. SSDs

| Volume | Capacity | Used | Free | Note |
|---|---|---|---|---|
| `/Volumes/Extreme` | 931 GiB | 205 GiB | **726 GiB (23%)** | healthy — no action |
| internal `Data` (disk3s5) | 228 GiB | 117 GiB | 59 GiB (67%) | big levers = Docker.raw / Claude vm_bundles / LM Studio model — **deferred to Carson** (live apps / user data) |
| Crucial SSD | — | — | — | **not mounted** — cannot inventory this session |

Regenerable-cache reclaim (npm/uv/pip/brew/gcloud-logs) is low-urgency given Extreme has 726 GiB free; deferred unless Carson wants it. **No deletes performed.**

## Proposal (all gated to Carson)

1. **Delete or downgrade** the orphaned `arkova-pr-1055-exact-head-project` (`xrefmwydaatppieoxfxn`) — PR #1055 is merged; dashboard action (paid project).
2. Cloud Run + Vertex: **no action** — already at steady-state targets.
3. SSD: optional regenerable-cache reclaim; Docker.raw/vm_bundles/LM-Studio remain Carson's call. Mount the Crucial SSD if you want it inventoried.
4. The durable fix for rig sprawl is the **S0-E4 isolated-rig provision/teardown automation** (RTE/RelMgr/DBA epic), not manual sweeps.

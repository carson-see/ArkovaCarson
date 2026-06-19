# ARKOVA PI-1 · Sprint 0 · Lane 3 (Credential Network & Intelligence)

**Date:** 2026-06-19 · **Branch:** `lane3/s0-ce-custody-bq-design` (isolated worktree, base `origin/main` `f3f72767`) · **Tier:** T0 (docs/design/audit) with a **T2 carve-out to Carson** (the live CE secret move + IAM, and the CE partner email).
**Milestone:** Sprint 0 — Foundation & Hardening (GitHub #24).
**Guardrails honored:** nothing merged; no prod/staging/Supabase/soak/Cloud Run mutation; **no existing PR or branch touched** (Train C #1154, Train D rigs, #1208/#1211/#1213, every open PR — hands-off); CE key value never read/logged; isolated worktree.

## What this is
The Lane-3 slice of Sprint 0 — the last open lane (Lane 1 + Lane 2 done). Sprint 0 **pauses feature delivery**: this is **design + custody-kickoff + read-audit + onboarding**, not a build. Three read-only specialist streams produced the designs; the lane lead synthesized + filed.

## Deliverables
| # | Doc | Story | Tier |
|---|---|---|---|
| 00 | [Ceremonies](00-ceremonies.md) — refinement / planning / **pre-mortem** / (review+retro at close) | — | T0 |
| 01 | [CE key → Secret Manager custody + rotation design](01-ce-key-custody-design.md) | S0-7.2 (↔ epic SCRUM-1867) | T0 design / **T2 execute = Carson** |
| 02 | [BigQuery / analytics design](02-bigquery-analytics-design.md) | ↔ SCRUM-1062 (GCP-MAX-02) | T0 |
| 03 | [Partnership-history audit (CE / CPE-CLE / Haki)](03-partnership-history-audit.md) | supports S0-E2 (↔ SCRUM-2517) | T0 |
| 04 | [CE permanent-key + sandbox request — DRAFT](04-ce-permanent-key-request-DRAFT.md) | S0-7.2 | **Carson sends** |

## Definition-of-Done scorecard (Lane 3)
| Item | Status |
|---|---|
| CE key custody + rotation **designed** (named owner, SM layout, drafted gcloud runbook, KEY-EXPIRY inventory row, Lane-1 handoff) | **DONE** (design) |
| CE key **moved** to Secret Manager + IAM bound | **Carson-gated (T2)** — drafted commands in doc 01 §4 |
| Permanent key + sandbox **requested** from CE | **DRAFTED** (doc 04) — **Carson sends** |
| Claims-review (no premature "listed in the Registry") | **DONE** — flags in doc 03; "approved to publish" ≠ "publishing live" ≠ "listed" |
| BigQuery / analytics design | **DONE** (extends shipped SCRUM-1062, not greenfield) |
| CE/CPE/CLE/Haki history → S0-E2 current note | **DONE** (doc 03) + external-gate tracker rows |
| Onboarding (read list, bootstrap-ack, first T0 PR) | **DONE** |
| Confluence current | **DONE** (S0-7.2 page + partnership note — see PR description) |
| Jira transitioned + subtasks | **Needs Human** — design/audit complete; T2 custody execution + CE send + PR merge are Carson-gated |
| agents.md updated | **DONE** (`docs/sprint-0/lane3/agents.md` — no code folder was modified this sprint) |
| HANDOFF updated | **Paste-ready** — held out of this PR to avoid a merge collision (Mergify playbook); lands post-merge |
| Reviewed + merged | **Carson merges** |

## Carson-gated (pre-mortem PM-2/PM-4 — I designed/drafted, you execute)
1. **Execute the CE secret → Secret Manager move + per-secret IAM** — exact `gcloud` runbook in [doc 01 §4](01-ce-key-custody-design.md). T2, live secret write.
2. **Send the CE permanent-key/sandbox request** to Jeanne Kitchens (cc Jeff Grann) — [doc 04](04-ce-permanent-key-request-DRAFT.md). The **~2026-09-09** trial cliff (R-1, FATAL) is the clock.
3. **Confirm** the exact trial-expiry date + whether the existing `Credential_Engine` secret holds the trial or a permanent key.

## Corrected Jira map (per-key verified — the kickoff brief had two wrong)
- **CE/CTDL:** epic **SCRUM-1867** (In Progress). S0-7.2 = this slice.
- **BigQuery:** **SCRUM-1062** (GCP-MAX-02) is the live track; epic **SCRUM-1042** is a flagged duplicate of **SCRUM-1034** (Done).
- **HakiChain:** launch surface = **SCRUM-1703** [API/MCP-LAUNCH]; **SCRUM-1010 is CIBA** (batch anchoring), parents the HAKI-REQ stories. (Brief wrongly equated 1010 = HakiChain.)
- **CPE/CLE:** epics **SCRUM-1845** + **SCRUM-1865** (both In Progress); **1962/1963 are eval-gate *stories*** (CPE-eval Done, CLE-eval Needs Human). (Brief wrongly named 1962/1963 as the epics.)

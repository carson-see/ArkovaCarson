# docs/sprint-0/lane3 — agents.md

Lane 3 (Credential Network & Intelligence) Sprint-0 deliverables. **T0 design/audit only — no code/migration/CLAUDE.md/database.types.ts touched.** See [README.md](README.md) for the index + DoD scorecard.

## What's here
- `00-ceremonies.md` — refinement / planning / pre-mortem / review+retro
- `01-ce-key-custody-design.md` — S0-7.2 (↔ epic SCRUM-1867); the **T2 secret move + IAM is Carson-gated** (drafted gcloud runbook in §4)
- `02-bigquery-analytics-design.md` — extends the shipped SCRUM-1062 subsystem (not greenfield)
- `03-partnership-history-audit.md` — S0-E2 support; CE/CPE/CLE/Haki current-state + claims-review + external-gate rows
- `04-ce-permanent-key-request-DRAFT.md` — **Carson sends** (outward partner email)
- `README.md` — index + DoD scorecard

## Guardrails honored
Read-only on all infra + every existing PR/branch (Train C #1154, Train D rigs, #1208/#1211/#1213 untouched); no prod/staging/Supabase/Cloud Run/soak mutation; **CE key value never read/logged**; CE Secret-Manager/IAM cross-cutting work routed to **Lane 1 via handoff** (doc 01 §6), not edited.

## Tracking
Jira: **SCRUM-2542** (Needs Human) + subtasks 2543/2544 (Done), 2545 (review/retro), 2546 (Carson-gated close-out). Confluence: **85393410** (under Sprint-0 AUDIT 83689473). Related: SCRUM-1867 (CE) · 1062 (BigQuery) · 1703 (HakiChain) · 2523 (external-gate tracker) · 2536 (dead rotation reminder, confirmed).

# HANDOFF.md — Arkova Living State Snapshot

> **Purpose:** Current state of the project. Updated at the end of every session. Kept ≤150 lines — anything older goes to git log or the archive.
>
> **Source-of-truth layering (2026-04-21):**
> - **Jira** = story status, scope, acceptance criteria → https://arkova.atlassian.net/jira/software/projects/SCRUM
> - **Confluence** (space "A") = topic docs + per-epic audit pages → https://arkova.atlassian.net/wiki/spaces/A
> - **Bug tracker** (Google Sheet) → https://docs.google.com/spreadsheets/d/1mOReOXL7cmBNDD77TKVKF3LsdQ3mEcmDbgs5q_pTEk4
> - **HANDOFF.md** (this file) = rolling snapshot of *now*, not history
> - **CLAUDE.md** = directive / rules
> - **git log** = what changed, by whom, when

---

## Now

**Branch:** `claude/2026-04-21-sarah-sprint-1-batch1`
**Network:** Bitcoin MAINNET. 1.41M+ SECURED anchors. 0 PENDING (as of last known drain, 2026-04-09).
**Worker:** Cloud Run `arkova-worker-270018525501.us-central1.run.app` — 1GiB, max 3, KMS signing, batch 10K. Revision drifts session-to-session; check `gcloud run services describe arkova-worker` for the live revision.
**Frontend:** `arkova-26.vercel.app`, auto-deploys from main.
**DB:** Supabase `vzwyaatejekddvltxyye`. 212 migrations, prod synced through 0221 as of 2026-04-20. `idx_brin_anchors_created` deferred to a maintenance window (existing btree covers the workload).
**Tests:** 4,552+ green (1,321 frontend + 3,208 worker + 23 sanitizer as of 2026-04-21).

---

## Open, current

Status lives in Jira. Current elevated priorities:

- **[SCRUM-713](https://arkova.atlassian.net/browse/SCRUM-713) INTL** — reopened 2026-04-21; 15 children filed (SCRUM-969..991), 6 retroactive for shipped work, 3 depth, 4 Tier 3, 2 defer decisions.
- **[SCRUM-550](https://arkova.atlassian.net/browse/SCRUM-550) DEP** — reopened 2026-04-21; 4/23 + 9 new DEP-11..19 (SCRUM-1001..1009) expansion stories.
- **[SCRUM-551](https://arkova.atlassian.net/browse/SCRUM-551) REG** — reopened 2026-04-21; 0/28 complete. Children SCRUM-561..589 existed all along; 14 Confluence backfill pages created 2026-04-21.
- **[SCRUM-827](https://arkova.atlassian.net/browse/SCRUM-827) GME7**, **[SCRUM-828](https://arkova.atlassian.net/browse/SCRUM-828) GME8**, **[SCRUM-918](https://arkova.atlassian.net/browse/SCRUM-918) MCP-SEC** — transitioned To Do → In Progress on 2026-04-21 to match reality.
- **[SCRUM-1000](https://arkova.atlassian.net/browse/SCRUM-1000) AUDIT-FU** — story-level Confluence backfill sprint. Estimated 250+ pages remaining.
- External follow-ups: [SCRUM-888](https://arkova.atlassian.net/browse/SCRUM-888) Colombia SIC · [SCRUM-889](https://arkova.atlassian.net/browse/SCRUM-889) Thailand counsel · [SCRUM-890](https://arkova.atlassian.net/browse/SCRUM-890) Malaysia counsel · [SCRUM-891](https://arkova.atlassian.net/browse/SCRUM-891) IASME · [SCRUM-892](https://arkova.atlassian.net/browse/SCRUM-892) NPH-16 deploy · [SCRUM-893](https://arkova.atlassian.net/browse/SCRUM-893) NCA engineering bundle.
- NVI gate (epic [SCRUM-804](https://arkova.atlassian.net/browse/SCRUM-804)) = active. NDD/NSS/NTF paused.

---

## What just shipped (latest commits on this branch)

```
2e6f4c2c refactor(docs-soot): trim CLAUDE.md 756→222 lines + banner BACKLOG.md
f7d0bf20 refactor(docs-soot): Jira + Confluence become canonical source of truth
20655cd2 refactor(sarah-sprint-1): simplify pass on PR #464
15c94be1 feat(sarah-sprint-1): SCRUM-727 EDGAR Form ADV + SCRUM-984/985/987 MCP-SEC + SCRUM-959 SOC 2 cadence
```

Full history: `git log --oneline`. Don't maintain a session-by-session narrative here — git preserves it.

---

## 2026-04-21 Audit outcomes (one-time)

- 67 SCRUM epics audited.
- 3 epics reopened from false-Done (SCRUM-713, 550, 551).
- 3 epics transitioned from stale To Do → In Progress (827, 828, 918).
- 3 duplicate epics closed + linked (389→388, 391→390, 651→612).
- SCRUM-708 re-parented KAU → NPH.
- ~150 Confluence pages created (15 INTL + 67 epic audits + 24 architecture + 9 DEP + 14 REG + ~20 partial story pages).
- `docs/confluence/*.md` (24 files) mirrored to Confluence + deleted from repo.
- `docs/reference/ENV.md` extracted from CLAUDE.md.
- CLAUDE.md 756 → 222 lines. docs/BACKLOG.md 1,152 → 16 lines (banner only).
- 4 macOS Finder duplicate story docs deleted.

Story-level Confluence backfill incomplete — see SCRUM-1000.

---

## Decision Log (durable)

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-21 | Jira + Confluence are the canonical sources of truth | Repeated drift between CLAUDE.md / BACKLOG.md / Jira made auditor + stakeholder view unreliable. `.md` files demoted to engineering notes. |
| 2026-04-16 | Vertex endpoint hygiene mandate | Idle intermediate-checkpoint endpoints were silently billing. Target 1–2 deployed; always audit before/after tuning. |
| 2026-04-16 | NVI gate active for Nessie | FCRA/HIPAA/FERPA training data not verified against authoritative primary sources. Pause NDD/NSS/NTF until NVI passes. |
| 2026-04-15 | Nessie strategy reset | v5 "87.2% F1" headline was measured against a non-serverless model. Narrow extraction per LoRA; deploy-proof before training. |
| 2026-03-22 | Pipeline anchoring creates individual anchors per document | Each document must appear in Treasury — batch-only is insufficient. |
| 2026-03-22 | VITE_CRON_SECRET exposed to browser (admin-only pages) | Pipeline controls need auth; page gated to platform admins. |
| 2026-03-14 | IAIProvider as single abstraction for all AI providers | Vendor independence. |
| 2026-03-14 | MCP server uses Streamable HTTP transport | Native Cloudflare Workers compat. |

---

## Archive pointers

- Pre-2026-04-21 HANDOFF.md content (session-by-session narrative, old blocker tables, resolved bugs): git history preserves it.
- `docs/archive/session-log.md` — older session notes if referenced.
- `ARCHIVE_memory.md` — pre-HANDOFF state file.
- `docs/BACKLOG.md` — historical banner only, points at Jira.

_Last refreshed: 2026-04-21 (post-audit). Keep this file ≤150 lines. If it grows past that, trim — git log carries the history._

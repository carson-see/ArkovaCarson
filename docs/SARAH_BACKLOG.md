# Sarah's Backlog

**Last verified:** 2026-04-20 (against live Jira, not CLAUDE.md Section 5 which is stale — nearly every item listed in §5 as "not started" is actually already Done)
**Jira release:** [Sarah Sprint 1](https://arkova.atlassian.net/projects/SCRUM/versions/10200) (fixVersion = "Sarah Sprint 1")
**Scope rule:** Existing Jira stories and bugs only — no new epics, no Nessie (NPH/NTF/NDD/NSS/NVI/NMT/KAU), no Gemini Golden (GME/GME2–GME11).

## Before you start any task

1. Read `CLAUDE.md` (top-of-file note for you, plus the full Constitution — Section 1).
2. Read `docs/BACKLOG.md` + live Jira to confirm the ticket is still open and nothing has changed. **Do not trust CLAUDE.md Section 5 in isolation — verify each story against live Jira before assuming it's open.**
3. Read `HANDOFF.md` for current state + blockers.
4. Read the Jira ticket itself and scan its comments for context.
5. Read `agents.md` in every folder you plan to touch.
6. **Commit to a branch; open a PR; stop.** Do not merge. Do not push to `main`.

## Reality check — what's actually open for Sarah

Most of the open Arkova backlog right now is Nessie / Gemini Golden training work, which is out of your scope. What's left that's engineering-feasible + not blocked on external procurement is a *short* list.

### Priority 1 — Primary ticket (start here)

| Jira | Title | Why it's Sarah-ready | Notes |
|------|-------|----------------------|-------|
| [SCRUM-727](https://arkova.atlassian.net/browse/SCRUM-727) | [NPH-15] SEC IAPD alternative data source | The pure parser already shipped in [PR #459](https://github.com/carson-see/ArkovaCarson/pull/459). Remaining: thin EDGAR fetcher (~120 LOC) + cron wiring + record anchoring. Fully scoped, tested parser is waiting. | Requires EDGAR User-Agent env var + 10 req/sec rate limit. See `services/worker/src/jobs/edgarFormAdvParser.ts` + `edgarFetcher.ts` for the pattern. |

### Priority 2 — Follow-on work from open PRs (pending Carson's merge)

Once Carson merges the six open PRs from 2026-04-20, several Jira follow-ups fall out that Sarah can pick up:

- After [PR #461](https://github.com/carson-see/ArkovaCarson/pull/461) merges: the Sarah note is live in CLAUDE.md — start there.
- After [PR #459](https://github.com/carson-see/ArkovaCarson/pull/459) / [PR #460](https://github.com/carson-see/ArkovaCarson/pull/460) merge: Carson publishes video #1 → SCRUM-478 closes via one-line entry to `src/lib/geo/videos.ts`.
- After [PR #458](https://github.com/carson-see/ArkovaCarson/pull/458) merges: edge worker redeploy (`wrangler deploy`) — but Claude cannot touch the running worker per `feedback_worker_hands_off`. Flag to Carson.

### Priority 3 — Bugs surfaced in future UAT

There are **zero open bugs** in Jira right now (verified 2026-04-20 via `statusCategory!=Done AND issuetype=Bug`). When Carson runs the next UAT click-through, bugs that surface will land in `docs/bugs/bug_log.md` + the [Bug Tracker Spreadsheet](https://docs.google.com/spreadsheets/d/1mOReOXL7cmBNDD77TKVKF3LsdQ3mEcmDbgs5q_pTEk4). Watch both for new rows.

### Priority 4 — Dependabot PRs as they open

Every time dependabot opens a chore PR, that's Sarah-ready (typecheck + test + upgrade the lockfile). Current state: 0 open dependabot PRs (all 2026-04-20 bumps already merged).

## Not on this list (and why)

- **Any Nessie work** (NPH-*, NTF-*, NDD-*, NSS-*, NVI-*, NMT-*, KAU-*) — NVI-gated, AI platform track.
- **Any Gemini Golden work** (GME-*, GME2 through GME11 — currently 20+ open tickets in this range) — needs Vertex access + training budget + dataset curation; not Sarah's track.
- **External procurement** (pentest vendor SCRUM-517, SOC 2 auditor SCRUM-522, Kenya ODPC filing SCRUM-576/577, GEO marketing launches SCRUM-477/478/479) — blocked on Carson/Matthew's external action, not ship-ready for an engineer.
- **Worker deploy** (SCRUM-892 NPH-16-OPS) — per `feedback_worker_hands_off`, Claude cannot touch the running Cloud Run worker; Carson executes the gcloud commands.

## Working rhythm

1. Pick the top unblocked ticket (today: SCRUM-727 if you have an engineering session).
2. Read the ticket + scan comments + scan linked PRs.
3. Branch: `claude/YYYY-MM-DD-<short-slug>`.
4. Write tests first (TDD MANDATE per CLAUDE.md §0).
5. Open a PR; link the Jira ticket; post a memo comment on the ticket.
6. **Stop.** Do not merge.
7. Repeat.

## When to add to this backlog

Only add items that:
- Are already filed as Jira stories or bugs **and verified open in live Jira**, AND
- Do not touch Nessie or Gemini Golden, AND
- Have engineering deliverables that can ship in a single PR (no XL tasks that span multiple Jira tickets).

Add by editing this file, never by amending an in-flight PR. The Jira `Sarah Sprint 1` release (fixVersion on tickets; label `sarah` + `sarah-sprint-1`) is the single source of truth — this doc is its companion.

## Why this backlog is short

CLAUDE.md Section 5 (the big story-status table) is structurally stale — it lists ~100 items as "not started" or "partial" but when queried against live Jira, the vast majority are already Done. An audit on 2026-04-20 found that all 34 tickets the first draft of this doc listed were already Done in Jira. The remaining genuinely-open-and-engineering-feasible work outside Nessie/Gemini is thin — mostly the SCRUM-727 fetcher and whatever UAT surfaces next.

When Sarah clears SCRUM-727, the next move is to ask Carson to run a UAT click-through (he has the pattern from 2026-04-19) to surface whatever's newly broken — that's where the next round of Sarah-ready work will come from.

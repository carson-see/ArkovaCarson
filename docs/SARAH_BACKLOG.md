# Sarah's Backlog

**Last verified:** 2026-04-21 (against live Jira, after the 2026-04-21 epic hygiene audit filled in 23 missing child stories — see `docs/jira-epic-audit-2026-04-21.md`)
**Jira release:** [Sarah Sprint 1](https://arkova.atlassian.net/projects/SCRUM/versions/10200) (fixVersion = "Sarah Sprint 1" — 19 tickets)
**Scope rule:** Existing Jira stories and bugs only — no new epics, no Nessie (NPH/NTF/NDD/NSS/NVI/NMT/KAU), no Gemini Golden (GME/GME3–GME11). MCP-SEC + TRUST compliance tickets are in scope — they're infrastructure/compliance work, not AI training.

## Before you start any task

1. Read `CLAUDE.md` (top-of-file note for you, plus the full Constitution — Section 1).
2. Read `docs/BACKLOG.md` + live Jira to confirm the ticket is still open and nothing has changed. **Do not trust CLAUDE.md Section 5 in isolation — verify each story against live Jira before assuming it's open.**
3. Read `HANDOFF.md` for current state + blockers.
4. Read the Jira ticket itself and scan its comments for context.
5. Read `agents.md` in every folder you plan to touch.
6. **Commit to a branch; open a PR; stop.** Do not merge. Do not push to `main`.

## Sarah Sprint 1 — 19 tickets

### Priority 1 — Engineering (start here)

| Jira | Title | Effort | Notes |
|------|-------|--------|-------|
| [SCRUM-727](https://arkova.atlassian.net/browse/SCRUM-727) | [NPH-15] SEC IAPD alternative — EDGAR Form ADV fetcher | M | Pure parser already shipped in [PR #459](https://github.com/carson-see/ArkovaCarson/pull/459); remaining is a thin fetcher (~120 LOC) + cron wiring + record anchoring. Fully scoped. |
| [SCRUM-984](https://arkova.atlassian.net/browse/SCRUM-984) | [MCP-SEC-07] Tool-argument Zod validation on every MCP tool invocation | M | Schema-per-tool registry + validator in `services/edge/src/`. Reject malformed input at the boundary. |
| [SCRUM-985](https://arkova.atlassian.net/browse/SCRUM-985) | [MCP-SEC-08] IP allowlist + Cloudflare bot-management for MCP endpoint | M | Cloudflare Worker + KV-stored allowlist per API key. |
| [SCRUM-987](https://arkova.atlassian.net/browse/SCRUM-987) | [MCP-SEC-09] Anomaly detection + Sentry alerting on MCP patterns | M | Rolling-window heuristics; Sentry events on rapid tool-name cycling, cross-tenant access, auth failures. |

### Priority 2 — TRUST compliance + procurement (15 tickets)

Mostly doc-heavy + procurement work. Each ticket has a clear external owner but Sarah can drive the engineering side (evidence-collection cadence, dashboards, certification tracker, etc.).

| Jira | Title | Quarter |
|------|-------|---------|
| [SCRUM-959 TRUST-01](https://arkova.atlassian.net/browse/SCRUM-959) | SOC 2 Type II observation window — 6-month evidence collection | Q1 |
| [SCRUM-960 TRUST-02](https://arkova.atlassian.net/browse/SCRUM-960) | CSA STAR Level 1 self-assessment submission | Q1 |
| [SCRUM-961 TRUST-03](https://arkova.atlassian.net/browse/SCRUM-961) | Cyber insurance policy binding — $3M–$5M coverage | Q1 |
| [SCRUM-962 TRUST-04](https://arkova.atlassian.net/browse/SCRUM-962) | CREST-accredited penetration test | Q1 |
| [SCRUM-963 TRUST-05](https://arkova.atlassian.net/browse/SCRUM-963) | EU-US DPF certification | Q1 |
| [SCRUM-964 TRUST-06](https://arkova.atlassian.net/browse/SCRUM-964) | Compliance automation — Drata / Vanta / Hyperproof selection | Q2 |
| [SCRUM-979 TRUST-12](https://arkova.atlassian.net/browse/SCRUM-979) | SOC 2 Type II audit execution | Q2 |
| [SCRUM-981 TRUST-13](https://arkova.atlassian.net/browse/SCRUM-981) | SOC 3 bundle — public-facing summary | Q2 |
| [SCRUM-965 TRUST-08](https://arkova.atlassian.net/browse/SCRUM-965) | ISO 27001 gap analysis | Q2 |
| [SCRUM-966 TRUST-09](https://arkova.atlassian.net/browse/SCRUM-966) | ISO 27001 implementation roadmap | Q3 |
| [SCRUM-967 TRUST-10](https://arkova.atlassian.net/browse/SCRUM-967) | ISO 27701 privacy extension | Q3 |
| [SCRUM-978 TRUST-07](https://arkova.atlassian.net/browse/SCRUM-978) | UK Cyber Essentials Plus — IASME assessor engagement | Q3 |
| [SCRUM-968 TRUST-11](https://arkova.atlassian.net/browse/SCRUM-968) | CSA STAR Level 2 third-party audit | Q4 |
| [SCRUM-982 TRUST-14](https://arkova.atlassian.net/browse/SCRUM-982) | HITRUST i1 (conditional — healthcare vertical) | Q4+ |
| [SCRUM-983 TRUST-15](https://arkova.atlassian.net/browse/SCRUM-983) | StateRAMP (conditional — public sector vertical) | Q4+ |

## Working rhythm

1. Pick the top unblocked ticket.
2. Read the ticket + scan comments + scan linked PRs.
3. Branch: `claude/YYYY-MM-DD-<short-slug>`.
4. Write tests first (TDD MANDATE per CLAUDE.md §0).
5. Open a PR; link the Jira ticket; post a memo comment on the ticket.
6. **Stop.** Do not merge.
7. Repeat.

## Not on this list (and why)

- **Nessie work** (NPH / NTF / NDD / NSS / NVI / NMT / KAU) — NVI-gated, AI platform track.
- **Gemini Golden work** (GME / GME3–GME11) — Vertex training, AI platform track. **Exception:** MCP-SEC (which lives under the edge worker, not the AI pipeline) is Sarah-eligible.
- **External procurement not yet Sarah-needed** (SCRUM-517 SOC 2 pentest vendor, SCRUM-522 SOC 2 auditor, SCRUM-576/577 Kenya ODPC filing) — blocked on Carson/Matthew/counsel. Sarah can pick these up when they become engineering-tractable (e.g. once a vendor is selected and a scoped SOW exists).
- **Worker gcloud operations** (SCRUM-892 NPH-16-OPS) — Claude cannot touch the running Cloud Run worker per `feedback_worker_hands_off`; Carson executes.

# Sarah's Backlog

**Last verified:** 2026-05-04 (against live Jira `getJiraIssue` queries)
**Workflow:** GitHub-native — clone via `gh repo clone carson-see/ArkovaCarson`, branch, push, `gh pr create`, link the Jira ticket, post a memo comment, **STOP**. Carson + human reviewers own merges; never run `gh pr merge`.
**Scope rule:** Existing Jira stories and bugs only — no new epics, no Nessie (NPH/NTF/NDD/NSS/NVI/NMT/KAU), no Gemini Golden (GME/GME3–GME11). MCP-SEC + TRUST compliance tickets are in scope.

---

## Verified Done since prior version of this file (2026-04-21 → 2026-05-04)

The four Priority 1 tickets that headed the prior version of this file all shipped to `main` between 2026-04-21 and 2026-04-27. Status confirmed via live Jira on 2026-05-04 — every one is `Done`. Do not pick from the prior list.

| Jira | Title | Shipped |
|------|-------|---------|
| [SCRUM-727](https://arkova.atlassian.net/browse/SCRUM-727) | EDGAR Form ADV fetcher | PR [#459](https://github.com/carson-see/ArkovaCarson/pull/459) (2026-04-21) + [#493](https://github.com/carson-see/ArkovaCarson/pull/493) (2026-04-24) |
| [SCRUM-984](https://arkova.atlassian.net/browse/SCRUM-984) | MCP-SEC-07 tool-argument Zod validation | PR [#464](https://github.com/carson-see/ArkovaCarson/pull/464) (2026-04-21) |
| [SCRUM-985](https://arkova.atlassian.net/browse/SCRUM-985) | MCP-SEC-08 IP allowlist + Cloudflare bot-management | PR [#464](https://github.com/carson-see/ArkovaCarson/pull/464) + [#493](https://github.com/carson-see/ArkovaCarson/pull/493) |
| [SCRUM-987](https://arkova.atlassian.net/browse/SCRUM-987) | MCP-SEC-09 anomaly detection + Sentry alerting | PR [#464](https://github.com/carson-see/ArkovaCarson/pull/464) + [#493](https://github.com/carson-see/ArkovaCarson/pull/493) |

---

## Sarah's current session prompt (paste-ready)

> Copy the block below into your next session verbatim. It is self-contained — assumes nothing carried over.

```
You operate against GitHub directly. The Extreme SSD path Carson uses is HIS local checkout; ignore it. Your local clone path is yours — the prompt below uses repo-relative paths exclusively.

WORKING REPO
* GitHub: https://github.com/carson-see/ArkovaCarson
* `gh repo clone carson-see/ArkovaCarson` if you don't already have a local clone, then `cd ArkovaCarson && git fetch origin && git checkout origin/main` to start clean.
* All operations via `gh` CLI + `git` against origin. Never push to main, never run `gh pr merge`.

WHAT'S IN FLIGHT (do NOT touch any of these files; overlap = merge conflict + nuked commits)

* PRs #693, #695, #696, #697, #698 are all open. Files locked:
  - services/worker/src/api/v1/webhooks/microsoft-graph.{ts,test.ts} (PR #695)
  - supabase/migrations/0290_microsoft_graph_webhook_nonces.sql + 0291_msgraph_*.sql (PR #695)
  - services/worker/src/api/v1/contracts/anchor-post-signing.ts (PR #698 — pending)
  - services/worker/src/integrations/connectors/drive-changes-runner.{ts,test.ts} (PR #696)
  - services/worker/src/integrations/connectors/drive-changes-processor.ts (PR #697)
  - services/worker/src/jobs/rule-action-dispatcher.ts (PR #697)
  - services/worker/src/utils/orgSuspensionGuard.ts (PR #697)
  - services/worker/src/rules/schemas.ts (PR #697)
  - services/worker/circuits/build.sh + README.md (PR #693)
  - src/hooks/useActiveOrg.ts + ~50 callsites of profile.org_id (PR-A2 reserved, SCRUM-1651)
  - All staging-rig files: scripts/staging/*, .github/workflows/staging-evidence.yml, scripts/ci/check-staging-evidence.ts (Path A in flight; Path C incoming)
  - Path C session will rewrite: .github/workflows/migration-drift.yml, scripts/ci/check-migration-prefix-uniqueness.ts, scripts/ci/check-deploy-lint-parity.ts, supabase/migrations/0001..0290 (will be archived)

PRIMARY PICK — SCRUM-1207 [AUDIT-26] Automated Confluence-drift guard

* Status confirmed live (2026-05-04): To Do, unassigned, label `audit-2026-04-24`.
* Full spec: https://arkova.atlassian.net/wiki/spaces/A/pages/27132402
* Goal: a CI step that fails any PR if a SCRUM-NNN reference (in PR body, commit messages, or touched docs) lacks a corresponding Confluence page. Closes the CLAUDE.md §0 rule 4 enforcement gap.
* Scope:
  - New script at `scripts/ci/check-confluence-page-coverage.ts` (pattern after `scripts/ci/check-handoff-claims.ts`).
  - Detect SCRUM-NNN references via `git diff` + PR body + commit messages.
  - For each unique key, hit Confluence Cloud REST API to confirm a page titled `SCRUM-NNN — <summary>` exists under space `A` homepage 163950.
  - Cache results in `scripts/ci/snapshots/confluence-page-coverage-baseline.json` so historical SCRUM keys without pages get grandfathered (avoid breaking PR 1).
  - Wire into `.github/workflows/ci.yml` as a new job `Confluence Page Coverage`.
  - Override label: `confluence-drift-skip` for true exempt cases.
  - Tests: `scripts/ci/check-confluence-page-coverage.test.ts` with at least 4 vitest cases — happy path, missing-page failure, baseline grandfather, override label respected.
* Out of scope: backfilling pages for existing SCRUM keys (separate ticket SCRUM-1199). Just the guard + baseline.

WARM-UP TICKET (~30 min, no code) — SCRUM-1435 BUG-2026-04-26-009

* Fix already shipped in prod via PR #582 on 2026-04-27 00:55 UTC (both KV namespaces bound on `arkova-edge` Cloudflare Worker; verified via `wrangler versions view`). Status is To Do because the Reporter ≠ Resolver Atlassian Automation rule blocks Carson from flipping his own bugs.
* Your job: post a Jira sync comment with the PR + SHA + verification evidence, transition To Do → Done (you ARE allowed to resolve since you didn't report it), update the Confluence Bug Tracker master log at https://arkova.atlassian.net/wiki/spaces/A/pages/28115270 to mark this row resolved.
* No code, no PR. Pure hygiene.

DO NOT PICK

* Any LAUNCH-* item from the audit doc — those are P0 launch-readiness stories that don't have Jira keys yet.
* SCRUM-1648 / 1649 / 1650 / 1651 / 1652 — locked in PR #697 / future PR-A2.
* SCRUM-1626 / 1627 / 1632 — SCRUM-1623 contract-anchor work, parallel session in PR #698.
* SCRUM-1114 / 1115 (CIBA-HARDEN) — overlap with rule-action-dispatcher.ts in #697.
* SCRUM-1186 / 1187 / 1188 / 1189 — migration / RLS work that overlaps with active 0290/0291 + Path C.
* SCRUM-1548 — same Atlassian Automation issue Claude is fixing.
* Anything in `services/worker/src/integrations/connectors/`, `services/worker/src/api/v1/webhooks/`, `services/worker/src/jobs/rule-*`, or `services/worker/src/utils/orgCredits*` / `orgSuspensionGuard*`.

GITHUB WORKFLOW

1. `git fetch origin && git checkout -b claude/2026-05-04-scrum-1207-confluence-drift-guard origin/main`
2. Read CLAUDE.md (your top-of-file note + Section 1) before any code.
3. Read HANDOFF.md "Now" section first — confirm what's in flight.
4. `getJiraIssue SCRUM-1207` to confirm status + recent comments before coding (per memory rule feedback_jira_is_truth_check_first.md).
5. `gh pr list --search "SCRUM-1207"` first (per memory rule feedback_inventory_open_prs_before_starting.md). If an open PR already addresses it, drive it to merge instead.
6. Read agents.md in every folder you'll touch — `scripts/ci/agents.md` and `.github/workflows/agents.md` if either exists; otherwise note for HANDOFF.
7. Write tests first (TDD MANDATE per CLAUDE.md §0 rule 1).
8. `git push -u origin claude/2026-05-04-scrum-1207-confluence-drift-guard`
9. `gh pr create --base main --head claude/2026-05-04-scrum-1207-confluence-drift-guard --title "feat(SCRUM-1207): automated Confluence-drift guard for PR Jira-key coverage" --body-file <prepared body>` — body must include `## Staging Soak Evidence` heading with `Tier: T1` line (T1 = additive code, no migration, no chain, no audit writes).
10. Post a memo comment on SCRUM-1207 with `addCommentToJiraIssue` linking the PR.
11. STOP. Do NOT run `gh pr merge`. Per memory rule feedback_never_merge_without_ok.md — Carson + human reviewers own merges, no exceptions.

VERIFICATION GATES (CLAUDE.md §3 — all 7 mandatory before declaring done)

1. Tests written first, seen failing, then passing. `npx vitest run scripts/ci/check-confluence-page-coverage.test.ts` shows 4+ green.
2. Jira ticket transitioned, DoR + DoD checked, Confluence URL pasted in the ticket.
3. Confluence page for SCRUM-1207 reflects the shipped state (or is created if missing).
4. Bug log: not applicable (no bug found/fixed).
5. agents.md updated in every modified folder (scripts/ci/agents.md, .github/workflows/agents.md).
6. HANDOFF.md updated by your session-end note. Per CLAUDE.md doc-only carve-out, doc updates can land directly without PR ceremony.
7. Atlassian Automation rules in docs/jira-workflow/automation-rules.json approve the Done transition.

CI EXPECTATIONS (run before opening PR; CI re-runs on push)

* `npm run typecheck` — clean
* `npm run lint` — 0 errors (pre-existing warnings OK; do not "fix" warnings outside your file scope)
* `npm test -- scripts/ci/check-confluence-page-coverage.test.ts` — green
* `npm run lint:copy` — clean
* The new `Confluence Page Coverage` job will be the FIRST run of itself, so it self-verifies on its own PR.

REFERENCE LINKS

* SCRUM-1207: https://arkova.atlassian.net/browse/SCRUM-1207
* AUDIT-26 spec: https://arkova.atlassian.net/wiki/spaces/A/pages/27132402
* SCRUM-1435: https://arkova.atlassian.net/browse/SCRUM-1435
* Existing CI script for pattern reference: scripts/ci/check-handoff-claims.ts
* My active PRs to avoid: #693, #695, #696, #697, #698
* Memory rules to respect (under ~/.claude/projects/-Users-carson-Arkova-arkova-mvpcopy-main/memory/):
  - feedback_never_merge_without_ok.md
  - feedback_inventory_open_prs_before_starting.md
  - feedback_jira_is_truth_check_first.md
  - The "Extreme SSD is THE local repo" rule is CARSON-specific — does NOT apply to Sarah.
```

---

## What's locked by other sessions (do NOT touch)

| Files | Owner |
|------|------|
| `services/worker/src/api/v1/webhooks/microsoft-graph.{ts,test.ts}` | PR #695 |
| `supabase/migrations/0290_microsoft_graph_webhook_nonces.sql` + `0291_msgraph_*.sql` | PR #695 |
| `services/worker/src/integrations/connectors/drive-changes-runner.{ts,test.ts}` | PR #696 |
| `services/worker/src/integrations/connectors/drive-changes-processor.{ts,test.ts}` | PR #697 |
| `services/worker/src/jobs/rule-action-dispatcher.{ts,test.ts}` | PR #697 |
| `services/worker/src/utils/orgSuspensionGuard.{ts,test.ts}` | PR #697 |
| `services/worker/src/rules/schemas.ts` | PR #697 |
| `services/worker/circuits/build.sh` + `README.md` | PR #693 |
| `src/hooks/useActiveOrg.ts` + ~50 callsites of `profile.org_id` | PR-A2 reserved (SCRUM-1651) |
| `services/worker/src/api/v1/contracts/anchor-post-signing.ts` | PR #698 |
| `scripts/staging/*` + `.github/workflows/staging-evidence.yml` + `scripts/ci/check-staging-evidence.ts` | Path A staging-rig work |

---

## TRUST compliance + procurement (15 tickets, mostly doc-heavy)

Each has a clear external owner but Sarah can drive the engineering side (evidence-collection cadence, dashboards, certification tracker, etc.). All Q1–Q4+ pacing.

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

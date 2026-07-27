# Jira Hygiene — OWED (blocked on Atlassian connector auth)

**Owner:** Release/Train lane (RTE). **Date:** 2026-07-20 watch window.
**Blocker:** the Atlassian MCP is unauthorized in this non-interactive session (standing limitation). The operations below are turnkey — execute them the moment an interactive/authorized session (or connector re-auth) is available. Repo-side hygiene (tag + release) was completed this session; only the Jira mutations remain.

## 1. Re-parent PI-0.5 stories to epic SCRUM-2895
Set parent = **SCRUM-2895** (PI-0.5 epic) for each:
`SCRUM-2910, 2911, 2912, 2913, 2914, 2915, 2916, 2917, 2918, 2937, 2938, 2939, 2940`

Per-issue (MCP `editJiraIssue`, cloudId per `reference_atlassian_rovo_coords`): set the parent/epic-link field to SCRUM-2895. Verify each with `getJiraIssue` after (Atlassian bulk JQL is unreliable — `reference_atlassian_mcp_bulk_search_unreliable`). Note: stories without a parent get auto-blocked to Needs-Human by rule `019dca9d-8cd5-73c1-b911-77a481538d2f`, so this re-parent also clears that state if any tripped it.

## 2. Reconcile STALE-MISMATCH tickets
`SCRUM-1983, SCRUM-2547, SCRUM-2549` — flagged STALE-MISMATCH (Jira status disagrees with actual state). For each: `getJiraIssue` to read current status + linked PR/Confluence, compare against reality (code on main? prod green?), then transition to the correct status per `feedback_no_premature_jira_transitions` (Done only when code on main AND prod green; spec/doc-only Done when filed). Record the reconciliation reason in a comment. Do NOT force a Done transition that the DoD gates (R0-5 workflow validators) would reject — fix the underlying gap instead.

## 3. Already done this session (repo-side, no Jira)
- ✅ Tag `pi-0.5-plan-v3.1` pushed → origin/main `5a2c0e85` (supersedes `pi-0.5-plan-v2.1`; no workflow fires — verified against SDK-publish patterns `sdk-v*`/`arkova-py-v*`).
- ✅ v1.8.0 GitHub release notes refreshed to current merge state, kept **Draft** (publish deferred until chain rail #1552 lands — founder/outward action).

## Recommendation to founder
Authorize the Atlassian connector (claude.ai connector settings, or `/mcp` in an interactive session) so items 1–2 can be executed + verified. Until then these three-way (Jira/Confluence/code) reconciliations cannot be trusted from this session.

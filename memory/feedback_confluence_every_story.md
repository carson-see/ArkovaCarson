---
name: confluence-every-story
description: Every Jira Story and Epic — in ANY status, including To Do and Closed — has a Confluence page in space A, and its Definition of Done checkboxes must be ticked before the issue can transition to Done.
type: feedback
---

No SCRUM issue exists without a Confluence page. Not "once it's in progress", not "once it ships" — To Do, In Progress, Blocked, Done, and Closed all require one (CLAUDE.md §0 rule 4). The page is where the spec lives; the ticket is a pointer to it.

**Why:** Two separate failures. First, coverage: an issue with no page means the spec exists only in a Jira description that is capped at ~200 characters, or in a `docs/*.md` file auditors never open. Second, closure honesty — `docs/jira-workflow/automation-rules.json` records the concrete incident behind R4: **SCRUM-1235 was closed with `[ ]` checkboxes still unticked in its DoD section.** "Done" meant "the transition succeeded", not "the work is shippable". The rule turns the DoD from a document into a gate.

**How to apply:**
- Create the page before the ticket. Title `SCRUM-NNN — <summary>` for stories, `SCRUM-NNN — <TAG: Title> — AUDIT` for epics, parented under space `A` homepage `163950`.
- Structure: Goal / Outcomes / Scope / Child Stories / Definition of Done / References.
- Paste the Confluence URL into the Jira ticket — the coverage gate parses PR title, body, and commit messages for `SCRUM-NNNN` refs and looks each one up in space A.
- Tick every DoD checkbox before attempting the Done transition. If a box cannot be ticked, the issue is not Done — fix the gap rather than the checkbox.
- Update the per-story page, not just the epic page (CLAUDE.md §3 gate 3), and the topic pages named in the §4 Doc Update Matrix.

**Enforcement (two layers):**
1. **Atlassian Automation R4** — "Block Done unless Confluence DoD ticked", scope `project = SCRUM AND NOT issue.labels CONTAINS 'no-confluence-required'`. Rejects the transition and comments with the unticked-checkbox count and line numbers. The validator is delegated to `services/worker/scripts/ci/check-confluence-dod.ts`. Spec: `docs/jira-workflow/automation-rules.json`.
2. **CI drift guard** — `scripts/ci/check-confluence-coverage.ts` (SCRUM-1207 / AUDIT-26) verifies each referenced `SCRUM-NNNN` has a page in space A. It is **warn-only by default**; set `FAIL_ON_MISSING_CONFLUENCE=true` to make it blocking once the backfill (SCRUM-1199) clears.

**Override labels:** `no-confluence-required` (Jira, exempts the issue from R4) and `confluence-drift-skip` (PR label, exempts the CI coverage check — intended for chore/deps PRs that reference a story only for context).

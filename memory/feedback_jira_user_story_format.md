---
name: jira-user-story-format
description: Jira issues follow the post-2026-04-26 structure — short pointer description (≤200 chars) + Confluence link, the spec on the Confluence page, subtasks on every Story, a parent epic on every Story.
type: feedback
---

The Jira ticket is a **pointer**, not the spec. CLAUDE.md §5.1 fixes the shape:

- **Description** ≤200 characters plus the Confluence link. The Atlassian MCP edit endpoint caps the `fields` payload — longer descriptions round-trip-fail, so a "rich" description silently doesn't save.
- **Confluence page** carries the structured spec: Goal / Outcomes / Scope / Child Stories / DoD / References. Titles are `SCRUM-NNN — <summary>` for stories, `SCRUM-NNN — <TAG: Title> — AUDIT` for epics, parented under space `A` homepage `163950`.
- **Every Story has subtasks**, each with a brief description; all must close before the parent can go Done (Automation rule `019dcaa3-0834-7d67-9dbb-094c3dd7b34f`). Subtask issuetype is **id 10002** in this project.
- **Every Story has a parent epic** — orphans get bounced to Needs Human (rule `019dca9d-8cd5-73c1-b911-77a481538d2f`).
- **Reporter ≠ resolver** on Done (rule `019dca84-9ae3-7efc-a994-90ce64580fff`; mirrored as R1 in `docs/jira-workflow/automation-rules.json`, override label `solo-allowed`).

**Why:** Jira is the source of truth for *status* and Confluence for *documentation* (CLAUDE.md §0 rules 3 and 4). A ticket that carries the whole spec in its description breaks both: it exceeds the MCP write limit so the content is lost on the next edit, and it puts the spec somewhere auditors do not read. The subtask and parent-epic rules exist because Stories were closing as "Done" with unfinished child work and no epic to roll up into.

**How to apply:**
- Write the Confluence page first, then create the ticket pointing at it.
- Avoid the summary prefix `[DoD]` on subtasks — a Jira→Confluence sync hook tries to create a page per subtask keyed on the summary and `[DoD] X` collides. Use `[Verify]` or `[Close-out]`.
- Transition subtasks to Done alongside the parent, not after.

**Enforcement:** Atlassian Automation on the SCRUM project (rule IDs above). The CI script `scripts/ci/feedback-rules/feedback_jira_user_story_format.ts` is a **deliberate no-op stub** that always exits 0 and documents the enforcement path — CI cannot see Jira.

**Unverified:** `memory/README.md` calls this an "Atlassian Automation issue-create rule", but `docs/jira-workflow/automation-rules.json` (the declarative source of truth for Automation) contains only the six Done-transition rules R1–R6 — no issue-create rule. The three rule IDs above come from CLAUDE.md §5.1 and are not represented in that JSON export. Confirm in the Jira automation UI before relying on create-time blocking.

**Override label:** none in CI. `solo-allowed` relaxes the reporter≠resolver rule in Jira.

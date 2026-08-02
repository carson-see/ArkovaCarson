---
name: confluence-is-the-doc
description: Confluence space A is the documentation source of truth. Markdown under `docs/` is historical context or internal engineering notes — it is never "the documentation." Auditors read Confluence.
type: feedback
---

If a change needs documenting, the deliverable is a **Confluence page**. A `.md` file in `docs/` does not satisfy a documentation requirement, no matter how good it is.

**Why:** Auditors, buyers, and compliance reviewers read Confluence. They do not clone the repo. A doc that lives only in `docs/` is invisible at exactly the moment documentation has value — a CSA STAR / procurement / partner review — and it drifts freely because nothing gates it. CLAUDE.md §0 rule 4 records that the user has repeated this **500+ times**, which is itself the evidence: the failure mode is not that people disagree, it is that writing a markdown file feels like finishing and is therefore the default an agent falls back to under time pressure.

**How to apply:**
- Task-completion gate 3 (CLAUDE.md §3) is a *current per-story Confluence page*, not just the epic page, plus the topic pages named in the §4 Doc Update Matrix (Data Model, Security & RLS, Audit Events, On-Chain Policy, Payments & Entitlements, Webhooks, Identity & Access, Switchboard).
- When you find yourself writing `docs/<something>.md` as a deliverable, stop and ask which Confluence page this belongs on. Then either write it there, or write the `.md` and explicitly label it internal engineering notes.
- Per CLAUDE.md §6: a `.md` masquerading as documentation gets replaced by a Confluence page, with the markdown either deleted or demoted to internal notes.
- Legitimate `docs/` uses: runbooks an engineer executes, historical context, session/staging artifacts, plans, and evidence manifests. None of those are "the documentation."
- Team-facing deliverables go to Drive or Confluence as clean final documents — not diffs, not changelog-framed rewrites.
- Confluence MCP has **no partial edit** — updates replace the full body. Don't hand-rewrite a large page to change a few cells.

**Enforcement:** Documentation only for the "which artifact is canonical" judgement — no automation can tell a good `.md` from a documentation obligation. The adjacent mechanical check is `scripts/ci/check-confluence-coverage.ts` (warn-only by default, override label `confluence-drift-skip`), which verifies each referenced `SCRUM-NNNN` has a page in space A. Coverage passing does not mean the page says anything useful.

See also: `feedback_confluence_every_story.md` (page-per-issue + DoD gate).

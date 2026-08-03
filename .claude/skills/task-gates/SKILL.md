---
name: task-gates
description: The seven Arkova gates every task must pass before it can be called done, plus the UI UAT procedure and the Doc Update Matrix. Use when closing out a task or story, when transitioning a Jira ticket, when a UI change needs UAT proof, or when deciding which Confluence page a change obliges you to update.
---

# Task completion gates

A task is **not complete** until all seven pass. Announce gate status at the end of every task. "Done" means shippable, not "code merged."

## 1. Tests
Written first, seen failing, then made passing. `npm run typecheck`, `npm run lint`, `npm test`, `npm run lint:copy` all green. Coverage thresholds met on critical paths (80%). No `test.skip`.

Run the **full** suite, not just the files you touched — delegated work commonly passes its own tests while breaking a neighbour's.

## 2. Jira
Status transitioned, DoR + DoD checked, acceptance criteria ticked, Confluence URL pasted in the ticket. Transition the subtasks along with the parent — a story cannot close while its subtasks are open.

Do not transition to Done prematurely: it requires code on `main` **and** prod green.

## 3. Confluence
The per-story page is current, not just the epic page. Topic docs updated per the matrix below. Markdown in `docs/` is not documentation — auditors read Confluence.

## 4. Bug log
Every bug found or fixed lands in the master tracker: **Bug Tracker — Master Log**, Confluence page `88768514` (canonical; old `28115270` is archived and read-only). The Google Sheet is historical archive only.

## 5. agents.md
Updated in every modified folder. Keep it a *durable guide*, not a changelog: state what the directory contains and the rules for changing it. Dated narrative belongs in the PR description or a sibling changelog file — appending sediment to `agents.md` is how these files rotted to 8,500+ lines.

## 6. HANDOFF.md
Updated with the new state. Any edit asserting prod state (`rev arkova-worker-NNNNN`, `applied on prod`, `verified via`, `deployed healthy`, `live in prod`, `N of M findings shipped`) MUST link a verification artifact in the same PR description or commit body — the `handoff-claims` CI job enforces it. Footer format:

```
_Last refreshed: YYYY-MM-DD by <author> — claims verified against gcloud/MCP/CI output._
```

Touch `CLAUDE.md` only if a **rule** changed. Rolling narrative goes in HANDOFF.

## 7. Workflow validators
Atlassian Automation rules must approve the Done transition: reporter ≠ resolver, PR merged > 30 min, Cloud Run SHA matches, all DoD boxes ticked, no red required checks, Bug rows linked. If a rule blocks, fix the underlying gap — never seek a workaround.

---

## UI UAT (gate 1 for any UI change)

Dev server up, screenshots at **1280px and 375px**, both attached to the PR. Regressions logged in the bug tracker. Default to local preview plus DevTools for DOM/console/network/screenshot proof; use Vercel previews only for stakeholder demos or deploy-specific behavior. Every user-facing flow needs an E2E spec in `e2e/` before it is COMPLETE.

Verify yourself — never ask the reviewer to check manually.

## Doc Update Matrix

**In CLAUDE.md §4.** It used to be duplicated here verbatim, in a file edited independently — two copies of the same table, guaranteed to drift. CLAUDE.md keeps it because it reaches every agent, including ones that never load a skill.

## Shipping check

A feature is not shipped because the hook or endpoint exists. Grep for a **non-test importer** before calling anything shipped — an unconsumed hook is unshipped work.

## Related

None of this skill's rules have a standalone `memory/` file. The index is `memory/README.md`.

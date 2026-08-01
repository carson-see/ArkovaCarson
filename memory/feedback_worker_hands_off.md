---
name: worker-hands-off
description: Claude does not hand-mutate the running production Cloud Run worker — no `gcloud run services update`, no manual redeploy, no scaling/env changes. Ship the code and the runbook, mark the ticket Ready-to-Deploy, and stop. The operator runs the deploy.
type: feedback
---

The production worker (`arkova-worker`) is operator-territory. Claude's hands come off at the point where a change would touch the running service.

**What the rule covers** — grounded in the four places the repo cites it:
- **`gcloud run services update` on the running worker is off-limits** (`docs/runbooks/nph-16-deploy-api-keys.md` §10, which states the rule directly).
- **Redeploying to pick up new env vars / secrets / table references is Carson's** (`docs/runbooks/kyb/middesk.md` step 4: "Carson runs the deploy"; `docs/runbooks/codex-migration-conventions.md` §7 step 2 + its References line, "why you don't redeploy").
- **Cloud Run autoscaling config is human-only** (`docs/design/compliance-intelligence-epic.md`, SCALE-02).

**Claude's role instead**, per the nph-16 runbook: ship the code and any verification script, write the runbook, and move the Jira ticket to **Ready-to-Deploy (QA) — not Done**. The operator executes the deploy steps and pastes the outputs into a Jira comment; they close the ticket.

**Why:** A hand-run `gcloud run services update` writes a revision that no PR, no CI run, and no image digest accounts for. The worker then serves a state nobody can reconstruct, `/health.git_sha` stops matching any merge commit (which is precisely what Automation R3 blocks Done on), and the next legitimate deploy silently reverts whatever was patched in. It also skips the deploy pipeline's own gates — `deploy-worker.yml` runs the lint parity check and the image scan that a manual update bypasses entirely.

**How to apply:**
- The normal path is not manual at all: `deploy-worker.yml` deploys on push to `main` under `services/worker/**`. Merge is the deploy trigger. If the worker SHA trails main, verify `/health` and `gcloud` before assuming deploy lag — the workflow is path-filtered and may simply not have been triggered.
- Read prod state freely. `gcloud run services describe`, `/health`, log reads, `gcloud ai endpoints list` — reading is expected and required (never infer prod state from code or PR claims).
- If an env var or secret must land, document it in `docs/reference/ENV.md` and the runbook, name the operator step explicitly, and stop. Do not phrase it as a suggestion (`feedback_dont_recommend_do.md`).

**Scope — INFERENCE, not a quoted rule:** every repo citation is about the **production** worker. Isolated soak rigs and `*-staging` Cloud Run services are demonstrably agent-provisioned and agent-deployed elsewhere in the constitution (CLAUDE.md §1.11 / §1.11A and the staging runbooks), so this rule reads as prod-scoped. The original rule body was lost; if you need certainty on rig-side deploys, confirm with Carson rather than assuming either reading. Separately, never write to a rig that is mid-soak.

**Enforcement:** Documentation only — `memory/README.md` records the reason: agent-author detection is unreliable, so there is no automated way to distinguish an agent-run `gcloud` call from an operator-run one.

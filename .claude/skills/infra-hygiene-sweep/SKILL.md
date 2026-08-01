---
name: infra-hygiene-sweep
description: Recurring Arkova cost and cruft sweep — Vertex AI endpoint hygiene, Supabase staging-rig inventory and teardown, stale agent worktree pruning, and Actions-minute review. Use at release close, end of sprint, after any tuning/eval/deploy run, or when asked to check infrastructure cost, idle endpoints, leftover soak rigs, or disk usage.
---

# Infra hygiene sweep

Run at **release close and end of sprint**, and around every tuning/eval/deploy run. Each item below is a recurring, real cost that has bitten this project.

## 1. Vertex AI endpoints (CLAUDE.md §0 rule 7)

Audit **before and after** every tuning/eval/deploy run:

```bash
gcloud ai endpoints list --region=us-central1
```

Target **1–2 deployed** in steady state. Never keep cold-spare endpoints deployed — model artifacts preserve the redeploy path at no cost, so an idle deployed endpoint is pure burn. A past sweep found **6 empty endpoints** still deployed.

Undeploy the model first, then delete the endpoint.

## 2. Supabase staging rigs

Isolated soak rigs are created per-PR and routinely outlive their soak. A past sweep found **~10 leftover rigs**.

- List projects and identify rigs whose soak is complete or whose PR merged/closed.
- **Tear down done or empty isolated rigs.**
- Paid Supabase projects **cannot** be paused via MCP `pause_project` — it requires a free-tier downgrade first. So either delete the rig, or flag it for Carson to pause/downgrade from the dashboard. Do not report a paid rig as "paused" when it is not.

Never tear down a rig that is mid-soak. Confirm the soak clock (Cloud Run worker uptime) before deleting anything.

## 3. Stale agent worktrees

Agent worktrees accumulate under `.claude/worktrees/` and are mostly `node_modules` and build output rather than git history — linked worktrees share the object store.

```bash
git worktree list | wc -l
du -sh .claude/worktrees
```

Two-stage cleanup, safest first:

1. **Purge regenerable artifacts** from worktrees not modified recently. Zero risk — no branch or source is touched:
   `node_modules`, `services/*/node_modules`, `dist`, `build`, `test-results`, `playwright-report`, `coverage`, `.vite`.
2. **Remove whole worktrees** only when the branch is fully merged into `origin/main` *or* its HEAD is pushed to a remote ref, **and** the tree has no uncommitted tracked changes. Squash-merged branches look unmerged by ancestry — check for a merged PR before deleting. Then `git worktree prune`.

Skip any worktree modified in the last couple of days: another session may be live in it.

## 4. Actions minutes

`revision-drift.yml` runs on a **10-minute cron**, unconditionally, around the clock — the dominant standing Actions cost. Review whether that cadence is still justified. Scheduled and tag-triggered workflows are the only ones that run outside PR events (see CLAUDE.md §0 rule 8).

## 5. Report honestly

State what was found, what was deleted, what needs Carson (paid-project pause/downgrade, anything with live evidence attached), and what you deliberately left alone and why. Never report reclaimed capacity you did not verify — measure before and after.

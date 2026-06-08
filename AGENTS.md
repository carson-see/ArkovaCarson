# AGENTS.md

This repo's authoritative operating rules live in `CLAUDE.md`.

Before acting in any Arkova session:

1. Read the current `CLAUDE.md`.
2. Read the nearest relevant `agents.md` files for every directory you plan to touch.
3. After reading `CLAUDE.md`, run `scripts/agent/ack-claude-bootstrap.sh` from the repo root before any staging/prod-sensitive Bash command.
4. Do not mutate production, Jira, Confluence, PR evidence docs, or audit evidence unless Carson explicitly approves that exact operation.
5. During the 2026-06-08 T2/T3 rollout, read `HANDOFF.md`, `memory/t2_t3_rollout_sync_20260608.md`, and `docs/staging/t2-t3-rollout-status-20260608.md` before touching PRs, soaks, staging, prod, or closeout systems.

The Claude Code PreToolUse hook in `.claude/hooks/check-claude-bootstrap.sh` enforces the acknowledgement for staging/prod-sensitive Bash commands. Other agents must treat this file as the bootstrap pointer and follow the same rule manually if their runtime does not execute Claude hooks.

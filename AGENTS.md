# AGENTS.md

This repo's authoritative operating rules live in `CLAUDE.md`.

Before acting in any Arkova session:

1. Read the current `CLAUDE.md`.
2. Read the nearest relevant `agents.md` files for every directory you plan to touch.
3. After reading `CLAUDE.md`, run `scripts/agent/ack-claude-bootstrap.sh` from the repo root before any staging/prod-sensitive Bash command.
4. Do not mutate production, Jira, Confluence, PR evidence docs, or audit evidence unless Carson explicitly approves that exact operation.
5. For current release-drain state, read `HANDOFF.md` plus `memory/release_drain_sync_20260613.md`; older rollout memory files are historical unless their top status says otherwise.

The Claude Code PreToolUse hook in `.claude/hooks/check-claude-bootstrap.sh` enforces the acknowledgement for staging/prod-sensitive Bash commands. Other agents must treat this file as the bootstrap pointer and follow the same rule manually if their runtime does not execute Claude hooks.

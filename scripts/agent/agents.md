# scripts/agent/agents.md

Local agent bootstrap helpers. These scripts are guardrails for agent behavior only; they must not mutate production, staging, Jira, Confluence, GitHub PR bodies, or audit evidence unless a script name and help text explicitly says so.

- `ack-claude-bootstrap.sh` records the current `CLAUDE.md` SHA-256 in git-local state after an agent has read the file.
- `check-claude-bootstrap.test.sh` is the pure-bash test for the Claude PreToolUse bootstrap hook.

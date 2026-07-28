# scripts/agent/agents.md

Local agent bootstrap helpers. These scripts are guardrails for agent behavior only; they must not mutate production, staging, Jira, Confluence, GitHub PR bodies, or audit evidence unless a script name and help text explicitly says so.

- `ack-claude-bootstrap.sh` records the current `CLAUDE.md` SHA-256 in git-local state after an agent has read the file. It then runs `check-git-merge-config.sh` and exits non-zero if that guard trips.
- `check-claude-bootstrap.test.sh` is the pure-bash test for the Claude PreToolUse bootstrap hook.
- `check-git-merge-config.sh` refuses a `merge.<builtin>.driver` config entry (`union`/`text`/`binary`) or a no-op driver command at any config scope. Read-only against git config.

## 2026-07-28 — union merge-driver guard (silent agents.md data loss)

`.gitattributes` sets `agents.md merge=union` for ~200 files. This checkout's
`.git/config` carried `[merge "union"] driver = true`: naming a git BUILT-IN
driver overrides the real algorithm, and `true` is the shell no-op — it writes
nothing to `%A` and exits 0, so git recorded **clean** merges while keeping
"ours" and discarding every line unique to "theirs". No conflict markers, no
error. 169 lines were lost off `main` across 31 commits before it was found.

- **DO** let `ack-claude-bootstrap.sh` run the guard every session. `.git/config`
  is not committed, so CI cannot see this class — a per-checkout check at
  session start is the only place it can be caught before a merge.
- **DO NOT** add any `merge.union.*` config to "make union work". The built-in
  needs no driver config; defining one is what breaks it.
- The committed backstop is `scripts/ci/check-agents-md-append-only.ts`, which
  catches the resulting content loss on a PR regardless of cause.

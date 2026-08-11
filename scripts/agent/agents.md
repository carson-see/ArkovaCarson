# scripts/agent/agents.md

Local agent bootstrap helpers. These scripts are guardrails for agent behavior only; they must not mutate production, staging, Jira, Confluence, GitHub PR bodies, or audit evidence unless a script name and help text explicitly says so.

- `ack-claude-bootstrap.sh` records the current `CLAUDE.md` SHA-256 in git-local state after an agent has read the file. It then runs `check-git-merge-config.sh` and exits non-zero if that guard trips.
- `check-claude-bootstrap.test.sh` is the pure-bash test for the Claude PreToolUse bootstrap hook (29 cases).
- `check-constitution-on-edit.test.sh` is the pure-bash test for the Edit/Write constitution hook (20 cases).
- `check-git-merge-config.sh` refuses a `merge.<builtin>.driver` config entry (`union`/`text`/`binary`) or a no-op driver command at any config scope. Read-only against git config. A no-op is matched on the command WORD, not the whole string, because drivers are conventionally written with `gitattributes(5)` placeholders — `true %O %A %B` is the same silent no-op as bare `true`. `cat %A` counts too: it prints ours and leaves `%A` untouched. It also has a `--command '<shell command>'` mode that scans one command string for a TRANSIENT driver override instead of reading config; that mode is what `.claude/hooks/check-git-merge-driver-flag.sh` calls, and it is a pure function of its argument (no repo, no config, no side effects).
- `check-git-merge-config.test.sh` is the pure-bash test for that guard (41 cases: built-in shadowing, no-op forms with and without placeholders, legitimate custom drivers that must still pass, and the command-string mode including the documented `--unset`/`--get-regexp` remediation commands and heredoc bodies, neither of which may ever be blocked).
- `check-git-merge-driver-flag.test.sh` is the pure-bash test for the PreToolUse adapter at `.claude/hooks/check-git-merge-driver-flag.sh` (14 cases: blocks, allows, malformed/empty hook payloads that must fall through, fail-open when the guard binary is absent, and an assertion that the hook is actually registered in `.claude/settings.json` — an unwired hook is inert).

## 2026-07-28 — union merge-driver guard (silent agents.md data loss)

`.gitattributes` sets `agents.md merge=union` for ~200 files. This checkout's
`.git/config` carried `[merge "union"] driver = true`: naming a git BUILT-IN
driver overrides the real algorithm, and `true` is the shell no-op — it writes
nothing to `%A` and exits 0, so git recorded **clean** merges while keeping
"ours" and discarding every line unique to "theirs". No conflict markers, no
error. 86 lines were lost off `main` across 19 commits before it was found.

- **DO** let `ack-claude-bootstrap.sh` run the guard every session. `.git/config`
  is not committed, so CI cannot see this class — a per-checkout check at
  session start is the only place it can be caught before a merge.
- **DO NOT** add any `merge.union.*` config to "make union work". The built-in
  needs no driver config; defining one is what breaks it.
- The committed backstop is `scripts/ci/check-agents-md-append-only.ts`, which
  catches the resulting content loss on a PR regardless of cause.

## 2026-08-02 — these suites now actually run, and the hooks now actually enforce

Until this change `scripts/agent/*.test.sh` had **no discovery mechanism** in
`ci.yml` or `package.json` (flagged in `docs/staging/sprint-2026-07-28-findings.md`
item 12). They are now run by `npm run test:hooks` from the `Agent Hook Guards`
CI job — `continue-on-error: true` for one sprint, then promote to required.

Both suites now **FAIL rather than skip** when `jq` is absent. A green check that
silently skipped is worse than no check, because it reads as validation of
whatever change is in flight.

An enforcement audit probed the two hooks with crafted payloads and found they
blocked **1 of the 8** rules CLAUDE.md credited them with. Closed here, each
with a regression test that is verified to fail against the pre-fix hook:

- **Path normalization.** `repo_root` came from `CLAUDE_PROJECT_DIR`/cwd, so a
  file inside a git worktree never normalized to a repo-relative path and every
  path-scoped rule silently no-opped — in exactly the trees where this repo does
  its parallel work. Now resolved from the file's own directory, and a path that
  still will not normalize fails CLOSED.
- **Secret shapes.** Detection required a variable-name prefix, so a bare
  `service_role` JWT passed. Now matched by token shape, including all three
  base64 alignments of the role claim, plus `whsec_`, PEM keys, and `AIza` keys.
- **Migration immutability** was gated behind `^[0-9]{4}_`, leaving the
  `00000000000000_` baseline and the lettered `0055b_` family unprotected.
- **§1.3 terminology** gated on `.tsx|.jsx`, so it had never read `src/lib/copy.ts`
  — the file §1.3 designates as the home of all UI copy — and was missing four
  banned terms. Widened; still advisory, `npm run lint:copy` remains the gate.
- **Bootstrap matcher bypasses.** Five commands reached live staging/prod
  operations without an acknowledged CLAUDE.md: a quoted wrapper
  (`bash -c '…'`), `scripts/staging` without a trailing slash, a global flag
  splitting the sub-command token run, `--undo` scoped to the wrong segment of a
  compound line, and `gh pr edit --body-file`. The matcher now splits compound
  commands into segments and judges each on its own tokens.

**DO** re-run `npm run test:hooks` after touching either hook, and **DO** add a
case that is proven to fail against the previous version — a hook rewrite that
fails open produces no error, which is how the original holes survived. During
this work the segment loop itself briefly failed open (`printf '%s'` emits no
trailing newline, so `read` hit EOF and the loop body never executed, reporting
every command as non-sensitive). It was caught only because the baseline cases
were run before and after.

## 2026-08-11 — the union-driver loss recurred, transiently (PR #2061)

The 2026-07-28 guard above closed the **config** hole and did not close the
class. The same data loss happened again with a **clean `.git/config`**, from

```
git -c merge.union.driver=true merge origin/main
```

`-c` sets config for one invocation. It writes no config file, so
`check-git-merge-config.sh`'s config scan sees nothing — and because that guard
runs once from `ack-claude-bootstrap.sh` at session start, it had already run
and passed before the merge was typed. A PreToolUse hook is also not a child of
the git process, so the `GIT_CONFIG_PARAMETERS` that `-c` sets is not in its
environment either. **The override is invisible to every config-based check by
construction; only the command string reveals it.**

It dropped the 2026-08-10 DPA/IP-hashing section from
`services/worker/src/api/v1/agents.md` and the cron-route trigger-decision rule
from `services/worker/src/routes/agents.md`. Only
`scripts/ci/check-agents-md-append-only.ts` caught it. Re-merging with a plain
`git merge origin/main` preserved everything.

Reproduced in a scratch repo before writing the guard: with `agents.md
merge=union` set, `git -c merge.union.driver=true merge theirs` exits 0, prints
`Auto-merging` and `Merge made by the 'ort' strategy`, and the line unique to
"theirs" is simply gone. The valueless form (`-c merge.union.driver`) is a hard
`fatal: missing value`, so it is not a silent-loss vector.

- **DO** merge with `git merge origin/main` and nothing else. `.gitattributes`
  already declares `agents.md merge=union`; the flag does not enable union
  merging, it replaces it.
- **DO** run `git diff origin/main HEAD -- '*agents.md' | grep -E '^-[^-]'`
  after any merge touching an `agents.md`. Empty = clean.
- **DO NOT** read the new hook as full coverage: it only sees Bash tool calls
  inside a Claude Code session. A human terminal, a CI job, or a non-Claude
  runtime is covered only by the append-only CI gate.
- Note the `Agent Hook Guards` CI job is still `continue-on-error: true`, so
  these suites report but do not block. Run `npm run test:hooks` locally.

**Heredoc bodies are stripped before matching.** The hook sees the entire Bash
command string, so a commit message or runbook that *quotes* the offending
command would otherwise trip the guard against it — the commit introducing this
hook was blocked by its own commit message. A guard people route around stops
protecting anything, so `scan_command_string` drops heredoc bodies first.
Everything outside a heredoc, before or after, is still scanned; an override
that would actually execute is still caught. **DO** keep a red-first case for
both halves of that (`override AFTER heredoc still denied`) when touching it —
loosening a matcher is exactly where a guard silently starts failing open.

Rule of record: `memory/feedback_git_merge_driver_override.md`.

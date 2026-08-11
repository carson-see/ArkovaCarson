# scripts/agent/agents.md

Local agent bootstrap helpers. These scripts are guardrails for agent behavior only; they must not mutate production, staging, Jira, Confluence, GitHub PR bodies, or audit evidence unless a script name and help text explicitly says so.

- `ack-claude-bootstrap.sh` records the current `CLAUDE.md` SHA-256 in git-local state after an agent has read the file. It then runs `check-git-merge-config.sh` and exits non-zero if that guard trips, and finally runs `install-git-merge-hooks.sh` (never fatal) so `.githooks/pre-merge-commit` is live from the first session in a fresh clone.
- `check-claude-bootstrap.test.sh` is the pure-bash test for the Claude PreToolUse bootstrap hook (29 cases).
- `check-constitution-on-edit.test.sh` is the pure-bash test for the Edit/Write constitution hook (20 cases).
- `check-git-merge-config.sh` refuses a `merge.<builtin>.driver` config entry (`union`/`text`/`binary`) or a no-op driver command at any config scope. Read-only against git config. A no-op is matched on the command WORD, not the whole string, because drivers are conventionally written with `gitattributes(5)` placeholders — `true %O %A %B` is the same silent no-op as bare `true`. `cat %A` counts too: it prints ours and leaves `%A` untouched.
- `check-git-merge-config.test.sh` is the pure-bash test for that guard (22 cases: built-in shadowing, no-op forms with and without placeholders, legitimate custom drivers that must still pass, and the env-injected `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT` forms that reach the guard only from inside a git hook).
- `install-git-merge-hooks.sh` installs a shim for `.githooks/pre-merge-commit` into whatever hooks directory the checkout resolves to (`git rev-parse --git-path hooks`, so one install covers every worktree). Called by `ack-claude-bootstrap.sh`. Never clobbers a hook it did not write, and always exits 0 — hook installation must not be able to brick session bootstrap.
- `check-unsafe-git-merge.test.sh` is the pure-bash test for the whole merge-driver vector (73 cases across five sections: what the two merge commands actually do, the config guard's structural blind spot, the git hook, the Claude PreToolUse hook, and the installer).

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

## 2026-08-11 — the same driver, passed on the command line (PR #2060)

`check-git-merge-config.sh` reads git CONFIG. `git -c merge.union.driver=true
merge origin/main` writes nothing to config and has **exactly** the effect of
the 2026-07-28 entry. An agent merging main into PR #2060 was instructed to run
that command, ran it, and dropped 100 lines of main's `agents.md` content across
`src/lib/agents.md` and `src/pages/agents.md`. The session-start guard had
printed "OK" minutes earlier and was not wrong — it cannot see a flag passed to
a different process. `scripts/ci/check-agents-md-append-only.ts` caught it, but
only after the merge was committed and pushed.

**The correct command is a plain `git merge origin/main`.** `.gitattributes`
(`agents.md merge=union`) plus git's BUILT-IN union driver already combine both
sides. Any `merge.union.driver` value — config, `-c`, `--config-env`,
`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_KEY_n` — makes it worse, never better. The
built-in needs no driver config to work; that is the whole point of a built-in.

Nothing about the guard's LOGIC was wrong, so nothing about it changed. What
changed is where the question gets asked:

- **`.githooks/pre-merge-commit`** runs the same guard as a SUBPROCESS OF GIT.
  Git exports `-c` / `--config-env` settings to its subprocesses as
  `GIT_CONFIG_PARAMETERS`, so `git config --show-origin` there reports them with
  origin `command line:` — visible at last. Non-zero aborts before the merge
  commit exists. Installed by `install-git-merge-hooks.sh` from
  `ack-claude-bootstrap.sh`, because `.githooks/` is inert in this checkout:
  `core.hooksPath` points at `.git/hooks`, which holds only git's `.sample`
  files. (Repointing `core.hooksPath` was rejected — it would silently switch on
  `.githooks/pre-commit`, a full `tsc --noEmit` + lint on every commit for
  everyone, as a side effect of a merge fix.)
- **`.claude/hooks/block-unsafe-git-merge.sh`** refuses the command outright, so
  the working tree is never touched. This is the only layer that would have
  stopped PR #2060, because the failure was an agent following an instruction.
  It also blocks `git config` WRITES to `merge.<x>.driver` — catching the
  2026-07-28 config a session earlier than the session-start guard can.

**DO NOT** weaken `scripts/ci/check-agents-md-append-only.ts`. It is the only
thing that caught either incident, it is cause-agnostic, and none of the above
replaces it — they move detection earlier, they do not make it redundant.

**DO** note what `pre-merge-commit` does not cover, rather than assuming: it
fires only when a merge is about to auto-commit, so `--no-commit`, `--squash`,
and a conflicted merge finished by hand run `pre-commit` instead, and a
fast-forward invokes no merge driver at all. `ARKOVA_SKIP_MERGE_GUARD=1` is the
named escape hatch, so nobody reaches for `--no-verify` and turns off every hook
at once; the Claude hook blocks that variable too.

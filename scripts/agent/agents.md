# scripts/agent/agents.md

Local agent bootstrap helpers. These scripts are guardrails for agent behavior only; they must not mutate production, staging, Jira, Confluence, GitHub PR bodies, or audit evidence unless a script name and help text explicitly says so.

- `ack-claude-bootstrap.sh` records the current `CLAUDE.md` SHA-256 in git-local state after an agent has read the file. It then runs `check-git-merge-config.sh` and exits non-zero if that guard trips.
- `block-pr-merge.test.sh` is the pure-bash test for the `gh pr merge` / force-push / `--no-verify` PreToolUse hook (90 cases: the three rule families firing, legitimate work still allowed, 17 git global-option bypasses, 17 `+`-refspec force-push bypasses including wildcard destinations, 6 backslash-newline continuation bypasses, 24 over-match cases that keep the fixes honest, 3 known over-blocks pinned at their current wrong value so a later fix must flip them deliberately, the normalizer's presence, and wall-clocked pathological inputs).
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

## 2026-08-11 — `block-pr-merge.sh` had the same global-flag hole, in all three rules

The audit above probed two hooks. `block-pr-merge.sh` was the third and was
never probed, and it carried the identical defect: every rule required the
sub-command to sit IMMEDIATELY after `git`
(`git[[:space:]]+(push|commit).*--no-verify`), and git accepts its global
options in between. Observed empirically, not theorised —
`git -c user.email=a@b.c -c user.name=x commit -q -m probe --no-verify` ran to
completion in a live session with the hook active.

17 bypass forms are now pinned in `block-pr-merge.test.sh`, each verified to
return exit 0 against the pre-fix hook: `-c k=v`, `-C <path>`, the attached
short forms `-ck=v` and `-C/path`, `--git-dir=` / `--work-tree=` / `--namespace=`
/ `--config-env=` / `--exec-path=` / `--attr-source=` in both attached and
separated form, `--no-pager`, stacked combinations, the same flags after `&&`,
and a quoted value containing a space (`-c user.name="Claude Bot"` — the
realistic shape of a bot identity, and the one a naive `\S+` value matcher stops
short of). Only one of the 17 blocked before the fix, and it blocked by
accident: `git --git-dir .git push …` matched the `git ` inside `.git `.

- **DO** normalize, never drop the adjacency anchor. `.claude/hooks/normalize-git-command.py`
  strips git's leading global options so the sub-command is adjacent again, then
  the hook applies its rule regexes unchanged. It is a committed sibling file
  rather than an inline heredoc for a reason: nested inside `$( )` it is one
  stray character away from making bash consume to EOF, which takes down every
  Bash tool call in the session the hook exists to protect.
  An anchorless regex would block every line that merely
  MENTIONS `push --force … main` — commit messages, docs, echoes. The ten
  over-match cases are as load-bearing as the bypass cases; they are what stops
  the "fix" from being a different bug.
- **DO** keep the normalizer failing closed. An unrecognized leading `-flag` is
  treated as boolean and stripped, so a global option added to git in future
  cannot re-open the hole, and if `python3` is unavailable `norm` falls back to
  the raw command so the rules still run at pre-fix strength.

Known residuals, each confirmed by probe on 2026-08-11 and each a distinct rule
change rather than this bug class:

- **Refspec force-push was not caught at all — now CLOSED, see the next
  section.** `git push origin +main`, `+main:main` and `+HEAD:master` were
  ALLOWED — the leading `+` forces the update and no `--force` flag appears,
  which was the only thing rule 2 looked for. This was a real hole in the
  force-push guard and predated this change.
- **A user alias resolves after the guard has read the line.**
  `git -c alias.p=push p --force origin main` is ALLOWED; `p` only becomes
  `push` inside git.
- **No word boundary before `git`.** `legit push --force origin main` and an
  `echo` mentioning `.git push --force origin main` are both BLOCKED. That
  direction over-blocks and is harmless, so it is left alone.

## 2026-08-11 — the refspec force-push residual (rule 2b), and two holes found reviewing it

The first residual listed above is now a rule. `git push origin +main`,
`+main:main` and `+HEAD:master` were ALLOWED by the hook, confirmed by probe;
rule 2 only ever looked for a force **flag** (`--force` / `-f` /
`--force-with-lease`), and a leading `+` on a refspec forces the update
per-refspec with no flag anywhere on the line. 13 forms are now pinned in
`block-pr-merge.test.sh`, each verified to return exit 0 against the pre-fix
hook: the bare `+main` / `+master`, `+main:main`, `+HEAD:main` / `+HEAD:master`,
`+feature:main`, the fully-qualified `+refs/heads/main` and
`+refs/heads/x:refs/heads/main`, a safe refspec followed by an unsafe one, a
quoted `"+main"`, and the form inside a compound command.

This is **not** another instance of the global-flag bug class above.
Normalizing the line cannot help when there is no flag to find — it is a
missing rule, not a split token run. It does compose with that fix, though:
rule 2b matches on `"$norm"`, so `git -c user.name=x push origin +main` needs
both changes to be caught, and two cases pin exactly that.

- **DO NOT** reach for `\b(main|master)\b` here, which is what rules 2's flag
  matchers use. This is the one rule in the hook where a ref NAME decides the
  verdict, and `\b` treats `-`, `.` and `/` as word boundaries — `\bmain\b`
  matches inside `+docs/main-page`, `+main-page` and `+release.main.v2`, so it
  would block legitimate forced pushes to branches that merely contain the
  substring. Ref-name characters are excluded on both sides instead.
- **DO** read the DESTINATION, not the line. `+feature:main` overwrites main
  and blocks; `+main:feature` force-updates `feature` FROM main, leaves main's
  history alone, and is allowed. A matcher that just asks "does this line
  contain `+`…`main`" gets that backwards. The trailing character class
  excludes `:` for this reason alone — that single exclusion is the whole of
  what keeps `+main:feature` out.
- The 14 over-match cases in `--- the refspec rule must not over-match ---` are
  as load-bearing as the 13 bypass cases. A guard that blocks
  `git push origin +docs/main-page` is a different bug, not a stricter fix.

**This rule over-blocks its own commit message,** and that is a new residual,
not a pre-existing one. A commit message or doc that *quotes* the blocked
command trips the guard against it — the commit introducing rule 2b had to be
reworded to land. `check-git-merge-driver-flag.sh` already solved this class by
stripping heredoc bodies before matching; `block-pr-merge.sh` does not, so all
three of its rule families share the behaviour (rule 2 has it too, and only
avoids it today because a prose sentence rarely puts `git` immediately before
`push`). **DO NOT** bolt heredoc stripping on here as a drive-by: it is a
loosening of a security control, which is precisely where a guard starts
failing open silently, and it needs its own red-first cases in both directions
— including an override placed AFTER a heredoc, which must still be denied.

**The first version of rule 2b shipped with two holes of its own.** Both were
found by adversarially probing the new rule immediately after writing it, and
both are fixed in the same PR. Neither would have been caught by the 27 cases
the rule shipped with, which is the point: a matcher written against the forms
you already know about is tested against the forms you already know about.

- **A wildcard destination covers main without spelling it.**
  `+refs/heads/*:refs/heads/*` and `+refs/*:refs/*` returned exit 0 — rule 2b
  required a literal `main`/`master` destination component. The destination
  alternation now also matches a glob. This deliberately over-blocks a glob
  that provably cannot reach main (`+docs/*`), pinned as such in the suite: the
  rule cannot know which refs a glob covers, and over-blocking a destructive
  push costs one question, under-blocking costs main.
- **A backslash-newline walked past every rule in the file.** grep is
  LINE-oriented, so `.*` never spans a newline, and every rule here is shaped
  `git…push.*<thing>`. `git push origin \<newline> +main`, `git push
  \<newline> --force origin main` and `git commit -m x \<newline> --no-verify`
  all returned exit 0. `$cmd` now joins backslash-newlines before anything
  reads it. **DO NOT** widen that to bare newlines: `.*` would then reach
  across independent commands, so an unrelated later line mentioning `main`
  would arm a rule an earlier `git push` line started.

**DO** probe a new matcher adversarially before believing it, and probe it for
the shapes it does NOT enumerate. Both holes above are in the same family as
the bug the rule was written to fix — a force-push to main that the regex does
not recognise as one — and both survived a red-first suite that only pinned the
forms already known.

Still open from the list above, both unchanged: the user-alias resolution
(`-c alias.p=push p --force origin main`) and the missing word boundary before
`git` (which over-blocks, harmlessly).

Also still open, and NOT closed by rule 2b: `git push --force --all origin` and
`git push --mirror origin` both return exit 0. Each force-updates main without
naming a branch, so rule 2's `\b(main|master)\b` requirement never fires. These
are rule 2's gaps, older than rule 2b and left for their own change — recorded
here so the next reader does not have to rediscover them. Together with the
wildcard case they are the argument for eventually replacing three
shape-specific regexes with one parse of the push command: the normalizer
sibling already tokenizes the line and could return `{flags, refspecs}` for a
single destination check, instead of each new force syntax costing another
regex and another set of boundary-class edge cases.
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

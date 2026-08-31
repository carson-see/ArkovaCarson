# scripts/agent/agents.md

Local agent bootstrap helpers. These scripts are guardrails for agent behavior only; they must not mutate production, staging, Jira, Confluence, GitHub PR bodies, or audit evidence unless a script name and help text explicitly says so.

- `ack-claude-bootstrap.sh` records the current `CLAUDE.md` SHA-256 in git-local state after an agent has read the file. It then runs `check-git-merge-config.sh` and exits non-zero if that guard trips.
- `block-pr-merge.test.sh` is the pure-bash test for the `gh pr merge` / force-push / `--no-verify` PreToolUse hook (179 cases: the rule families firing, legitimate work still allowed, 17 git global-option bypasses, 13 `+`-refspec force-push bypasses, 18 whole-repo (`--force --all` / `--mirror`) bypasses, 9 wildcard-destination bypasses, 6 backslash-newline continuation bypasses, 19 transient-user-alias bypasses (case-mangled `Alias.`/`ALIAS.` spellings included), 13 `gh pr merge --help` carve-out cases, the over-match cases that keep every fix honest, the normalizer's presence, wall-clocked pathological inputs, and 3 assertions that the sibling `check-staging-evidence-pre-merge.sh` hook's `gh` calls are time-bounded).
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

## 2026-08-11 — the refspec force-push residual, closed (rule 2b)

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

Still open from the list above, both unchanged: the user-alias resolution
(`-c alias.p=push p --force origin main`) and the missing word boundary before
`git` (which over-blocks, harmlessly).

> **This residual list was incomplete — see the 2026-08-23 section.** Three
> further bypasses (`--force --all` / `--mirror`, wildcard refspec destinations,
> and backslash-newline continuations) were open at the time this was written.
> The PR that found them merged into a stacked base instead of `main`, so its
> fix and its note here were both lost while this "closed (rule 2b)" heading
> remained. Do not read this section as the current state of the guard.

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

## 2026-08-23 — the force-push guard closed on three more forms (rules 2c, 2d, and the continuation fold)

**Read the section above this one before believing it.** It ends "Still open
from the list above, both unchanged", naming only the user-alias and
word-boundary residuals. That list was incomplete, and the way it became
incomplete is the more useful lesson: PR #2181 found, fixed and documented three
further bypasses, but it was opened against a stacked base
(`claude/serene-hodgkin-635c85`) rather than `main`. Its merge commit
`de5eb84d3` is not an ancestor of `main`, so the fix, its 13 extra cases and the
agents.md paragraph recording the hole all vanished while the sibling PR #2178's
heading — "the refspec force-push residual, closed (rule 2b)" — stayed. The repo
therefore *documented a guard that was stronger than the guard it shipped*. A
stacked PR that merges into its base rather than `main` reports MERGED while its
work is orphaned; check `git merge-base --is-ancestor <merge-sha> origin/main`
before trusting a "fixed in #NNNN" claim. Jira: SCRUM-3492 (SCRUM-3501 is the
duplicate harvested from #2181).

All three were re-probed against `main`'s hook before being fixed, not taken on
the PR's word — each returned exit 0:

- **Whole-repo force push (now rule 2c).** `git push --force --all origin` and
  `git push --mirror origin` force-update every branch on the remote, main
  included, and name none of them. Rules 2 and 2b both decide on a NAME — a
  literal `main`/`master` on the line, or as a `+`-refspec destination — so
  neither could ever fire. `--mirror` additionally DELETES remote refs absent
  locally.
- **Wildcard destination (now rule 2d).** `+refs/heads/*:refs/heads/*`,
  `+refs/*:refs/*` and the flag-spelled `--force ... refs/heads/*:refs/heads/*`
  expand to every branch, main included. Rule 2b requires a literal
  `main`/`master` destination *component*, which a glob is not.
- **Backslash-newline continuation (folded in the extraction step).** Every rule
  here greps, and grep matches line by line. A `\`-newline is one command to
  bash but two lines to grep, so `git push origin \`⏎`+main`,
  `gh pr \`⏎`merge 123` and `git commit -m x \`⏎`--no-verify` split the anchor
  from the operator and defeated *every* rule family at once, rule 1 included.

- **DO** keep `--all` gated behind a force flag. An unforced push of every
  branch is still rejected non-fast-forward, so `git push --all origin` is
  ordinary work and must stay allowed. `--mirror` needs no such gate: it is a
  forced push by definition. `git clone --mirror` is read-only and is a
  different subcommand — pinned as an over-match case.
- **DO** decide rule 2d on branch LEVEL, not on the presence of a `*`. The
  wildcard has to sit where the branch's own name sits — bare `*`, `refs/*`,
  `refs/heads/*` — to be able to expand to `refs/heads/main`. One level deeper
  it cannot, so `+feature:refs/heads/feature/*` and `+refs/tags/*:refs/tags/*`
  stay allowed. That is what the "no `/` after the optional `refs/heads/`
  prefix" in the destination pattern buys, and it is why the leading boundary is
  rule 2b's explicit character class rather than `\b` — `/` must never be read
  as the start of a destination.
- **DO NOT** widen the continuation fold to bare newlines. A bare newline is a
  command SEPARATOR. Folding those too splices unrelated commands into one line:
  a benign force-push to a feature branch followed by `git log main` would read
  as a force-push to main. One case pins exactly that, and it is the difference
  between a stricter guard and a broken one.
- **DO** keep the fold in the extraction step rather than in
  `normalize-git-command.py`. The hook deliberately falls back to the raw
  command when the normalizer cannot be run; a fail-open there would restore the
  whole hole, and this one defeats rule 1 as well, which never sees `$norm`.
- **DO** keep `[^;&|]*` in rules 2c and 2d rather than the `.*` the older rules
  use. It holds each match inside one shell command, so a later unrelated
  `git clone --mirror` is not attributed to the push in front of it. Two
  over-match cases pin it.
- **DO** terminate rule 2c's flags on "not a ref-name character", never on
  `[[:space:]]`. Found in review of this change, before it was pushed: bash ends
  a word at `;`, `&`, `|`, `>`, `<` and `)` with no space in between, so a
  whitespace-or-end-of-line terminator left rule 2c bypassable by typing one
  extra character — `git push --mirror;echo done`, `git push --mirror>log` and
  `git push --force --all&&echo done` all returned exit 0 against the first cut
  of the rule. This is the same shape as the global-option and continuation
  bypasses above: a guard that assumed the shape of *tidily spaced* input. The
  negated class still ends at the flag, so `--mirrored` and `--allow-x` are
  different options and stay allowed (both pinned), and it fails CLOSED on
  `--mirror=x`. Eight bypass cases and two boundary cases pin it.

Suite is now 130 cases, and the two new wall-clocked cases (`200 refspecs ...`)
exist because rules 2c/2d scan forward from `git push` — the pre-existing
pathological cases all exit at rule 2 or never reach a push, so they would not
have caught a backtracking regression in the new rules.

Still open, all pre-existing and none of them this class:

- The **user-alias** residual (`git -c alias.p=push p --force origin main`) —
  `p` only becomes `push` inside git.
- The **missing word boundary before `git`** — over-blocks, harmlessly.
- **A newline inside a QUOTED string** still splits the line for grep, e.g. a
  `git commit -m "…⏎…" --no-verify`. This is NOT the continuation class above
  and the fold does not touch it: closing it needs quote-aware parsing, which is
  a loosening-shaped change to a security control and wants its own red-first
  cases in both directions.
- The hook still **over-blocks its own commit message** (see the previous
  section); the commit for this change had to be worded around rules 2c/2d.
  Measured, not assumed: `git commit -m "docs: git push --force main"`,
  `echo "git push --force origin main"` and a `gh pr create --body` containing
  the same literal all exit 2 on `main`'s hook *and* on this one — the class is
  pre-existing to rule 2, and rules 2c/2d simply add `git push --mirror` and
  `git push --force --all` to the set of literals you cannot quote. It fails in
  the SAFE direction (over-block), so it is recorded rather than fixed; the fix
  is the same quote-aware parsing the residual above is waiting on.

## 2026-08-30 — the user-alias residual closed, the merge help form unblocked, and the staging-evidence gh call bounded (SCRUM-3702, SCRUM-3656)

Three point fixes, each red-first in `block-pr-merge.test.sh` (26 cases failed
against the pre-fix hooks, verified in one run before any hook was touched;
suite is now 179 cases — review added 3: git resolves config section names
case-insensitively, probed live on git 2.50 (`--config-env=Alias.s=EV` and
`-c ALIAS.P=push` both work), so rule 4 matches `alias.` case-insensitively
and the normalizer's existing `IGNORECASE` handling of `-c ALIAS.…` is
pinned).

**The user-alias bypass is closed for every spelling the hook can read.**
`git -c alias.p=push p --force origin main` was ALLOWED: the normalizer
STRIPPED the definition as a global option, the rules saw `git p ...`, and `p`
only becomes `push` inside git — a fail-open bypass of the whole force-push
family behind one flag. `normalize-git-command.py` now COLLECTS
`-c alias.NAME=VALUE` definitions from the run it strips (attached `-calias.…`,
separated, and quoted forms; names case-insensitive) and, when the token in the
sub-command position names one of them, splices the alias's expansion in so the
rules see what git will actually run. Chains (`-c alias.a=b -c alias.b=push a`)
are followed, bounded at 10 steps; a `!shell` expansion is spliced verbatim so
the rules scan the shell text itself. `--config-env=alias.X=ENVVAR` hides the
expansion in an environment variable the hook cannot read, so rule 4 fails
CLOSED on that construction in the raw command (the normalizer never sees it:
it strips global options from `$norm`).

- **DO NOT touch `GUARDED_BUILTINS`** (`push`, `commit`) without re-reading
  this: git **ignores an alias that shadows a builtin** — verified against git
  2.50, `git -c alias.version=status version` prints the version — so
  `git -c alias.push=status push --force origin main` runs the REAL push.
  Substituting the shadowed verb away would make the resolver itself a
  laundering primitive. The skip applies at the invocation AND while following
  a chain (`-c alias.push=status -c alias.a=push a` expands `a` to the real
  push and blocks). Three cases pin it.
- **DO** keep substitution additive-only. A token that does not unquote to a
  clean alias name (`p$(x)`, escapes, globs) is left exactly as it was — the
  guard's verdict then falls back to today's behavior rather than guessing
  what the shell will expand.
- An alias **cycle** stops expanding and stays allowed; git refuses alias
  loops outright, so nothing runnable is lost. Wall-clocked cases pin the
  resolver against backtracking regressions (200 stacked definitions).

**Rule 1 got a token-exact help carve-out, and its anchor gained `(`.**
`gh pr merge --help` / `-h` is the read-only usage form and used to exit 2 —
the false-positive class from PR #1904 (any command merely CONTAINING the
merge string; writing prose that quotes it via heredoc was blocked live during
triage). The carve-out is deliberately narrow: `--help`/`-h` must be the token
IMMEDIATELY after `merge`, exact string compare, space/tab gap only, and EVERY
merge occurrence on the line must be the help form. Pinned blocked:
`--body --help` (a real merge whose body is "--help"), `--help=false`
(disables help; the merge runs), a newline before `--help` (command separator
— line one is a real merge), a quoted `"--help"`, and help followed by a real
merge after `&&`. Separately, `(gh pr merge 123 --squash)` returned exit 0
against the pre-fix anchor — `(` was not in the separator class — probed
2026-08-30 and closed.

**`check-staging-evidence-pre-merge.sh` can no longer hang the session.** Its
`gh pr view` calls ran unbounded inside a PreToolUse hook; the red run measured
a stalled `gh` wedging the hook >15s (it would sit as long as the network
did). Both calls now go through `bounded_gh` — `timeout(1)` where it exists,
perl's alarm+exec elsewhere (macOS ships no timeout; the alarm timer survives
execve), budget 10s, env-overridable for tests but capped ≤99s so the bound
cannot be configured away. A killed call yields an empty body and the
empty-body path DENIES: the timeout fails closed.

Residual list as of this change:

- The **`-c` user-alias residual is CLOSED** (this section). Definitions the
  hook cannot read stay closed by construction: `--config-env=alias.*` blocks
  outright (rule 4).
- **Quote/escape-mangled spellings** remain invisible to every text rule, with
  or without aliases: `git '-c' alias.p=push p …` (a QUOTED global option
  defeats the normalizer's token scan), a quoted or escaped verb
  (`git "push" …`), `$(…)` splices, and `GIT_CONFIG_PARAMETERS` /
  `GIT_CONFIG_COUNT` env-prefix config injection. All are the quote-aware
  parsing family already recorded above (the quoted-newline residual is one of
  them) and belong to the SCRUM-3713 parsed-{flags, refspecs} refactor — do
  not bolt partial quote handling onto individual rules.
- The **missing word boundary before `git`** still over-blocks, harmlessly,
  and is still deliberately left alone.
- The hook still **over-blocks its own commit message**, and the alias fix
  knowingly extends that accepted class: prose quoting the FULL bypass
  (`echo "git -c alias.p=push p --force origin main"`) now resolves inside the
  quotes and blocks. Safe direction, pinned as such in the suite.

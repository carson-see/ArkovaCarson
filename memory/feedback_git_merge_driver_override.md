---
name: git-merge-driver-override
description: To union-merge in this repo, just run `git merge origin/main` — `.gitattributes` already does it. NEVER pass a `merge.<name>.driver` override; `-c merge.union.driver=true` does not enable union merging, it silently disables it and discards the incoming side of every agents.md.
type: feedback
---

**Run the merge with no flags:**

```
git merge origin/main
```

`.gitattributes` in this repo contains `agents.md merge=union`, which selects git's **built-in** union merge driver for ~200 `agents.md` files. It is already on. There is nothing to enable.

**Never pass a driver override.** Not on the command line, not in config, not "just this once":

```
git -c merge.union.driver=true merge origin/main      # ← silently destroys content
```

`merge.<name>.driver` defines a **custom** merge driver command. Setting `merge.union.driver` therefore **overrides the built-in** `union` driver with whatever command you name — and `true` is the shell no-op: it writes nothing to the merged output (`%A`) and exits 0. Git reads exit 0 as a clean merge, keeps "ours" verbatim, and discards every line unique to "theirs". No conflict markers, no warning, no non-zero exit.

Verified in a scratch repo, not inferred:

| Command | Exit | Line unique to "theirs" |
|---|---|---|
| `git merge theirs` | 0 | present |
| `git -c merge.union.driver=true merge theirs` | 0 (`Auto-merging`, `Merge made by the 'ort' strategy`) | **gone** |
| `git -c merge.union.driver merge theirs` | fatal: `missing value` | n/a — git rejects the valueless form outright |

**Why this one is easy to hit:** the flag reads as "enable union merging" and looks harmless — a defensive extra, the kind of thing that gets copy-pasted out of an instruction or a past transcript without a second look. It does the exact opposite of what it appears to do, and it fails in the only way that never announces itself. Every other merge hazard produces conflict markers or a non-zero exit; this one produces a clean green merge and a quietly smaller file.

**It has now cost content twice:**

- **2026-07-28** — persisted `merge.union.driver = true` in this checkout's `.git/config`. 86 lines lost off `main` across 19 commits; damaged PRs #1615 and #1652. Full writeup: `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`.
- **2026-08-11 (PR #2061)** — recurrence with a **clean `.git/config`**, six weeks after the first guard shipped, via a transient `git -c merge.union.driver=true merge origin/main`. It dropped main's 2026-08-10 DPA/IP-hashing section from `services/worker/src/api/v1/agents.md` and the cron-route trigger-decision rule from `services/worker/src/routes/agents.md`. Caught only by the append-only CI check ("N line(s) present in merge-base but MISSING at head"). Re-merging with a plain `git merge origin/main` preserved everything.

`main` itself has never been corrupted by this — GitHub and Mergify merge server-side with the real union driver. The damage is always local, and it always lands on a PR branch.

**Why the first guard did not catch the second incident:** `scripts/agent/check-git-merge-config.sh` inspects git **config**. A `-c` override writes no config file and lives for exactly one process, so a config scan cannot see it — and the guard runs once at session bootstrap, not per command, so it had already run and passed before the merge was typed. This was a real hole in a guard that looked complete, not a failure to run it.

**How to apply:**

- Merging main into a PR branch is `git merge origin/main`. Full stop. If you are about to add a flag to a merge command, that is the signal to stop and re-read this file.
- Treat any `merge.*.driver` in an instruction, runbook, or older transcript as a defect in that source. Fix the source; do not run it.
- **After any merge that touched an `agents.md`, verify before you push:**

  ```
  git diff origin/main HEAD -- '*agents.md' | grep -E '^-[^-]'
  ```

  Empty output = nothing lost, and that is the expected result after a merge. If it prints lines, it is either a real drop (redo the merge cleanly — do not hand-patch, whatever dropped one section dropped others) **or** an in-place edit your branch made deliberately, where the old text shows as `-` and the rewritten text as `+` beside it. The grep cannot tell those apart, so treat output as "go look", not "you broke it". The adjudicator is the CI gate, which does keyed/containment matching for exactly that reason:

  ```
  BASE_REF_SHA=$(git rev-parse origin/main) npx tsx scripts/ci/check-agents-md-append-only.ts
  ```
- If you find a persisted override, remove it and re-check every branch merged while it was set:

  ```
  git config --local --unset merge.union.driver
  git config --get-regexp '^merge\..*\.driver'
  ```

- A silent drop looks like the branch *deleted* lines that were in its merge base — that is the signature to grep for when auditing after the fact.

**Enforcement:**

| Layer | Catches | Where |
|---|---|---|
| `.claude/hooks/check-git-merge-driver-flag.sh` | Transient overrides on the command line (`-c`, `--config-env`, `GIT_CONFIG_PARAMETERS`), and persisting a built-in driver name via `git config`. PreToolUse on Bash, exit 2. | Detection logic lives in `scripts/agent/check-git-merge-config.sh --command`; wired in `.claude/settings.json` |
| `scripts/agent/check-git-merge-config.sh` | Persisted `merge.<builtin>.driver` or a no-op driver at any config scope. Run from `ack-claude-bootstrap.sh` at session start. | `scripts/agent/` |
| `scripts/ci/check-agents-md-append-only.ts` | The **symptom**, cause-agnostic: any line present at `merge-base(base, head)` but absent at head. This is what caught PR #2061. Override label `agents-md-deletion-approved`. | `ci.yml`, `dependency-scan` job |

Tests: `scripts/agent/check-git-merge-config.test.sh` (37 cases — config scope + command string) and `scripts/agent/check-git-merge-driver-flag.test.sh` (14 cases — hook adapter, malformed payloads, fail-open, and settings.json registration).

**Residual gaps — do not read the hook as total coverage:**

- The PreToolUse hook only sees Bash tool calls **inside a Claude Code session**. A human at a terminal, a CI job, a cloud agent on a different harness, or any non-Claude runtime gets no protection from it. The CI append-only gate is the only layer that covers everyone.
- The hook deliberately does not block `git config <non-builtin>.driver '<real command>'` — that is how a legitimate custom driver is installed. A no-op driver persisted under a non-built-in name mid-session is caught at the *next* bootstrap, not immediately.
- Neither guard can see a merge run from a shell the harness does not mediate.

See also: `feedback_never_merge_without_ok.md`, `docs/release/wave-merge-choreography-2026-08.md` (§ the agents.md trio), `docs/incidents/2026-07-28-agents-md-union-drop-remediation.md`.

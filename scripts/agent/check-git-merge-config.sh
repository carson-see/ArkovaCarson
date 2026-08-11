#!/usr/bin/env bash
# scripts/agent/check-git-merge-config.sh
#
# Guard against a no-op custom merge driver shadowing a git BUILT-IN one.
#
# Root cause of the 2026-07-28 incident: this checkout's `.git/config` carried
#
#     [merge "union"]
#         driver = true
#
# `.gitattributes` declares `agents.md merge=union` for ~200 files. A custom
# driver of the same name OVERRIDES git's built-in union algorithm — and `true`
# is the shell no-op: it writes nothing to %A and exits 0, so git records a
# clean merge while keeping "ours" and silently discarding every line unique to
# "theirs". No conflict markers, no error, no exit code. Months of agents.md
# sections were lost that way (86 lines off main across 19 commits).
#
# The built-in driver names (union/text/binary) need NO driver config at all.
# Any `merge.<builtin>.driver` is therefore always wrong, and a no-op command
# for ANY driver name is always silent data loss.
#
# Reads git config only. Touches no remote, no evidence, no PR, no staging.
# Exit 0 = clean, 1 = dangerous config found.

set -uo pipefail

# Commands that "succeed" without ever writing the merged result to %A.
#
# Drivers are conventionally written with gitattributes(5) placeholders — e.g.
# `true %O %A %B` — so matching the bare word is not enough: `true` ignores its
# arguments and exits 0 either way. Compare only the command word, and treat
# `cat %A` alike (it prints ours to stdout and leaves %A untouched, which is
# the same silent keep-ours outcome).
is_noop_driver() {
  local cmd word
  # shellcheck disable=SC2001
  cmd=$(echo "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  case "$cmd" in
    'exit 0' | 'exit 0 '*) return 0 ;;
    'cat %A' | 'cat %A '*) return 0 ;;
  esac
  word=${cmd%%[[:space:]]*}
  case "$word" in
    true | /bin/true | /usr/bin/true | ':') return 0 ;;
    *) return 1 ;;
  esac
}

fix_hint() {
  cat <<EOF

  How to fix (removes the override; restores git's real built-in algorithm):

      git config --local --unset merge.$1.driver

  Then confirm nothing is left at any scope:

      git config --get-regexp '^merge\..*\.driver'

  Re-verify any branch merged while this was set — a silent drop looks like the
  branch DELETED lines that were in its merge base:

      node_modules/.bin/tsx scripts/ci/check-agents-md-append-only.ts
EOF
}

# ---------------------------------------------------------------------------
# Command-string mode: `check-git-merge-config.sh --command "<shell command>"`
#
# 2026-08-11, PR #2061: the SAME data loss recurred with a clean `.git/config`.
# The merge was run as
#
#     git -c merge.union.driver=true merge origin/main
#
# `-c` sets config for ONE invocation only — it writes no config file, so the
# config scan below sees nothing and passes, and the PreToolUse hook is not a
# child of that git process so `GIT_CONFIG_PARAMETERS` is not in its environment
# either. The override is invisible to every config-based check by construction.
# It dropped main's DPA/IP-hashing section from
# `services/worker/src/api/v1/agents.md` and the cron-route trigger-decision rule
# from `services/worker/src/routes/agents.md`; only the append-only CI gate
# caught it.
#
# Verified in a scratch repo: with `agents.md merge=union` in `.gitattributes`,
# `git -c merge.union.driver=true merge theirs` exits 0, prints "Auto-merging"
# and "Merge made by the 'ort' strategy", and the line unique to "theirs" is
# simply absent afterwards. Plain `git merge theirs` keeps it.
#
# Rule: a TRANSIENT driver override is rejected under any name. Legitimate
# custom drivers are configured persistently alongside `.gitattributes`, where
# the config scan below already adjudicates them on their merits (a real custom
# driver passes there). Nothing needs a one-shot driver override, so there is no
# false-positive case to protect.
#
# Deliberately NOT flagged: `git config <non-builtin>.driver <real command>`,
# which is how a legitimate driver is installed. Persisting a BUILT-IN name is
# flagged, because that is never right whatever the command does.
scan_command_string() {
  local raw="$1" cmd offenders

  [[ -z "$raw" ]] && return 0

  # A heredoc BODY is data being written, not a command being run. Writing about
  # this bug — a commit message, a runbook, an incident note that quotes the
  # offending command — must not be blocked by the guard against it, or people
  # route around the guard and it stops protecting anything. Found by
  # dogfooding: the commit that introduced this hook was blocked by its own
  # commit message. Everything OUTSIDE a heredoc, before or after, is still
  # scanned, so an override that actually executes is still caught.
  raw=$(printf '%s\n' "$raw" | awk '
    !inhd {
      if (match($0, /<<-?[ \t]*[^ \t;&|<>()]+/)) {
        tag = substr($0, RSTART, RLENGTH)
        sub(/^<<-?[ \t]*/, "", tag)
        gsub(/[\047"]/, "", tag)          # \047 = single quote
        if (tag ~ /^[A-Za-z_][A-Za-z0-9_]*$/) { inhd = 1; hdtag = tag }
      }
      print; next
    }
    {
      t = $0
      sub(/^[ \t]+/, "", t); sub(/[ \t]+$/, "", t)
      if (t == hdtag) { inhd = 0; hdtag = "" }
      next
    }
  ')

  # Normalize shell quoting so `-c 'merge.union.driver=true'`, `-c
  # merge.union.driver='true %O %A %B'` and the bare form all match alike.
  cmd=$(printf '%s' "$raw" | tr -d "\"'")

  # 1. Transient per-invocation override: -c / --config-env / the env var git
  #    itself uses to pass -c down to subprocesses.
  # `--` terminates grep's own option parsing: BSD grep reads a pattern that
  # starts with `--config-env` as a (bogus) long flag and aborts otherwise.
  if printf '%s' "$cmd" | grep -qE -- '(^|[[:space:]])-c[[:space:]]*merge\.[A-Za-z0-9._-]+\.driver' \
     || printf '%s' "$cmd" | grep -qE -- '--config-env[=[:space:]]merge\.[A-Za-z0-9._-]+\.driver' \
     || printf '%s' "$cmd" | grep -qE -- 'GIT_CONFIG_PARAMETERS=.*merge\.[A-Za-z0-9._-]+\.driver'; then
    offenders=$(printf '%s' "$cmd" | grep -oE -- 'merge\.[A-Za-z0-9._-]+\.driver[^[:space:]]*' | sort -u | tr '\n' ' ')
    echo "ERROR: transient merge-driver override on the command line: ${offenders}" >&2
    echo "  A per-invocation driver override REPLACES git's algorithm for every" >&2
    echo "  path with a matching 'merge=' attribute (this repo: agents.md, ~200" >&2
    echo "  files). If the command is a no-op such as 'true', git records a clean" >&2
    echo "  merge, keeps \"ours\", and silently discards \"theirs\" — no conflict," >&2
    echo "  no warning, exit 0. This is the 2026-08-11 PR #2061 content loss." >&2
    cat >&2 <<'EOF'

  To union-merge in this repo, just run the merge with NO override:

      git merge origin/main

  `.gitattributes` already declares `agents.md merge=union`, so git's BUILT-IN
  union driver is applied automatically. The flag does not enable union
  merging — it disables it.

  After any merge that touched an agents.md, confirm nothing was dropped:

      git diff origin/main HEAD -- '*agents.md' | grep -E '^-[^-]'

  Empty output = no content lost. Output means "go look", not "you broke it" —
  an in-place edit shows the old line as '-' too. The adjudicator, which does
  keyed/containment matching to avoid that false positive:

      BASE_REF_SHA=$(git rev-parse origin/main) \
        npx tsx scripts/ci/check-agents-md-append-only.ts
EOF
    return 1
  fi

  # 2. Persisting a BUILT-IN driver name via `git config`. Reads and unsets are
  #    explicitly allowed — fix_hint() tells the operator to run exactly those.
  if printf '%s' "$cmd" | grep -qE -- 'git[[:space:]]+config' \
     && printf '%s' "$cmd" | grep -qE -- 'merge\.(union|text|binary)\.driver' \
     && ! printf '%s' "$cmd" | grep -qE -- '(--unset|--get|--list|--show-origin|--edit|[[:space:]]-e[[:space:]])'; then
    echo "ERROR: this defines a git BUILT-IN merge driver in config." >&2
    echo "  'union', 'text' and 'binary' are built into git and need NO driver" >&2
    echo "  config. Defining one OVERRIDES the real algorithm for every path with" >&2
    echo "  that merge attribute — the 2026-07-28 incident, in persistent form." >&2
    echo "  Remove the driver name, or pick a name that is not a built-in." >&2
    return 1
  fi

  return 0
}

mode="config"
command_string=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --command)
      mode="command"
      command_string="${2:-}"
      shift
      [[ $# -gt 0 ]] && shift
      ;;
    --command=*)
      mode="command"
      command_string="${1#--command=}"
      shift
      ;;
    -h | --help)
      echo "usage: check-git-merge-config.sh [--command '<shell command>']"
      echo "  no args    scan git config at every scope (session bootstrap)"
      echo "  --command  scan one shell command for transient driver overrides"
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

if [[ "$mode" == "command" ]]; then
  scan_command_string "$command_string"
  exit $?
fi

violations=0

# --show-origin so the operator knows WHICH config file to edit (local/global/system).
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  origin=${line%%$'\t'*}
  kv=${line#*$'\t'}
  key=${kv%% *}
  value=${kv#* }
  [[ "$key" == "$value" ]] && value=""

  driver_name=${key#merge.}
  driver_name=${driver_name%.driver}

  # Naming a built-in is always wrong, whatever the command does.
  case "$driver_name" in
    union | text | binary)
      echo "ERROR: '${key} = ${value}' in ${origin}" >&2
      echo "  '${driver_name}' is a git BUILT-IN merge driver. Defining it in config" >&2
      echo "  overrides the real algorithm for every path with 'merge=${driver_name}'" >&2
      echo "  in .gitattributes (this repo: agents.md, ~200 files)." >&2
      if is_noop_driver "$value"; then
        echo "  '${value}' is a NO-OP: it writes no merged content and exits 0," >&2
        echo "  so git reports a clean merge while discarding all of \"theirs\"." >&2
      fi
      fix_hint "$driver_name" >&2
      violations=$((violations + 1))
      continue
      ;;
  esac

  # Non-built-in name, but a no-op command is silent data loss regardless.
  if is_noop_driver "$value"; then
    echo "ERROR: '${key} = ${value}' in ${origin}" >&2
    echo "  '${value}' never writes the merged result to %A but exits 0 — git will" >&2
    echo "  record a clean merge and silently keep \"ours\", discarding \"theirs\"." >&2
    fix_hint "$driver_name" >&2
    violations=$((violations + 1))
  fi
done < <(git config --show-origin --get-regexp '^merge\..*\.driver' 2>/dev/null || true)

if [[ "$violations" -gt 0 ]]; then
  echo "" >&2
  echo "check-git-merge-config: ${violations} dangerous merge-driver config(s)." >&2
  exit 1
fi

echo "check-git-merge-config: OK (no built-in-shadowing or no-op merge drivers)"

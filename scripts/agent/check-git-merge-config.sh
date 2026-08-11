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
# THE CORRECT COMMAND IS A PLAIN `git merge origin/main`. `.gitattributes`
# (`agents.md merge=union`) plus git's BUILT-IN union driver already combine
# both sides. Any `merge.union.driver` value makes it worse, never better.
#
# ── What this script can and cannot see ──────────────────────────────────────
#
# It reads git CONFIG. That covers the persisted forms at every scope, and — via
# `git config`'s own resolution — the ENV-injected forms GIT_CONFIG_PARAMETERS
# and GIT_CONFIG_COUNT/KEY_n/VALUE_n, which surface with origin `command line:`.
#
# It CANNOT see a one-off flag passed to a DIFFERENT process:
#
#     git -c merge.union.driver=true merge origin/main
#     git --config-env=merge.union.driver=VAR merge origin/main
#
# Those have exactly the effect of the persisted entry and write nothing for a
# sibling process to find. PR #2060 lost 100 lines of main's agents.md that way
# on 2026-08-11, minutes after this guard printed OK at session start.
#
# Two layers close that, neither of them a change to the logic below — both just
# ask this same question somewhere it can be answered:
#   * `.githooks/pre-merge-commit` runs this guard as a SUBPROCESS OF GIT, which
#     hands it the flags as GIT_CONFIG_PARAMETERS, and aborts the merge.
#   * `.claude/hooks/block-unsafe-git-merge.sh` refuses the command outright.
# `scripts/ci/check-agents-md-append-only.ts` remains the cause-agnostic backstop.
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

# Origin `command line:` is git's label for BOTH `-c` / `--config-env` flags and
# GIT_CONFIG_PARAMETERS / GIT_CONFIG_KEY_n in the environment. There is no file
# holding it, so `--unset` has nothing to remove — telling someone to run it
# sends them chasing a config entry that does not exist while the real cause is
# sitting in the command they just typed.
fix_hint() {
  local driver_name="$1" origin="${2:-}"

  if [[ "$origin" == "command line:"* ]]; then
    cat <<EOF

  This came from the COMMAND, not from any config file — there is nothing to
  unset. Drop the injection:

      -c merge.${driver_name}.driver=…
      --config-env=merge.${driver_name}.driver=…
      GIT_CONFIG_PARAMETERS=… / GIT_CONFIG_COUNT + GIT_CONFIG_KEY_n/VALUE_n

  The correct command is a plain:

      git merge origin/main

  \`.gitattributes\` (\`agents.md merge=union\`) plus git's BUILT-IN union driver
  already combine both sides. Any \`merge.union.driver\` value makes it worse.
EOF
  else
    cat <<EOF

  How to fix (removes the override; restores git's real built-in algorithm):

      git config --local --unset merge.${driver_name}.driver

  Then confirm nothing is left at any scope:

      git config --get-regexp '^merge\..*\.driver'
EOF
  fi

  cat <<EOF

  Re-verify any branch merged while this was in effect — a silent drop looks
  like the branch DELETED lines that were in its merge base:

      node_modules/.bin/tsx scripts/ci/check-agents-md-append-only.ts
EOF
}

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
      fix_hint "$driver_name" "$origin" >&2
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

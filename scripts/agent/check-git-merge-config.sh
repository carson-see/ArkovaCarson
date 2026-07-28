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

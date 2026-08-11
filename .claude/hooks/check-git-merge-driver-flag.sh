#!/usr/bin/env bash
# .claude/hooks/check-git-merge-driver-flag.sh
#
# PreToolUse hook on Bash. Blocks a git invocation that carries a TRANSIENT
# merge-driver override (`-c merge.<name>.driver=…`, `--config-env`, or
# `GIT_CONFIG_PARAMETERS`). Exit 2 + stderr blocks the call.
#
# Why a second guard when scripts/agent/check-git-merge-config.sh already
# exists: that one reads git CONFIG, and it runs once, from
# ack-claude-bootstrap.sh, at session start. A `-c` override writes no config
# file and lives for exactly one process, so it is invisible to a config scan by
# construction — and this hook is not a child of the git process, so the
# GIT_CONFIG_PARAMETERS that `-c` sets is not in its environment either. Only
# the command STRING reveals it, and PreToolUse is the only place that string is
# available before the merge runs.
#
# That gap is not theoretical: it cost real content on 2026-08-11 (PR #2061)
# with a clean .git/config, six weeks after the config-scope guard shipped for
# the 2026-07-28 incident.
#
# Detection logic is NOT duplicated here — it lives in the guard's --command
# mode so that one bash test suite covers both entry points.

set -u

input="$(cat)"
cmd="$(printf '%s' "$input" | /usr/bin/python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except: pass' 2>/dev/null || true)"

[ -z "$cmd" ] && exit 0

# Cheap pre-filter: the overwhelming majority of Bash calls never mention a
# merge driver, and this hook runs on every one of them.
printf '%s' "$cmd" | /usr/bin/grep -q 'driver' || exit 0

hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
guard="${hook_dir%/.claude/hooks}/scripts/agent/check-git-merge-config.sh"

# Fail OPEN if the guard is missing rather than bricking every Bash call in a
# checkout that predates it. The append-only agents.md CI gate is the backstop.
[ -x "$guard" ] || exit 0

if ! output="$("$guard" --command "$cmd" 2>&1)"; then
  printf 'BLOCKED by .claude/hooks/check-git-merge-driver-flag.sh\n\n%s\n' "$output" >&2
  exit 2
fi

exit 0

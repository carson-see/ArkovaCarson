#!/usr/bin/env python3
"""Strip git's global options so its sub-command is adjacent to `git` again.

Reads the command line from the ARKOVA_HOOK_CMD environment variable (never
from argv, so nothing in the command can be read as an option to this script)
and prints the normalized form on stdout.

Used by .claude/hooks/block-pr-merge.sh. Every rule in that hook anchors on the
sub-command sitting IMMEDIATELY after `git` -- `git[[:space:]]+(push|commit)` --
but git accepts its global options in between, and each one splits the token run
so the guard silently does not fire. Observed empirically 2026-08-11:

    git -c user.email=a@b.c -c user.name=x commit -q -m probe --no-verify

ran to completion in a live session with the hook active. Same bug class as the
union merge-driver trap (see the 2026-07-28 section of scripts/agent/agents.md)
and the supabase global-flag bypass pinned in
scripts/agent/check-claude-bootstrap.test.sh.

This NORMALIZES rather than dropping the hook's adjacency anchor. An anchorless
regex would block every line that merely MENTIONS "push --force ... main" --
commit messages, docs, echoes. Both directions are pinned by
scripts/agent/block-pr-merge.test.sh; do not relax either one.

This lives in its own file on purpose. It was first written as a heredoc nested
inside a command substitution inside a double-quoted assignment; that construct
is one stray character away from making bash consume to EOF, which takes down
every Bash tool call in the session the hook is supposed to be protecting. A
temp-file-and-execute variant avoids the parse fragility but adds a disk write
plus an exec to a security control. A committed sibling file has neither
problem and is independently testable.
"""

import os
import re
import sys

# A shell word. Quoted runs count as part of one word, so a value such as
# user.name="Claude Bot" is consumed whole rather than stopping at the space and
# leaving the scan stranded mid-option. The three alternatives are mutually
# exclusive at every position (a character either opens a quote or does not), so
# a word has exactly one parse and the nested repeats below cannot backtrack
# exponentially -- verified to 200 repeats across six adversarial shapes, and
# pinned by the bounded cases in block-pr-merge.test.sh.
WORD = r'(?:"[^"]*"|\'[^\']*\'|[^\s"\'])+'

# git's global options that take a value, attached or separated.
VAL = (r'(?:--git-dir|--work-tree|--namespace|--config-env|--exec-path'
       r'|--attr-source|--super-prefix|-C|-c)')

# One leading global-option token, most specific form first. The last
# alternative treats any other leading -flag as a boolean, so a global option
# added to git later is stripped too (fail closed) rather than splitting the run
# and re-opening the hole. A non-flag token -- the sub-command -- matches
# nothing and ends the scan.
TOKEN = ('(?:'
         + VAL + '=' + WORD + r'?\s+'          # --git-dir=/p, --config-env=n=EV
         + '|-[cC]' + WORD + r'\s+'            # -ck=v, -C/path (attached short)
         + '|' + VAL + r'\s+' + WORD + r'\s+'  # -c k=v, --git-dir /p (separated)
         + '|--?[A-Za-z]' + WORD + r'?\s+'     # --no-pager, -P (boolean)
         + ')')

PATTERN = re.compile(r'\bgit\s+(?:' + TOKEN + ')+')


def normalize(cmd: str) -> str:
    return PATTERN.sub('git ', cmd)


def main() -> int:
    sys.stdout.write(normalize(os.environ.get('ARKOVA_HOOK_CMD', '')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

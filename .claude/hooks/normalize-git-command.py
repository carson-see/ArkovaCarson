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

TRANSIENT ALIASES ARE RESOLVED, NOT JUST STRIPPED (SCRUM-3702). Stripping
`-c alias.p=push` used to LAUNDER the definition: the rules then saw `git p
--force origin main`, and `p` only becomes `push` inside git -- a fail-open
bypass of the whole force-push family behind one global option. Now every
`-c alias.NAME=VALUE` in the stripped run is collected, and when the token in
the sub-command position names one of them, the alias's expansion is spliced
in so the rules see what git will actually run. Three deliberate edges, each
pinned by block-pr-merge.test.sh:

  * `push` and `commit` are never substituted, at the invocation NOR while
    following an alias-to-alias chain. git IGNORES an alias that shadows a
    builtin, so `git -c alias.push=status push --force origin main` runs the
    REAL push -- substituting it away would turn the resolver itself into a
    laundering primitive. (Verified against git 2.50: the shadowing alias is
    silently ignored.)
  * Chains (`-c alias.a=b -c alias.b=push a`) are followed a bounded number
    of steps; a cycle stops expanding, which is safe because git refuses to
    run an alias loop at all.
  * A `!shell` expansion is spliced in verbatim: the rules then scan the
    shell text itself, which is the blocking direction.

`--config-env=alias.X=ENVVAR` defines an alias whose expansion lives in an
environment variable this script cannot read. It is NOT collected here; the
hook blocks that construction outright (fail closed) on the raw command.

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

WORD_RE = re.compile(WORD)

# A transient alias definition carried by -c: alias.<name>=<expansion>. git
# config keys are case-insensitive; alias names are alphanumeric-plus-dash.
ALIAS_DEF_RE = re.compile(r'alias\.([A-Za-z][A-Za-z0-9-]*)=(.*)',
                          re.IGNORECASE | re.DOTALL)

# The shape a clean alias INVOCATION token must have after unquoting. Anything
# else (globs, $(...), escapes) is left untouched: substitution is only ever an
# ADDITIVE strictness on top of the pre-alias behavior, never a rewrite of a
# token whose shell expansion this script cannot know. That family of mangled
# spellings defeats every text rule in the hook with or without aliases and is
# recorded as a residual in scripts/agent/agents.md.
ALIAS_NAME_RE = re.compile(r'[A-Za-z][A-Za-z0-9-]*\Z')

# The invocation token itself: quoted runs allowed (`"p"` is `p` to bash), and
# a bare run stops where bash would end the word -- whitespace, quotes, or a
# shell operator -- so `fp;echo` reads as `fp`, exactly as bash tokenizes it.
INVOC_RE = re.compile(r'(?:"[^"]*"|\'[^\']*\'|[^\s"\';&|<>(){}`])+')

# git ignores an alias that shadows a builtin. Only the verbs the hook's rules
# anchor on need protecting from substitution; for any other shadowed builtin a
# substitution can only over-block nonsense input, which fails safe.
GUARDED_BUILTINS = frozenset(('push', 'commit'))

# Value-taking global options whose SEPARATED value word must be skipped while
# scanning for alias definitions, so a path or key that merely LOOKS like `-c
# alias...` (e.g. `git -C -calias.p=push ...`, a directory name) is never
# collected as one.
SEPARATED_VAL_OPTS = frozenset(('--git-dir', '--work-tree', '--namespace',
                                '--config-env', '--exec-path', '--attr-source',
                                '--super-prefix', '-C'))


def _unquote(word: str) -> str:
    """Concatenate the contents of a word's bare and quoted segments,
    mirroring WORD's own three-alternative segmentation."""
    out = []
    i = 0
    n = len(word)
    while i < n:
        ch = word[i]
        if ch in ('"', "'"):
            j = word.find(ch, i + 1)
            if j == -1:  # unterminated quote: keep the tail verbatim
                out.append(word[i + 1:])
                break
            out.append(word[i + 1:j])
            i = j + 1
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def _alias_definitions(options_run: str) -> dict:
    """Collect alias.NAME=VALUE pairs defined via -c inside one matched run
    of git global options. Names are lowercased (git config keys are
    case-insensitive)."""
    aliases = {}
    words = WORD_RE.findall(options_run)
    i = 0
    while i < len(words):
        w = words[i]
        value_word = None
        if w == '-c':
            if i + 1 < len(words):
                value_word = words[i + 1]
            i += 2
        elif w.startswith('-c') and len(w) > 2:
            value_word = w[2:]
            i += 1
        elif w in SEPARATED_VAL_OPTS:
            i += 2  # skip the option's own value word
        else:
            i += 1
        if value_word is None:
            continue
        m = ALIAS_DEF_RE.fullmatch(_unquote(value_word))
        if m:
            aliases[m.group(1).lower()] = m.group(2)
    return aliases


def _expand(name: str, aliases: dict) -> str:
    """Expand an alias, following alias-to-alias chains a bounded number of
    steps. Stops at a guarded builtin (git ignores the shadowing alias, so
    the builtin is what runs), at a `!shell` expansion (returned verbatim so
    the rules scan the shell text), and on a cycle (git refuses alias loops,
    so nothing runnable is lost by leaving the name in place)."""
    expansion = aliases[name]
    for _ in range(10):
        if expansion.startswith('!'):
            break
        head, _sep, tail = expansion.partition(' ')
        head_l = head.lower()
        if head_l in GUARDED_BUILTINS:
            break
        nxt = aliases.get(head_l)
        if nxt is None:
            break
        expansion = nxt + (' ' + tail if tail else '')
    return expansion


def normalize(cmd: str) -> str:
    out = []
    pos = 0
    for m in PATTERN.finditer(cmd):
        out.append(cmd[pos:m.start()])
        out.append('git ')
        pos = m.end()
        aliases = _alias_definitions(m.group(0))
        if aliases:
            w = INVOC_RE.match(cmd, pos)
            if w:
                name = _unquote(w.group(0)).lower()
                if (ALIAS_NAME_RE.fullmatch(name)
                        and name in aliases
                        and name not in GUARDED_BUILTINS):
                    out.append(_expand(name, aliases))
                    pos = w.end()
    out.append(cmd[pos:])
    return ''.join(out)


def main() -> int:
    sys.stdout.write(normalize(os.environ.get('ARKOVA_HOOK_CMD', '')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

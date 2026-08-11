#!/usr/bin/env bash
# scripts/agent/install-git-merge-hooks.sh
#
# Makes `.githooks/pre-merge-commit` actually run, by dropping a one-line shim
# into whatever hooks directory this checkout resolves to.
#
# `.githooks/` is tracked, but nothing runs it unless `core.hooksPath` points
# there — and in this repo it does not: `core.hooksPath` is set to the absolute
# `.git/hooks`, which contains only git's `.sample` files. So `.githooks/`
# has been inert. Rather than repoint `core.hooksPath` (which would silently
# switch on `.githooks/pre-commit`, a full `tsc --noEmit` + `npm run lint` on
# every commit, for everyone, as a side effect of a merge-safety fix), this
# installs the single merge hook into the resolved directory and leaves every
# other hook's behaviour exactly as it is.
#
# Called by scripts/agent/ack-claude-bootstrap.sh, so every session — and every
# worktree, since `--git-path hooks` resolves to the SHARED common dir — gets it.
#
# ALWAYS exits 0. Bootstrap must not be bricked by hook installation; an
# unwritable or foreign hooks path is a warning, not a failed session start.
# Tests: scripts/agent/check-unsafe-git-merge.test.sh (section 5).

set -uo pipefail

MARKER='# arkova-managed shim: scripts/agent/install-git-merge-hooks.sh'

root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$root" ]]; then
  echo "install-git-merge-hooks: not inside a git repo — nothing to do." >&2
  exit 0
fi

# Honours core.hooksPath, and returns the shared common dir in a worktree, which
# is what we want: one install covers every worktree of this checkout.
hooks_rel=$(git -C "$root" rev-parse --git-path hooks 2>/dev/null || true)
if [[ -z "$hooks_rel" ]]; then
  echo "install-git-merge-hooks: could not resolve the hooks path — skipped." >&2
  exit 0
fi
if [[ "$hooks_rel" = /* ]]; then
  hooks_dir="$hooks_rel"
else
  hooks_dir="${root}/${hooks_rel}"
fi

# Already pointed at the tracked directory: the hook is live from the repo
# itself, and copying it into .git/hooks would fork a second copy that stops
# tracking edits to the real one.
tracked_hooks=$(cd "$root/.githooks" 2>/dev/null && pwd -P || true)
resolved_hooks=$(cd "$hooks_dir" 2>/dev/null && pwd -P || true)
if [[ -n "$tracked_hooks" && "$resolved_hooks" == "$tracked_hooks" ]]; then
  echo "install-git-merge-hooks: core.hooksPath already points at .githooks — nothing to do."
  exit 0
fi

if ! mkdir -p "$hooks_dir" 2>/dev/null; then
  echo "install-git-merge-hooks: cannot create ${hooks_dir} — skipped." >&2
  echo "  .githooks/pre-merge-commit is therefore NOT active in this checkout." >&2
  exit 0
fi

target="${hooks_dir}/pre-merge-commit"

# Never clobber a hook we did not write. Five worktrees share this directory;
# silently overwriting someone else's hook would be a quieter version of the
# data-loss bug this exists to prevent.
if [[ -e "$target" ]] && ! grep -qF "$MARKER" "$target" 2>/dev/null; then
  echo "install-git-merge-hooks: ${target} already exists and is not ours." >&2
  echo "  The merge-driver guard is NOT installed. Either fold this into it:" >&2
  echo "      exec \"\$(git rev-parse --show-toplevel)/.githooks/pre-merge-commit\" \"\$@\"" >&2
  echo "  or move the existing hook aside and re-run this script." >&2
  exit 0
fi

# The shim only dispatches; the guard logic lives in the tracked hook so it
# stays reviewable and versioned.
#
# It passes SILENTLY when the tracked hook is absent, which is the one place
# here that deliberately does not shout. This directory is shared by every
# worktree of the checkout, so the shim also runs on branches whose revision
# predates `.githooks/pre-merge-commit` — an older tree, not an anomaly.
# Warning on every merge in every unrelated worktree would train people to
# ignore hook output, which costs more than it buys. The case that DOES mean
# something is wrong — the hook present but the GUARD missing — fails closed
# inside the tracked hook itself.
new_content=$(
  cat <<EOF
#!/usr/bin/env bash
${MARKER}
# Do not edit here — edit .githooks/pre-merge-commit and re-run the installer.
root=\$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
hook="\${root}/.githooks/pre-merge-commit"
[ -x "\$hook" ] || exit 0
exec "\$hook" "\$@"
EOF
)

if [[ -f "$target" ]] && [[ "$(cat "$target" 2>/dev/null)" == "$new_content" ]]; then
  exit 0 # already current; stay quiet so session start is not noisy
fi

# Write via temp + mv: parallel worktrees can run bootstrap at the same moment.
tmp="${target}.tmp.$$"
if ! printf '%s\n' "$new_content" >"$tmp" 2>/dev/null; then
  rm -f "$tmp"
  echo "install-git-merge-hooks: cannot write ${target} — skipped." >&2
  exit 0
fi
chmod +x "$tmp" 2>/dev/null || true
if ! mv -f "$tmp" "$target" 2>/dev/null; then
  rm -f "$tmp"
  echo "install-git-merge-hooks: cannot install ${target} — skipped." >&2
  exit 0
fi

echo "install-git-merge-hooks: installed ${target} (merge-driver guard active)."
exit 0

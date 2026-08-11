#!/usr/bin/env bash
# scripts/agent/ack-claude-bootstrap.sh
#
# Acknowledge that the current session/worktree has read the current CLAUDE.md.
# The hook stores only the CLAUDE.md SHA-256 in .git-local state; no evidence
# docs, Jira, Confluence, GitHub PR bodies, staging, or production resources are
# touched.

set -euo pipefail

hash_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -r "$file" | awk '{print $1}'
    return 0
  fi
  echo "ERROR: shasum, sha256sum, or openssl is required to hash CLAUDE.md" >&2
  return 1
}

resolve_repo_root() {
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" && -d "${CLAUDE_PROJECT_DIR}" ]]; then
    (cd "${CLAUDE_PROJECT_DIR}" && pwd -P)
    return 0
  fi
  git rev-parse --show-toplevel 2>/dev/null || {
    echo "ERROR: run from inside the Arkova git repo or set CLAUDE_PROJECT_DIR" >&2
    return 1
  }
}

resolve_state_dir() {
  local repo_root="$1"
  local git_dir

  if [[ -n "${ARKOVA_CLAUDE_BOOTSTRAP_STATE_DIR:-}" ]]; then
    printf '%s\n' "${ARKOVA_CLAUDE_BOOTSTRAP_STATE_DIR}"
    return 0
  fi

  git_dir=$(git -C "$repo_root" rev-parse --git-dir 2>/dev/null || true)
  if [[ -z "$git_dir" ]]; then
    echo "ERROR: could not resolve git state dir for ${repo_root}" >&2
    return 1
  fi
  if [[ "$git_dir" = /* ]]; then
    printf '%s\n' "$git_dir"
  else
    printf '%s\n' "${repo_root}/${git_dir}"
  fi
}

repo_root=$(resolve_repo_root)
claude_md="${repo_root}/CLAUDE.md"
if [[ ! -f "$claude_md" ]]; then
  echo "ERROR: CLAUDE.md not found at ${claude_md}" >&2
  exit 1
fi

state_dir=$(resolve_state_dir "$repo_root")
mkdir -p "$state_dir"
state_file="${state_dir}/arkova-claude-bootstrap-ack"
tmp_file=$(mktemp "${state_file}.XXXXXX")
claude_hash=$(hash_file "$claude_md")
ack_time=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

cat >"$tmp_file" <<EOF
version=1
claude_md_sha256=${claude_hash}
acknowledged_at_utc=${ack_time}
repo_root=${repo_root}
EOF

mv "$tmp_file" "$state_file"
chmod 600 "$state_file" 2>/dev/null || true

echo "CLAUDE.md acknowledged ${claude_hash} at ${ack_time}"

# Session-start guard for the 2026-07-28 silent-merge-corruption class; the
# failure is described in full in check-git-merge-config.sh. It runs HERE
# because the offending setting lives in uncommitted .git/config, which CI
# cannot see — only a per-checkout check catches it, and it has to fire before
# the session's first merge.
merge_config_check="${repo_root}/scripts/agent/check-git-merge-config.sh"
if [[ -x "$merge_config_check" ]]; then
  "$merge_config_check" || exit 1
fi

# That guard reads CONFIG, so it is structurally blind to the one-off form of
# the same thing — `git -c merge.union.driver=true merge origin/main` writes
# nothing anywhere, and dropped 100 lines of main's agents.md on PR #2060
# minutes after the check above printed OK. `.githooks/pre-merge-commit` re-runs
# the guard as a subprocess of git, which is where the flag IS visible, and
# aborts the merge. Installing it here means it is live from the first session
# in a fresh clone rather than depending on someone reading a setup doc.
#
# Never fatal: hook installation must not be able to brick session bootstrap.
merge_hook_install="${repo_root}/scripts/agent/install-git-merge-hooks.sh"
if [[ -x "$merge_hook_install" ]]; then
  "$merge_hook_install" || true
fi

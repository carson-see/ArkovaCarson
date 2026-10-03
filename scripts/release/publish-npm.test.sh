#!/usr/bin/env bash
# Exercise the real manual publisher against a disposable package tree and a
# controlled npm executable. No registry connection or publication is possible.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/arkova-publish-npm-test-XXXXXX)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/scripts/release" "$fixture/packages/sdk" "$fixture/sdks/mcp-server" "$fixture/bin"
cp "$repo_root/scripts/release/publish-npm.sh" "$fixture/scripts/release/publish-npm.sh"

cat > "$fixture/bin/npm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$NPM_FIXTURE_LOG"
case "$1" in
  whoami) printf '%s\n' 'synthetic-owner' ;;
  view)
    if [[ "$NPM_FIXTURE_MODE" == auth ]]; then
      printf '%s\n' 'npm error code E403' >&2; exit 1
    fi
    if [[ "$NPM_FIXTURE_MODE" == network ]]; then
      printf '%s\n' 'npm error code ETIMEDOUT' >&2; exit 1
    fi
    if [[ "$NPM_FIXTURE_MODE" == missing ]]; then
      printf '%s\n' 'npm error code E404' >&2; exit 1
    fi
    if [[ "$2" == arkova && "$3" == versions && "${4:-}" == --json ]]; then
      if [[ "$NPM_FIXTURE_MODE" == malformed ]]; then printf '%s\n' '{broken';
      elif [[ "$NPM_FIXTURE_MODE" == string ]]; then printf '%s\n' '"registry unavailable"';
      elif [[ "$NPM_FIXTURE_MODE" == badentry ]]; then printf '%s\n' '["2.2.0","registry unavailable"]';
      else printf '%s\n' '["2.2.0","3.1.0"]'; fi
    elif [[ "$2" == arkova@2.2.0 && "$3" == version && "${4:-}" == --json ]]; then
      printf '%s\n' '"2.2.0"'
    elif [[ "$2" == arkova@3.3.0 && "$3" == version && "${4:-}" == --json ]]; then
      if [[ "$NPM_FIXTURE_MODE" == readback_error || ! -f "$NPM_FIXTURE_PUBLISHED" ]]; then
        printf '%s\n' 'npm error code E404' >&2; exit 1
      fi
      if [[ "$NPM_FIXTURE_MODE" == readback_wrong ]]; then printf '%s\n' '"3.1.0"';
      else printf '%s\n' '"3.3.0"'; fi
    elif [[ "$2" == arkova && "$3" == version ]]; then
      # Legacy latest-only lookup: this keeps the red regression deterministic.
      printf '%s\n' '3.1.0'
    else
      printf '%s\n' 'unexpected registry query' >&2; exit 99
    fi ;;
  publish) : > "$NPM_FIXTURE_PUBLISHED" ;;
  ci|test|run|pack) : ;;
  *) printf '%s\n' 'unexpected npm command' >&2; exit 99 ;;
esac
MOCK
chmod +x "$fixture/bin/npm"

write_manifest() {
  printf '{"name":"arkova","version":"%s","scripts":{"typecheck":"tsc"}}\n' "$1" > "$fixture/packages/sdk/package.json"
  printf '{"name":"arkova-mcp-server","version":"3.3.0"}\n' > "$fixture/sdks/mcp-server/package.json"
}
run_case() {
  local invocation="${2:-dry-run}" args=(--only=sdk)
  if [[ "$invocation" == dry-run ]]; then args+=(--dry-run); fi
  : > "$fixture/npm.log"
  rm -f "$fixture/published"
  if PATH="$fixture/bin:$PATH" NPM_FIXTURE_LOG="$fixture/npm.log" NPM_FIXTURE_PUBLISHED="$fixture/published" NPM_FIXTURE_MODE="$1" \
      bash "$fixture/scripts/release/publish-npm.sh" "${args[@]}" > "$fixture/out" 2> "$fixture/err"; then
    return 0
  fi
  return 1
}
assert_no_build_or_publish() {
  if grep -Eq '^(ci|test|run|pack|publish)( |$)' "$fixture/npm.log"; then
    printf '%s\n' 'unexpected build or publication after registry decision' >&2; exit 1
  fi
}

# A historical version is published even though a different version is latest.
write_manifest '2.2.0'
run_case ok
grep -Fqx 'view arkova versions --json' "$fixture/npm.log"
grep -Fq 'already live on npm' "$fixture/out"
assert_no_build_or_publish

# A live historical skip never republishes and confirms its exact version.
run_case ok live
grep -Fqx 'view arkova@2.2.0 version --json' "$fixture/npm.log"
grep -Fq 'confirmed arkova@2.2.0' "$fixture/out"
assert_no_build_or_publish

# A truly absent candidate can proceed through the dry-run build without publish.
write_manifest '3.3.0'
run_case ok
grep -Fqx 'view arkova versions --json' "$fixture/npm.log"
grep -Fqx 'ci --ignore-scripts' "$fixture/npm.log"
grep -Fqx 'pack --dry-run' "$fixture/npm.log"
if grep -Eq '^publish( |$)' "$fixture/npm.log"; then
  printf '%s\n' 'dry-run attempted publication' >&2; exit 1
fi

# The existing manual live route still publishes one absent version exactly
# once, then confirms that precise version rather than reporting latest.
run_case ok live
[[ "$(grep -Fc 'publish --access public' "$fixture/npm.log")" == 1 ]]
grep -Fqx 'view arkova@3.3.0 version --json' "$fixture/npm.log"
grep -Fq 'confirmed arkova@3.3.0' "$fixture/out"

# A post-publish registry error or mismatched version is an explicit failure;
# the fixture sees one publish attempt, never a second speculative attempt.
for failure in readback_error readback_wrong; do
  if run_case "$failure" live; then
    printf 'registry %s unexpectedly confirmed\n' "$failure" >&2; exit 1
  fi
  [[ "$(grep -Fc 'publish --access public' "$fixture/npm.log")" == 1 ]]
done

# Uncertain registry outcomes cannot be interpreted as a missing version.
for failure in auth network missing malformed string badentry; do
  for invocation in dry-run live; do
    if run_case "$failure" "$invocation"; then
      printf 'registry %s unexpectedly admitted in %s\n' "$failure" "$invocation" >&2; exit 1
    fi
    grep -Fqx 'view arkova versions --json' "$fixture/npm.log"
    assert_no_build_or_publish
  done
done

printf '%s\n' 'publish-npm exact-version admission: PASS (historical skip/live, absent dry-run/live, uncertain preflight, exact readback failure)'

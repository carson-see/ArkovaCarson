#!/usr/bin/env bash
# DEP-15 (SCRUM-1005): Reject ^/~ ranges in production dependencies.
# TypeScript types in devDependencies are exempt.
set -euo pipefail

EXIT_CODE=0

check_file() {
  local file="$1"
  local section="$2"

  if [ ! -f "$file" ]; then
    return
  fi

  # Extract version strings from the specified section using node
  local violations
  violations=$(node -e "
    const pkg = require('./${file}');
    const deps = pkg['${section}'] || {};
    const violations = Object.entries(deps)
      .filter(([name, ver]) => /^[\^~]/.test(ver))
      .filter(([name]) => !name.startsWith('@types/'))
      .map(([name, ver]) => '  ' + name + ': ' + ver);
    if (violations.length) {
      console.log('${file} ${section}:');
      violations.forEach(v => console.log(v));
    }
    process.exit(violations.length > 0 ? 1 : 0);
  " 2>/dev/null) || true

  if [ -n "$violations" ]; then
    echo "$violations"
    EXIT_CODE=1
  fi
}

echo "=== Dependency Pinning Check (DEP-15) ==="

check_file "package.json" "dependencies"
check_file "services/worker/package.json" "dependencies"
check_file "services/edge/package.json" "dependencies"

if [ "$EXIT_CODE" -ne 0 ]; then
  echo ""
  echo "ERROR: Production dependencies must use exact versions (no ^ or ~ prefixes)."
  echo "Fix: Remove the ^ or ~ prefix from each flagged dependency."
  echo "Rationale: Reproducible builds — lockfile pins transitively but caret ranges"
  echo "let fresh installs pick newer versions unexpectedly."
  exit 1
fi

echo "All production dependencies use exact versions."

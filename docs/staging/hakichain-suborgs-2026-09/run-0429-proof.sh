#!/usr/bin/env bash
# Rebuilds a throwaway DB, applies 0429, and runs the behaviour proof.
set -euo pipefail
export LC_ALL=C LANG=C PGHOST=127.0.0.1 PGPORT=55432 PGUSER=postgres
PSQL=/opt/homebrew/bin/psql
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="${1:?usage: run-0429-proof.sh <path-to-0429.sql>}"
"$PSQL" -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS ark0429;" -c "CREATE DATABASE ark0429;"
"$PSQL" -d ark0429 -v ON_ERROR_STOP=1 -q -f "$HERE/fixture-0429.sql"
"$PSQL" -d ark0429 -v ON_ERROR_STOP=1 -q -f "$MIG"
"$PSQL" -d ark0429 -v ON_ERROR_STOP=1 -f "$HERE/verify-0429.sql"

#!/usr/bin/env bash
# ci-supabase-start.sh
#
# Wrapper around `supabase start` for CI.
#
# Fixes migration issues that prevent `supabase start` from succeeding:
# 1. Duplicate numeric prefixes (0022/0022, 0023/0023, 0024/0024)
# 2. Letter suffixes rejected by CLI (0068a, 0068b, 0088b)
# 3. ALTER TYPE ADD VALUE must be in a separate transaction from usage
#
# Strategy:
# - Merge duplicate-prefix files (append second into first)
# - For letter-suffix files: merge into base OR rename to valid prefix
# - Special case: 0068a (ADD VALUE) must stay separate from 0068b (uses the value)
#   → rename 0068a to 00680, 0068b to 0068 (00680 sorts before 0068_)

set -euo pipefail

MIGRATIONS_DIR="supabase/migrations"
SUPABASE_CONFIG="supabase/config.toml"

echo "=== CI Supabase Start ==="

port_busy() {
  local port="$1"

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" >/dev/null 2>&1
    return $?
  fi

  if command -v ss >/dev/null 2>&1; then
    ss -Htan | awk -v suffix=":$port" '$4 ~ suffix "$" { found = 1 } END { exit(found ? 0 : 1) }'
    return $?
  fi

  # If neither tool exists, let `supabase start` surface any bind failure.
  return 1
}

choose_ci_port_base() {
  local base offset port busy
  local candidates=(
    "${SUPABASE_CI_PORT_BASE:-15420}"
    16420
    17420
    18420
    19420
  )

  for base in "${candidates[@]}"; do
    busy=0
    for offset in 0 1 2 3 4 5 6 7 8 9; do
      port=$((base + offset))
      if port_busy "$port"; then
        busy=1
        break
      fi
    done

    if [[ "$busy" -eq 0 ]]; then
      echo "$base"
      return 0
    fi
  done

  echo "::error::No free CI Supabase port block found (checked blocks: 15420-15429, 16420-16429, 17420-17429, 18420-18429, 19420-19429)" >&2
  return 1
}

set_toml_port() {
  local section="$1"
  local key="$2"
  local value="$3"
  local tmp

  tmp="$(mktemp)"
  awk -v section="[$section]" -v key="$key" -v value="$value" '
    /^\[/ { in_section = ($0 == section) }
    in_section && $1 == key {
      sub(/=.*/, "= " value)
      replaced = 1
    }
    { print }
    END {
      if (!replaced) {
        printf("Missing %s.%s in Supabase config\n", section, key) > "/dev/stderr"
        exit 42
      }
    }
  ' "$SUPABASE_CONFIG" > "$tmp"
  mv "$tmp" "$SUPABASE_CONFIG"
}

configure_ci_ports() {
  local base

  if [[ "${CI:-}" != "true" ]]; then
    return 0
  fi

  base="$(choose_ci_port_base)"

  echo "Using CI Supabase port block ${base}-$((base + 9)) (below Linux ephemeral ports)."
  set_toml_port "api" "port" "$((base + 1))"
  set_toml_port "db" "port" "$((base + 2))"
  set_toml_port "db" "shadow_port" "$base"
  set_toml_port "db.pooler" "port" "$((base + 9))"
  set_toml_port "studio" "port" "$((base + 3))"
  set_toml_port "inbucket" "port" "$((base + 4))"
  set_toml_port "inbucket" "smtp_port" "$((base + 5))"
  set_toml_port "inbucket" "pop3_port" "$((base + 6))"
  set_toml_port "analytics" "port" "$((base + 7))"
}

configure_ci_ports

# --- Fix migration filenames ---
echo "Fixing migration filenames..."

# Handle 0068 enum migration history:
# - 0068_add_submitted_enum.sql in the repo may already contain the 0068b body
#   from an earlier local merge; truncate it back to the enum-only migration.
# - 0068a/0068b have letter suffixes rejected by newer Supabase CLI versions.
# - ADD VALUE must commit before any later migration uses SUBMITTED.
# 00680/00681 sort before 0068_ because digits (48-57) sort before '_' (95).
MIGRATION_0068_BASE="$MIGRATIONS_DIR/0068_add_submitted_enum.sql"
if [ -f "$MIGRATION_0068_BASE" ] && grep -q '^-- MERGED FROM: 0068b_submitted_status_and_confirmations.sql' "$MIGRATION_0068_BASE"; then
  awk '/^-- MERGED FROM: 0068b_submitted_status_and_confirmations.sql/ { exit } { print }' "$MIGRATION_0068_BASE" > /tmp/0068_enum_only.sql
  cp /tmp/0068_enum_only.sql "$MIGRATION_0068_BASE"
  echo "  Split merged 0068_add back to enum-only migration"
fi
if [ -f "$MIGRATIONS_DIR/0068a_add_submitted_enum.sql" ]; then
  mv "$MIGRATIONS_DIR/0068a_add_submitted_enum.sql" "$MIGRATIONS_DIR/00680_add_submitted_enum.sql"
  echo "  Renamed 0068a → 00680 (sorts before 0068_)"
fi
if [ -f "$MIGRATIONS_DIR/0068b_submitted_status_and_confirmations.sql" ]; then
  mv "$MIGRATIONS_DIR/0068b_submitted_status_and_confirmations.sql" "$MIGRATIONS_DIR/00681_submitted_status_and_confirmations.sql"
  echo "  Renamed 0068b → 00681 (runs after 00680 enum add)"
fi

# Handle 0088/0088b: ADD VALUE in 0088, usage in 0088b — keep separate
# 00880 sorts before 0088_ because '0' (48) < '_' (95)
if [ -f "$MIGRATIONS_DIR/0088_cle_credential_type.sql" ] && [ -f "$MIGRATIONS_DIR/0088b_cle_templates.sql" ]; then
  mv "$MIGRATIONS_DIR/0088_cle_credential_type.sql" "$MIGRATIONS_DIR/00880_cle_credential_type.sql"
  mv "$MIGRATIONS_DIR/0088b_cle_templates.sql" "$MIGRATIONS_DIR/0088_cle_templates.sql"
  echo "  Renamed 0088 → 00880, 0088b → 0088 (keeps ADD VALUE in separate transaction)"
fi

# Fix 0069: DROP activate_user before re-creating with different params
# (Postgres can't rename parameters in CREATE OR REPLACE)
MIGRATION_0069="$MIGRATIONS_DIR/0069_pending_profiles_activation.sql"
if [ -f "$MIGRATION_0069" ]; then
  echo "DROP FUNCTION IF EXISTS activate_user(text, text);" > /tmp/0069_fixed.sql
  cat "$MIGRATION_0069" >> /tmp/0069_fixed.sql
  cp /tmp/0069_fixed.sql "$MIGRATION_0069"
  echo "  Prepended DROP FUNCTION to 0069"
fi

# Handle duplicate numeric prefixes (merge second into first)
for dup_prefix in $(ls "$MIGRATIONS_DIR"/*.sql | xargs -n1 basename | sed 's/_.*//' | sort | uniq -d); do
  files=("$MIGRATIONS_DIR"/"${dup_prefix}"_*.sql)
  if [ "${#files[@]}" -gt 1 ]; then
    first="${files[0]}"
    for ((i=1; i<${#files[@]}; i++)); do
      dup="${files[$i]}"
      echo "  Merging $(basename "$dup") into $(basename "$first")"
      echo "" >> "$first"
      echo "-- MERGED FROM: $(basename "$dup")" >> "$first"
      cat "$dup" >> "$first"
      rm "$dup"
    done
  fi
done

echo "Migration filenames fixed."

# --- Start Supabase ---
echo "Stopping any existing local Supabase containers..."
supabase stop --no-backup >/dev/null 2>&1 || true

echo "Starting Supabase..."
supabase start

echo "=== Supabase ready ==="

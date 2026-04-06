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

echo "=== CI Supabase Start ==="

# --- Fix migration filenames ---
echo "Fixing migration filenames..."

# Handle 0068a/0068b: ADD VALUE must be a separate transaction
# 00680 sorts before 0068_ because '0' (48) < '_' (95)
if [ -f "$MIGRATIONS_DIR/0068a_add_submitted_enum.sql" ]; then
  mv "$MIGRATIONS_DIR/0068a_add_submitted_enum.sql" "$MIGRATIONS_DIR/00680_add_submitted_enum.sql"
  echo "  Renamed 0068a → 00680 (sorts before 0068_)"
fi
if [ -f "$MIGRATIONS_DIR/0068b_submitted_status_and_confirmations.sql" ]; then
  mv "$MIGRATIONS_DIR/0068b_submitted_status_and_confirmations.sql" "$MIGRATIONS_DIR/0068_submitted_status_and_confirmations.sql"
  echo "  Renamed 0068b → 0068"
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
echo "Starting Supabase..."
supabase start

echo "=== Supabase ready ==="

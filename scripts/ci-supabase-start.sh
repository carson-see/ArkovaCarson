#!/usr/bin/env bash
# ci-supabase-start.sh
#
# Wrapper around `supabase start` that handles two Postgres/Supabase CLI issues:
#
# 1. ALTER TYPE ... ADD VALUE cannot run inside a transaction (Postgres limitation).
#    Supabase CLI runs each migration in a transaction, so these statements fail.
#    Fix: Comment them out before start, then apply them directly after.
#
# 2. Duplicate migration prefixes and letter suffixes (handled by fix-migration-names.sh).
#
# See CLAUDE.md "Post-db-reset step" for the manual equivalent.

set -euo pipefail

MIGRATIONS_DIR="supabase/migrations"

echo "=== Preparing Supabase for CI ==="

# Step 1: Fix migration filenames (duplicates, letter suffixes)
bash scripts/fix-migration-names.sh

# Step 2: Extract ALTER TYPE ADD VALUE statements (they fail inside transactions)
# Save them for post-start application
ADD_VALUE_STMTS=$(grep -rh "ALTER TYPE.*ADD VALUE" "$MIGRATIONS_DIR"/*.sql 2>/dev/null || true)

# Comment out ADD VALUE statements in migration files
for f in "$MIGRATIONS_DIR"/*.sql; do
  if grep -q "ALTER TYPE.*ADD VALUE" "$f"; then
    sed -i 's/^\(ALTER TYPE.*ADD VALUE\)/-- CI_DISABLED: \1/' "$f"
    echo "  Disabled ADD VALUE in $(basename "$f")"
  fi
done

# Step 3: Start Supabase
echo "Starting Supabase..."
supabase start

# Step 4: Apply ADD VALUE statements directly (outside transaction)
if [ -n "$ADD_VALUE_STMTS" ]; then
  echo "Applying enum ADD VALUE statements..."
  DB_CONTAINER=$(docker ps --filter "name=supabase_db" -q | head -1)
  if [ -n "$DB_CONTAINER" ]; then
    echo "$ADD_VALUE_STMTS" | while IFS= read -r stmt; do
      [ -z "$stmt" ] && continue
      # Ensure IF NOT EXISTS is present
      safe_stmt=$(echo "$stmt" | sed "s/ADD VALUE '/ADD VALUE IF NOT EXISTS '/; s/IF NOT EXISTS IF NOT EXISTS/IF NOT EXISTS/")
      echo "  $safe_stmt"
      docker exec -i "$DB_CONTAINER" psql -U postgres -c "$safe_stmt" 2>/dev/null || true
    done
    docker exec -i "$DB_CONTAINER" psql -U postgres -c "NOTIFY pgrst, 'reload schema';" 2>/dev/null || true
  fi
fi

echo "=== Supabase ready ==="

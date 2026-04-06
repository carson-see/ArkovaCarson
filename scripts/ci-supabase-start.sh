#!/usr/bin/env bash
# ci-supabase-start.sh
#
# Wrapper around `supabase start` that handles two Postgres/Supabase CLI issues:
#
# 1. ALTER TYPE ... ADD VALUE cannot run inside a transaction (Postgres limitation).
#    When migrations are merged (by fix-migration-names.sh), ADD VALUE statements
#    from appended content fail because they run in the same transaction as DDL.
#    Fix: Comment them out in merged sections, then apply directly after startup.
#
# 2. Duplicate migration prefixes and letter suffixes (handled by fix-migration-names.sh).
#
# See CLAUDE.md "Post-db-reset step" for the manual equivalent.

set -euo pipefail

MIGRATIONS_DIR="supabase/migrations"

echo "=== Preparing Supabase for CI ==="

# Step 1: Fix migration filenames (duplicates, letter suffixes)
bash scripts/fix-migration-names.sh

# Step 2: In MERGED sections only, comment out ALTER TYPE ADD VALUE
# These fail inside transactions when multiple migrations are combined.
# We look for "-- MERGED FROM:" markers and disable ADD VALUE after them.
MERGED_STMTS=""
for f in "$MIGRATIONS_DIR"/*.sql; do
  if grep -q "MERGED FROM:" "$f"; then
    # Extract ADD VALUE statements from merged sections for post-start application
    stmts=$(sed -n '/MERGED FROM:/,$ { /ALTER TYPE.*ADD VALUE/p }' "$f")
    if [ -n "$stmts" ]; then
      MERGED_STMTS="$MERGED_STMTS
$stmts"
      # Comment out ADD VALUE only in the merged section
      sed -i '/MERGED FROM:/,$ s/^\(ALTER TYPE.*ADD VALUE\)/-- CI_DISABLED: \1/' "$f"
      echo "  Disabled ADD VALUE in merged section of $(basename "$f")"
    fi
  fi
done

# Step 3: Start Supabase
echo "Starting Supabase..."
supabase start

# Step 4: Apply disabled ADD VALUE statements directly (outside transaction)
if [ -n "$MERGED_STMTS" ]; then
  echo "Applying enum ADD VALUE statements from merged sections..."
  DB_CONTAINER=$(docker ps --filter "name=supabase_db" -q | head -1)
  if [ -n "$DB_CONTAINER" ]; then
    echo "$MERGED_STMTS" | while IFS= read -r stmt; do
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

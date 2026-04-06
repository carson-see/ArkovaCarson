#!/usr/bin/env bash
# fix-migration-names.sh
#
# Supabase CLI v1.123.0+ requires migration filenames to match <timestamp>_name.sql
# where timestamp is a pure integer. This script handles two issues:
#
# 1. Letter suffixes (0068a_, 0088b_) → merged into the base file
# 2. Duplicate numeric prefixes (0022/0022, 0023/0023, 0024/0024) → second file appended to first
#
# Run before `supabase start` in CI.

set -euo pipefail

MIGRATIONS_DIR="supabase/migrations"

echo "Fixing migration filenames for Supabase CLI compatibility..."

# --- Handle letter-suffix migrations (e.g., 0068a_, 0068b_, 0088b_) ---
for file in "$MIGRATIONS_DIR"/[0-9]*[a-z]_*.sql; do
  [ -e "$file" ] || continue
  base=$(basename "$file")
  # Extract the numeric prefix (digits only) and the letter suffix
  prefix=$(echo "$base" | grep -oE '^[0-9]+')
  # Find the base migration with the same prefix (no letter)
  base_file=$(ls "$MIGRATIONS_DIR"/"${prefix}"_*.sql 2>/dev/null | grep -v '[0-9][a-z]_' | head -1 || true)

  if [ -n "$base_file" ] && [ "$base_file" != "$file" ]; then
    echo "  Merging $base into $(basename "$base_file")"
    echo "" >> "$base_file"
    echo "-- MERGED FROM: $base" >> "$base_file"
    cat "$file" >> "$base_file"
    rm "$file"
  else
    # No base file — rename letter suffix to pure numeric
    new_name="${prefix}_$(echo "$base" | sed "s/^${prefix}[a-z]_//")"
    echo "  Renaming $base → $new_name"
    mv "$file" "$MIGRATIONS_DIR/$new_name"
  fi
done

# --- Handle duplicate numeric prefixes ---
ls "$MIGRATIONS_DIR"/*.sql | sed 's|.*/||' | sed 's/_.*//' | sort | uniq -d | while read -r dup_prefix; do
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

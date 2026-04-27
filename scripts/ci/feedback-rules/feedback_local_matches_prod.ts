#!/usr/bin/env -S npx tsx
/**
 * SCRUM-1306 (R0-7) rule: feedback_local_matches_prod.
 *
 * CI lint comparing local schema to prod. Currently a stub because this
 * requires Supabase MCP integration which is not available in CI.
 *
 * TODO: requires Supabase MCP integration — once available, this rule
 * should compare local migration state against the production schema
 * and warn on drift. See memory/feedback_local_matches_prod.md.
 *
 * Always exits 0 (stub).
 */

export function run(): { ok: boolean; message: string } {
  // TODO: requires Supabase MCP integration to compare local schema vs prod.
  // When implemented, this should:
  //   1. Read local migration files from supabase/migrations/
  //   2. Query prod schema via Supabase MCP
  //   3. Diff and report drift
  return {
    ok: true,
    message:
      '⏳ feedback_local_matches_prod: stub — requires Supabase MCP integration (not yet available in CI). Skipping.',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run();
  console.log(result.message);
}

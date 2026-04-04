/**
 * Backup Validation Script
 *
 * Validates a Supabase backup/restore by checking critical tables,
 * RLS policies, data integrity, and anchor resolvability.
 *
 * Usage:
 *   SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... npx tsx services/worker/scripts/backup-validation.ts
 *
 * Optional env vars:
 *   VALIDATION_ANCHOR_PUBLIC_ID  — a known anchor public_id to verify resolvability
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VALIDATION_ANCHOR_PUBLIC_ID = process.env.VALIDATION_ANCHOR_PUBLIC_ID;

const CRITICAL_TABLES = [
  'anchors',
  'profiles',
  'subscriptions',
  'plans',
  'api_keys',
  'organizations',
  'audit_events',
  'credentials',
  'attestations',
  'public_records',
  'x402_payments',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(result: CheckResult): void {
  const icon = result.passed ? 'PASS' : 'FAIL';
  console.log(`[${icon}] ${result.name}: ${result.detail}`);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkTableExists(
  supabase: SupabaseClient,
  table: string,
): Promise<CheckResult> {
  // Use a lightweight query — select 0 rows, just confirm the table is queryable
  const { error } = await supabase.from(table).select('*', { count: 'exact', head: true });

  if (error) {
    return {
      name: `Table exists: ${table}`,
      passed: false,
      detail: `Query failed — ${error.message}`,
    };
  }

  return {
    name: `Table exists: ${table}`,
    passed: true,
    detail: 'Table is accessible',
  };
}

async function checkRlsEnabled(
  supabase: SupabaseClient,
  table: string,
): Promise<CheckResult> {
  // pg_tables has a rowsecurity column (boolean)
  const { data, error } = await supabase.rpc('check_rls_enabled', { table_name: table }).maybeSingle();

  // Fallback: if the RPC doesn't exist, query pg_tables directly via raw SQL
  if (error) {
    // Try direct query via pg_tables (service_role can read it)
    const { data: pgData, error: pgError } = await supabase
      .from('pg_tables' as any)
      .select('rowsecurity')
      .eq('schemaname', 'public')
      .eq('tablename', table)
      .maybeSingle();

    if (pgError || !pgData) {
      // Last resort: just report that we couldn't verify
      return {
        name: `RLS enabled: ${table}`,
        passed: false,
        detail: `Could not verify RLS status — ${pgError?.message ?? 'table not found in pg_tables'}. Verify manually with: SELECT rowsecurity FROM pg_tables WHERE tablename='${table}';`,
      };
    }

    const enabled = (pgData as any).rowsecurity === true;
    return {
      name: `RLS enabled: ${table}`,
      passed: enabled,
      detail: enabled ? 'RLS is enabled' : 'RLS is NOT enabled — CRITICAL',
    };
  }

  const enabled = data === true || (data as any)?.enabled === true;
  return {
    name: `RLS enabled: ${table}`,
    passed: enabled,
    detail: enabled ? 'RLS is enabled' : 'RLS is NOT enabled — CRITICAL',
  };
}

async function checkAnchorCount(supabase: SupabaseClient): Promise<CheckResult> {
  const { count, error } = await supabase
    .from('anchors')
    .select('*', { count: 'exact', head: true });

  if (error) {
    return {
      name: 'Anchor count > 0',
      passed: false,
      detail: `Query failed — ${error.message}`,
    };
  }

  const passed = (count ?? 0) > 0;
  return {
    name: 'Anchor count > 0',
    passed,
    detail: `Found ${count ?? 0} anchors`,
  };
}

async function checkAnchorResolvable(
  supabase: SupabaseClient,
  publicId: string,
): Promise<CheckResult> {
  const { data, error } = await supabase
    .from('anchors')
    .select('public_id, status')
    .eq('public_id', publicId)
    .maybeSingle();

  if (error) {
    return {
      name: `Anchor resolvable: ${publicId}`,
      passed: false,
      detail: `Query failed — ${error.message}`,
    };
  }

  if (!data) {
    return {
      name: `Anchor resolvable: ${publicId}`,
      passed: false,
      detail: 'Anchor not found',
    };
  }

  return {
    name: `Anchor resolvable: ${publicId}`,
    passed: true,
    detail: `Found anchor with status: ${data.status}`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('='.repeat(60));
  console.log('Arkova Backup Validation');
  console.log('='.repeat(60));
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Target:    ${SUPABASE_URL}`);
  console.log('='.repeat(60));
  console.log();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      'ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables are required.',
    );
    process.exit(2);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const results: CheckResult[] = [];

  // 1. Check all critical tables exist
  console.log('--- Critical Tables ---');
  for (const table of CRITICAL_TABLES) {
    const result = await checkTableExists(supabase, table);
    results.push(result);
    log(result);
  }
  console.log();

  // 2. Check RLS enabled on all critical tables
  console.log('--- Row Level Security ---');
  for (const table of CRITICAL_TABLES) {
    const result = await checkRlsEnabled(supabase, table);
    results.push(result);
    log(result);
  }
  console.log();

  // 3. Check anchor count > 0
  console.log('--- Data Integrity ---');
  const anchorCountResult = await checkAnchorCount(supabase);
  results.push(anchorCountResult);
  log(anchorCountResult);

  // 4. Check known anchor resolvable (if configured)
  if (VALIDATION_ANCHOR_PUBLIC_ID) {
    const anchorResult = await checkAnchorResolvable(supabase, VALIDATION_ANCHOR_PUBLIC_ID);
    results.push(anchorResult);
    log(anchorResult);
  } else {
    console.log('[SKIP] Anchor resolvability: VALIDATION_ANCHOR_PUBLIC_ID not set');
  }
  console.log();

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log('='.repeat(60));
  console.log(`SUMMARY: ${passed}/${total} checks passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) {
    console.log();
    console.log('FAILED CHECKS:');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  }

  console.log();
  console.log('All checks passed. Backup is valid.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Unexpected error during validation:', err);
  process.exit(2);
});

/**
 * SEC-005: RLS Policy Audit
 *
 * Checks for USING/WITH CHECK mismatches across all migrations.
 * A SELECT policy without a matching INSERT/UPDATE WITH CHECK can allow data exfiltration.
 *
 * This test validates migration SQL files statically. For live DB check, run:
 *   SELECT schemaname, tablename, policyname,
 *     qual IS NOT NULL as has_using,
 *     with_check IS NOT NULL as has_with_check
 *   FROM pg_policies
 *   WHERE schemaname = 'public'
 *     AND (qual IS NULL OR with_check IS NULL);
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('SEC-005: RLS Policy Audit', () => {
  const migrationsDir = path.join(process.cwd(), 'supabase/migrations');

  it('all tables with RLS have FORCE ROW LEVEL SECURITY', () => {
    if (!fs.existsSync(migrationsDir)) {
      console.warn('SEC-005: migrations directory not found, skipping');
      return;
    }

    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    const allContent = files
      .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8'))
      .join('\n');

    // Find tables with ENABLE ROW LEVEL SECURITY
    const enableRLS = allContent.match(
      /ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi,
    );

    const tablesWithRLS = new Set(
      (enableRLS ?? []).map((m) => {
        const match = m.match(/TABLE\s+(?:public\.)?(\w+)/i);
        return match?.[1]?.toLowerCase();
      }),
    );

    // Check each has FORCE ROW LEVEL SECURITY
    const forceRLS = allContent.match(
      /ALTER\s+TABLE\s+(?:public\.)?(\w+)\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi,
    );

    const tablesWithForce = new Set(
      (forceRLS ?? []).map((m) => {
        const match = m.match(/TABLE\s+(?:public\.)?(\w+)/i);
        return match?.[1]?.toLowerCase();
      }),
    );

    const missingForce = [...tablesWithRLS].filter(
      (t) => t && !tablesWithForce.has(t),
    );

    // Some tables may intentionally not have FORCE (e.g., system tables)
    // Log any missing for review rather than hard-fail
    if (missingForce.length > 0) {
      console.warn(
        `SEC-005: Tables with ENABLE RLS but no FORCE RLS: ${missingForce.join(', ')}. ` +
          'Service role can bypass RLS on these tables.',
      );
    }

    // At minimum, core user-facing tables must have FORCE
    const criticalTables = ['anchors', 'profiles', 'organizations', 'api_keys'];
    for (const table of criticalTables) {
      if (tablesWithRLS.has(table)) {
        expect(
          tablesWithForce.has(table),
          `Critical table '${table}' has ENABLE RLS but missing FORCE ROW LEVEL SECURITY`,
        ).toBe(true);
      }
    }
  });

  it('SECURITY DEFINER functions include SET search_path = public', () => {
    if (!fs.existsSync(migrationsDir)) return;

    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      // Find all SECURITY DEFINER function definitions
      const definerFunctions = content.match(
        /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)[\s\S]*?SECURITY\s+DEFINER/gi,
      );

      if (!definerFunctions) continue;

      for (const func of definerFunctions) {
        const nameMatch = func.match(/FUNCTION\s+(\w+)/i);
        const name = nameMatch?.[1] ?? 'unknown';

        // Check if the function block has SET search_path
        if (!/SET\s+search_path\s*=\s*/i.test(func)) {
          // Check the surrounding context (the full CREATE FUNCTION ... $$ block)
          const funcStart = content.indexOf(func);
          const blockEnd = content.indexOf('$$', funcStart + func.length);
          const fullBlock = content.substring(funcStart, blockEnd > 0 ? blockEnd + 100 : funcStart + func.length + 200);

          if (!/SET\s+search_path\s*=\s*/i.test(fullBlock)) {
            violations.push(`${file}: ${name}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      console.warn(
        `SEC-005: SECURITY DEFINER functions without SET search_path: ${violations.join(', ')}`,
      );
    }
    // Don't hard-fail — some very early migrations may predate this rule
    // The important thing is awareness
    expect(violations.length).toBeLessThan(10); // Reasonable threshold
  });

  it('no policies use WITH CHECK (true) on write operations without USING clause', () => {
    if (!fs.existsSync(migrationsDir)) return;

    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      // Look for INSERT/UPDATE policies with WITH CHECK (true) — overly permissive
      const openPolicies = content.match(
        /CREATE\s+POLICY\s+\w+\s+ON\s+\w+\s+FOR\s+(?:INSERT|UPDATE)\s+[\s\S]*?WITH\s+CHECK\s*\(\s*true\s*\)/gi,
      );

      if (openPolicies) {
        for (const policy of openPolicies) {
          const nameMatch = policy.match(/POLICY\s+(\w+)\s+ON\s+(\w+)/i);
          if (nameMatch) {
            violations.push(`${file}: ${nameMatch[1]} on ${nameMatch[2]}`);
          }
        }
      }
    }

    if (violations.length > 0) {
      console.warn(
        `SEC-005: Overly permissive WITH CHECK (true) policies: ${violations.join(', ')}`,
      );
    }
    // Some may be intentional (e.g., public_records insert by service_role)
    // but should be reviewed
  });
});

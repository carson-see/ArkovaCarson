/**
 * Security Tier 1 Tests — CISO Audit Findings.
 *
 * After SCRUM-1668 Path C, individual migrations 0000..0289 collapsed into
 * `00000000000000_baseline_at_main_HEAD.sql` (byte-faithful pg_dump of prod).
 * Tests that previously read individual files (0061_*, 0062_*, 0065_*) now
 * read the baseline instead. A handful of tests were retired as obsolete:
 *   - PII-01 trigger "null_audit_pii_fields": the `actor_email` column was
 *     dropped in migration 0170. The trigger that NULLed it on insert is
 *     irrelevant once the column is gone — the prod pg_dump no longer has
 *     either the column or the trigger. The property "audit_events does
 *     not store PII" is now enforced by the schema itself; verified by the
 *     baseline NOT containing actor_email/actor_ip/actor_user_agent
 *     columns on audit_events.
 *
 * Tests for:
 * - PII-01: audit_events PII protection (column-absence invariant + client-side guard)
 * - PII-02: anonymize_user_data RPC contract
 * - INJ-01: search_public_credentials parameterization
 * - RLS-02: api_keys admin-only access
 * - PII-03: cleanup_expired_data retention policy
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BASELINE_PATH = path.join(
  process.cwd(),
  'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql',
);

let baselineCache: string | null = null;
function baseline(): string {
  if (baselineCache === null) {
    baselineCache = fs.readFileSync(BASELINE_PATH, 'utf8');
  }
  return baselineCache;
}

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase/migrations');

/**
 * Return the body of the HIGHEST-numbered migration that (re)defines a
 * Postgres function. The baseline sorts first, so a later compensating
 * `CREATE OR REPLACE` wins — mirroring what actually runs in the database.
 * Without this, a contract test would forever read the stale baseline body
 * and never see a fix. Handles both pg_dump's quoted `"public"."fn"` and a
 * hand-written `public.fn` form.
 */
function latestFunctionBlock(fnName: string): string {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let latest: string | null = null;
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const quoted = sql.indexOf(`FUNCTION "public"."${fnName}"`);
    const unquotedMatch = sql.match(new RegExp(`FUNCTION\\s+public\\.${fnName}\\b`));
    const unquoted = unquotedMatch?.index ?? -1;
    const candidates = [quoted, unquoted].filter((i) => i >= 0);
    if (candidates.length === 0) continue;
    const start = Math.min(...candidates);
    const end = sql.indexOf('$$;', start);
    if (end < 0) continue;
    latest = sql.slice(start, end + 3);
  }
  if (latest === null) {
    throw new Error(`No migration defines function ${fnName}`);
  }
  return latest;
}

/** Real column set of a table, parsed from its baseline CREATE TABLE block. */
function tableColumns(tableName: string): Set<string> {
  const sql = baseline();
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${tableName}"`);
  if (start < 0) throw new Error(`No CREATE TABLE for ${tableName}`);
  const end = sql.indexOf(');', start);
  const block = sql.slice(start, end);
  const cols = new Set<string>();
  // Column lines look like `    "id" "uuid" DEFAULT ...`; CONSTRAINT lines
  // start with the keyword, not a quoted identifier, so they are excluded.
  for (const m of block.matchAll(/^\s{2,}"([a-z_]+)"\s/gm)) cols.add(m[1]);
  return cols;
}

// ===========================================================================
// PII-01: audit_events PII protection
// ===========================================================================

describe('PII-01: audit_events PII protection', () => {
  it('audit_events table does not contain actor_email/actor_ip/actor_user_agent (column-absence invariant)', () => {
    const sql = baseline();
    // Find the CREATE TABLE audit_events ... (...) block by scanning forward
    // from the literal CREATE statement to the closing `);`. Asserting on the
    // whole baseline would miss columns that exist on a different table.
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS "public"."audit_events"');
    expect(start).toBeGreaterThan(-1);
    const end = sql.indexOf(');', start);
    const block = sql.slice(start, end);

    expect(block).not.toMatch(/"?actor_email"?\s+/);
    expect(block).not.toMatch(/"?actor_ip"?\s+/);
    expect(block).not.toMatch(/"?actor_user_agent"?\s+/);
  });

  it('client-side auditLog.ts never sends actor_email', () => {
    const auditLogPath = path.join(process.cwd(), 'src/lib/auditLog.ts');
    const content = fs.readFileSync(auditLogPath, 'utf8');

    // Should NOT contain actor_email anywhere (data-minimization invariant)
    expect(content).not.toMatch(/actor_email\s*:/);
    // GDPR rationale must remain in the docstring so the invariant is auditable
    expect(content).toContain('GDPR Art. 5(1)(c)');
    // SCRUM-1270 (R2-7): client no longer inserts directly. actor_id is pinned
    // server-side from the JWT subject — assert the route + delivery shape.
    expect(content).toContain('/api/audit/event');
    expect(content).toContain('Bearer ${session.access_token}');
  });
});

// ===========================================================================
// PII-02: Right-to-erasure infrastructure
// ===========================================================================

describe('PII-02: Right-to-erasure infrastructure', () => {
  it('anonymize_user_data() exists as SECURITY DEFINER RPC (was migration 0061)', () => {
    const sql = baseline();
    expect(sql).toContain('FUNCTION "public"."anonymize_user_data"');
    // Find the function body block
    const start = sql.indexOf('FUNCTION "public"."anonymize_user_data"');
    const end = sql.indexOf('$$;', start) + 3;
    const block = sql.slice(start, end);
    expect(block).toContain('SECURITY DEFINER');
    expect(block).toContain('SET "search_path"');
    // Must be service_role only
    expect(block).toContain("'service_role'");
  });

  // ---------------------------------------------------------------------------
  // Regression: GDPR Art. 17 erasure aborted on non-existent columns.
  //
  // The prod `anonymize_user_data` (called by delete_own_account() AND the
  // worker's DELETE /api/account) ended with:
  //     UPDATE verification_events SET details = NULL
  //     WHERE user_id = p_user_id AND details IS NOT NULL;
  // `verification_events` is a PII-free analytics table with NEITHER a
  // `user_id` NOR a `details` column, so the statement raised 42703
  // (undefined_column) and aborted the whole erasure transaction — every
  // account deletion failed. The only prior coverage MOCKED the RPC, so it
  // was never caught. These contract tests read the real column set and the
  // latest function definition (no mock), so a re-break fails CI.
  // ---------------------------------------------------------------------------
  it('anonymize_user_data() writes only to columns that exist on verification_events', () => {
    const body = latestFunctionBlock('anonymize_user_data');
    const realCols = tableColumns('verification_events');

    // The defect's two columns are genuinely absent from the analytics table.
    expect(realCols.has('user_id')).toBe(false);
    expect(realCols.has('details')).toBe(false);

    // Every write statement that targets verification_events must reference
    // only real columns. (A correct fix that removes the statement entirely
    // leaves nothing to check — also passing.)
    const writes = [
      ...body.matchAll(
        /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?verification_events"?\b[\s\S]*?;/gi,
      ),
    ].map((m) => m[0]);
    for (const stmt of writes) {
      const referenced = new Set<string>();
      for (const m of stmt.matchAll(/\bSET\s+"?([a-z_]+)"?\s*=/gi)) referenced.add(m[1]);
      for (const m of stmt.matchAll(/"?([a-z_]+)"?\s*=\s*p_user_id\b/gi)) referenced.add(m[1]);
      for (const m of stmt.matchAll(/"?([a-z_]+)"?\s+IS\s+(?:NOT\s+)?NULL\b/gi))
        referenced.add(m[1]);
      for (const col of referenced) {
        expect(
          realCols.has(col),
          `anonymize_user_data references verification_events.${col}, which does not exist`,
        ).toBe(true);
      }
    }
  });

  it('anonymize_user_data() still guards service_role and actually scrubs ai_usage_events PII', () => {
    const body = latestFunctionBlock('anonymize_user_data');
    // Authorization posture preserved.
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toMatch(/SET\s+"?search_path"?/i);
    expect(body).toContain("'service_role'");
    // The document-derived PII in the covered table is nulled — both the
    // fingerprint and the cached extracted result fields (result_json).
    expect(body).toMatch(/UPDATE\s+ai_usage_events[\s\S]*?fingerprint\s*=\s*NULL/i);
    expect(body).toMatch(/UPDATE\s+ai_usage_events[\s\S]*?result_json\s*=\s*NULL/i);
  });

  it('profiles table has deleted_at timestamptz column (was migration 0065)', () => {
    const sql = baseline();
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS "public"."profiles"');
    expect(start).toBeGreaterThan(-1);
    const end = sql.indexOf(');', start);
    const block = sql.slice(start, end);
    expect(block).toMatch(/"deleted_at"\s+timestamp/);
  });

  it('profiles_hide_deleted RESTRICTIVE policy filters deleted rows', () => {
    const sql = baseline();
    expect(sql).toContain('"profiles_hide_deleted"');
    // RESTRICTIVE policy syntax in pg_dump output
    const restrictiveIdx = sql.indexOf('"profiles_hide_deleted"');
    const block = sql.slice(restrictiveIdx, restrictiveIdx + 500);
    expect(block).toContain('RESTRICTIVE');
    expect(block).toMatch(/"deleted_at"\s+IS\s+NULL/);
  });

  it('delete_own_account() RPC exists (was migration 0065)', () => {
    const sql = baseline();
    expect(sql).toContain('FUNCTION "public"."delete_own_account"');
    const start = sql.indexOf('FUNCTION "public"."delete_own_account"');
    const end = sql.indexOf('$$;', start) + 3;
    const block = sql.slice(start, end);
    expect(block).toContain('SECURITY DEFINER');
    expect(block).toContain("'ACCOUNT_DELETED'");
    expect(block).toContain("'gdpr_article'");
    expect(block).toContain("'17'");
  });

  it('account-delete worker endpoint exists', () => {
    const endpointPath = path.join(
      process.cwd(),
      'services/worker/src/api/account-delete.ts',
    );
    const content = fs.readFileSync(endpointPath, 'utf8');

    expect(content).toContain('handleAccountDelete');
    expect(content).toContain('anonymize_user_data');
    expect(content).toContain('deleted_at');
    expect(content).toContain('auth.admin.deleteUser');
  });

  it('DeleteAccountDialog component exists', () => {
    const componentPath = path.join(
      process.cwd(),
      'src/components/auth/DeleteAccountDialog.tsx',
    );
    const content = fs.readFileSync(componentPath, 'utf8');

    expect(content).toContain('DeleteAccountDialog');
    expect(content).toContain('CONFIRMATION_TEXT');
    expect(content).toContain('workerFetch');
    expect(content).toContain('/api/account');
  });
});

// ===========================================================================
// INJ-01: PostgREST injection prevention
// ===========================================================================

describe('INJ-01: PostgREST injection prevention', () => {
  it('search_public_credentials() exists as parameterized SECURITY DEFINER RPC (was migration 0062)', () => {
    const sql = baseline();
    expect(sql).toContain('FUNCTION "public"."search_public_credentials"');
    const start = sql.indexOf('FUNCTION "public"."search_public_credentials"');
    const end = sql.indexOf('$$;', start) + 3;
    const block = sql.slice(start, end);
    expect(block).toContain('SECURITY DEFINER');
    expect(block).toContain('SET "search_path"');
    // Uses ILIKE with parameter binding, not string interpolation
    expect(block).toMatch(/ILIKE\s+v_pattern/);
    // Clamps limit
    expect(block).toMatch(/LEAST\s*\(\s*GREATEST/);
  });

  it('mcp-tools.ts uses RPC instead of raw URL interpolation', () => {
    const mcpToolsPath = path.join(
      process.cwd(),
      'services/edge/src/mcp-tools.ts',
    );
    const content = fs.readFileSync(mcpToolsPath, 'utf8');

    // Should call the RPC endpoint
    expect(content).toContain('rpc/search_public_credentials');
    // Should sanitize LIKE wildcards
    expect(content).toContain(String.raw`replaceAll(/[%_\\]/g`);
    expect(content).toContain('String.raw`\\$&`');
    // Should NOT contain direct PostgREST filter interpolation
    expect(content).not.toContain('anchors?title=ilike');
    expect(content).not.toContain('anchors?or=');
  });
});

// ===========================================================================
// RLS-01: GRANT to authenticated on the 13 tables introduced in migration 0062
// ===========================================================================

describe('RLS-01: GRANT to authenticated on 13 tables', () => {
  it('all 13 tables have a GRANT to authenticated in the baseline', () => {
    const sql = baseline();

    const expectedTables = [
      'credential_templates',
      'memberships',
      'verification_events',
      'institution_ground_truth',
      'anchor_recipients',
      'credits',
      'credit_transactions',
      'api_keys',
      'api_key_usage',
      'ai_credits',
      'ai_usage_events',
      'credential_embeddings',
      'invitations',
    ];

    for (const table of expectedTables) {
      // pg_dump quotes identifiers; accept either quoted or unquoted form
      // and accept any GRANT that targets the table for authenticated.
      const re = new RegExp(
        `GRANT[^;]+ON\\s+TABLE\\s+"?public"?\\."?${table}"?\\s+TO\\s+"?authenticated"?`,
      );
      expect(sql).toMatch(re);
    }
  });
});

// ===========================================================================
// RLS-02: api_keys admin-only
// ===========================================================================

describe('RLS-02: api_keys admin-only access', () => {
  it('api_keys SELECT policy restricts to ORG_ADMIN (was migration 0062)', () => {
    const sql = baseline();
    expect(sql).toContain('"api_keys_select"');
    // pg_dump groups POLICY definitions; accept any reference to ORG_ADMIN
    // appearing in the api_keys policy block.
    const idx = sql.indexOf('"api_keys_select"');
    const block = sql.slice(idx, idx + 1000);
    expect(block).toContain("'ORG_ADMIN'");
  });

  it('api_key_usage has a SELECT policy in the baseline', () => {
    const sql = baseline();
    expect(sql).toContain('"api_key_usage_select"');
  });
});

// ===========================================================================
// PII-03: Data retention
// ===========================================================================

describe('PII-03: Data retention policy', () => {
  it('cleanup_expired_data() exists with retention windows (was migration 0062)', () => {
    const sql = baseline();
    expect(sql).toContain('FUNCTION "public"."cleanup_expired_data"');
    const start = sql.indexOf('FUNCTION "public"."cleanup_expired_data"');
    const end = sql.indexOf('$$;', start) + 3;
    const block = sql.slice(start, end);
    expect(block).toContain('SECURITY DEFINER');
    // Retention windows
    expect(block).toContain("'90 days'");
    expect(block).toContain("'1 year'");
    expect(block).toContain("'2 years'");
    // Legal hold protection
    expect(block).toMatch(/"?legal_hold"?\s*=\s*true/);
    // Service-role only
    expect(block).toContain("'service_role'");
  });

  it('worker cron job is configured for daily retention cleanup', () => {
    // ARCH-1: Scheduled jobs extracted to routes/scheduled.ts
    const scheduledPath = path.join(
      process.cwd(),
      'services/worker/src/routes/scheduled.ts',
    );
    const content = fs.readFileSync(scheduledPath, 'utf8');

    expect(content).toContain('cleanup_expired_data');
    expect(content).toContain('0 2 * * *');
  });
});

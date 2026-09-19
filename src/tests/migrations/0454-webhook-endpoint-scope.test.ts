/**
 * SCRUM-3972 / migration 0454 — `webhook_endpoints.scope` contract.
 *
 * These are file-level assertions, and that scope is deliberate and stated
 * rather than implied: this session has no database. A live RLS suite
 * (`src/tests/rls/`) authenticates against a running local Supabase, so it
 * cannot run here and its result is NOT claimed. What IS verifiable without a
 * database is the thing most likely to go wrong on review:
 *
 *   1. the column is behaviour-preserving by construction — NOT NULL with a
 *      `self` default, so every row that existed before 0454 keeps the feed it
 *      had, which is the whole basis of the "zero blast radius" claim for the 4
 *      endpoints live in production today;
 *   2. the CHECK the runtime writes are validated against says exactly what the
 *      Zod enum and the UI picker say (builder contract §3);
 *   3. 0454 adds NO RLS policy, and the four pre-existing org-scoped policies
 *      on `webhook_endpoints` are still the only ones — a reviewer asking "what
 *      guards this column?" gets an answer that matches the file;
 *   4. the DROP + CREATE of `create_webhook_endpoint` keeps every authority
 *      guard the baseline had and does not re-grant `anon`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MIGRATION = 'supabase/migrations/0454_scrum3972_webhook_endpoint_scope.sql';
const BASELINE = 'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

/** Strip `--` comment lines so prose can never satisfy an assertion about SQL. */
function sqlOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('migration 0454 — webhook_endpoints.scope', () => {
  const raw = read(MIGRATION);
  const sql = sqlOnly(raw);

  it('adds the column NOT NULL with a self default, so no existing endpoint changes', () => {
    expect(sql).toMatch(
      /ALTER TABLE public\.webhook_endpoints\s+ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'self'/,
    );
  });

  it('constrains scope to exactly the two values the runtime can produce', () => {
    // Builder contract §3: this CHECK is what webhooks-schemas.ts's z.enum and
    // WebhookSettings' SCOPE_OPTIONS are proven against.
    expect(sql).toContain("CHECK (scope IN ('self', 'self_and_descendants')) NOT VALID");
    expect(sql).toMatch(
      /ALTER TABLE public\.webhook_endpoints\s+VALIDATE CONSTRAINT webhook_endpoints_scope_known_values/,
    );
  });

  it('bounds every lock it takes', () => {
    // CLAUDE.md §1.2. webhook_endpoints is not one of the three hot tables, but
    // an unbounded ALTER is a barrier wherever it queues.
    expect(sql).toContain("SET LOCAL lock_timeout = '5s'");
    const guardAt = sql.indexOf("SET LOCAL lock_timeout = '5s'");
    expect(guardAt).toBeGreaterThan(-1);
    expect(sql.indexOf('ALTER TABLE public.webhook_endpoints')).toBeGreaterThan(guardAt);
  });

  it('creates the partial index the fan-out reads, and not CONCURRENTLY', () => {
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_scope_active\s+ON public\.webhook_endpoints \(org_id, scope\)\s+WHERE is_active/,
    );
    // CONCURRENTLY cannot run inside the migration builder's transaction
    // wrapper (supabase/migrations/agents.md hard rule).
    expect(sql).not.toContain('CONCURRENTLY');
  });

  it('reloads the PostgREST schema cache', () => {
    expect(sql).toContain("NOTIFY pgrst, 'reload schema'");
  });

  it('carries a runnable ROLLBACK that undoes every object it creates', () => {
    const rollback = raw.slice(raw.indexOf('-- ROLLBACK:'), raw.indexOf('BEGIN;\nSET LOCAL'));
    expect(rollback).toContain('DROP INDEX IF EXISTS public.idx_webhook_endpoints_scope_active');
    expect(rollback).toContain('DROP CONSTRAINT IF EXISTS webhook_endpoints_scope_known_values');
    expect(rollback).toContain('DROP COLUMN IF EXISTS scope');
    // The RPC signature change must be undone too, otherwise a rollback leaves
    // a three-argument function writing to a column that no longer exists.
    expect(rollback).toContain('DROP FUNCTION IF EXISTS public.create_webhook_endpoint(text, text[], text)');
    expect(rollback).toContain('CREATE OR REPLACE FUNCTION public.create_webhook_endpoint(p_url text, p_events text[])');
  });

  it('changes NO row-level security, leaving the four org-scoped policies in charge', () => {
    // `scope` selects which events a row RECEIVES; it does not widen which rows
    // a caller may see or write. Adding a policy here would guard nothing and
    // imply a protection the column does not provide.
    expect(sql).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY/);
    expect(sql).not.toContain('ROW LEVEL SECURITY');

    const baseline = read(BASELINE);
    const policies = [
      ...baseline.matchAll(/CREATE POLICY "(webhook_endpoints_[a-z_]+)" ON "public"\."webhook_endpoints"/g),
    ].map((m) => m[1]);
    expect(policies.sort()).toEqual([
      'webhook_endpoints_delete_org',
      'webhook_endpoints_insert_org',
      'webhook_endpoints_read_org',
      'webhook_endpoints_update_org',
    ]);
    // Each is org-scoped AND admin-gated; that pair is what makes editing
    // `scope` on your own endpoint the already-authorised operation.
    for (const policy of policies) {
      const clause = baseline.slice(
        baseline.indexOf(`CREATE POLICY "${policy}"`),
        baseline.indexOf(';', baseline.indexOf(`CREATE POLICY "${policy}"`)),
      );
      expect(clause, policy).toContain('get_user_org_id');
      expect(clause, policy).toContain('is_org_admin');
    }
    expect(baseline).toContain(
      'ALTER TABLE ONLY "public"."webhook_endpoints" FORCE ROW LEVEL SECURITY',
    );
  });

  describe('create_webhook_endpoint gains p_scope', () => {
    it('replaces the two-argument form rather than overloading it', () => {
      // CLAUDE.md §6: two functions differing only by a DEFAULT are ambiguous
      // to PostgREST.
      expect(sql).toContain('DROP FUNCTION IF EXISTS public.create_webhook_endpoint(text, text[]);');
      expect(sql).toContain("p_scope text DEFAULT 'self'");
    });

    it('keeps every authority guard the baseline body had', () => {
      const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.create_webhook_endpoint'));
      for (const guard of [
        "RAISE EXCEPTION 'Not authenticated'",
        "RAISE EXCEPTION 'User has no organization'",
        "RAISE EXCEPTION 'Only ORG_ADMIN can create webhook endpoints'",
        "RAISE EXCEPTION 'URL must start with https://'",
        "RAISE EXCEPTION 'At least one event must be selected'",
        'SECURITY DEFINER',
        "SET search_path TO 'public'",
      ]) {
        expect(body, guard).toContain(guard);
      }
    });

    it('validates scope in the body against the same value set as the CHECK', () => {
      expect(sql).toContain("IF COALESCE(p_scope, 'self') NOT IN ('self', 'self_and_descendants') THEN");
    });

    it('re-grants execute without reinstating the anon grant', () => {
      // A DROP discards grants. The baseline granted ALL to anon; that is not
      // restored. Behaviour-preserving — the body's first statement raises when
      // auth.uid() is NULL — and one fewer role holding EXECUTE.
      expect(sql).toContain('REVOKE ALL ON FUNCTION public.create_webhook_endpoint(text, text[], text) FROM PUBLIC');
      expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.create_webhook_endpoint(text, text[], text) TO authenticated');
      expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.create_webhook_endpoint(text, text[], text) TO service_role');
      expect(sql).not.toMatch(/GRANT[^\n]*create_webhook_endpoint[^\n]*TO anon/);
    });
  });
});

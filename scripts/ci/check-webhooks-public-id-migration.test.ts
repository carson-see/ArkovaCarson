/**
 * SCRUM-1445 webhook public-id — schema invariants from the Path C baseline.
 *
 * Original test asserted properties of the source migration file
 * (0284_webhooks_public_id.sql), including deploy-time safety hints
 * like `SET LOCAL lock_timeout = '5s'` and the migration-time
 * verification SELECTs. After SCRUM-1668 Path C, the migration was
 * collapsed into the byte-faithful pg_dump baseline. The deploy-time
 * hints are not preserved (they're transient session settings, not
 * schema), but the runtime triggers + functions are.
 *
 * What this test now asserts:
 *   - Both BEFORE INSERT triggers exist on the right tables
 *   - The trigger functions normalize blank prefixes to 'IND'
 *   - The trigger functions use 16-hex collision-safe suffixes
 *   - Column comments document the public-id shape
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const baseline = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'supabase/migrations/00000000000000_baseline_at_main_HEAD.sql'),
  'utf8',
);

describe('SCRUM-1445 webhook public-id — schema invariants', () => {
  it('BEFORE INSERT trigger on webhook_endpoints fires the public-id setter', () => {
    expect(baseline).toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"set_webhook_endpoint_public_id"\s+BEFORE\s+INSERT\s+ON\s+"public"\."webhook_endpoints"/i,
    );
  });

  it('BEFORE INSERT trigger on webhook_delivery_logs fires the public-id setter', () => {
    expect(baseline).toMatch(
      /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+"set_webhook_delivery_log_public_id"\s+BEFORE\s+INSERT\s+ON\s+"public"\."webhook_delivery_logs"/i,
    );
  });

  it('endpoint trigger function normalizes blank org prefix to IND', () => {
    const start = baseline.indexOf('FUNCTION "public"."set_webhook_endpoint_public_id"');
    expect(start).toBeGreaterThan(-1);
    const end = baseline.indexOf('$$;', start) + 3;
    const block = baseline.slice(start, end);
    expect(block).toMatch(/COALESCE\s*\(\s*NULLIF\s*\(\s*btrim\s*\(\s*v_org_prefix\s*\)\s*,\s*''\s*\)\s*,\s*'IND'\s*\)/);
  });

  it('delivery-log trigger function emits DLV- prefix', () => {
    const start = baseline.indexOf('FUNCTION "public"."set_webhook_delivery_log_public_id"');
    expect(start).toBeGreaterThan(-1);
    const end = baseline.indexOf('$$;', start) + 3;
    const block = baseline.slice(start, end);
    expect(block).toMatch(/'DLV-'/);
  });

  it('both trigger functions use collision-safe 16-hex suffixes', () => {
    // pg_dump only preserves the function body, not the migration-time
    // verification SELECTs. Two `from 1 for 16` calls — one per function —
    // is the expected count. Anything less means a regression to the
    // 8/12-char short form that SCRUM-1445 fixed.
    const matches = baseline.match(/from\s+1\s+for\s+16\b/gi);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(baseline).not.toMatch(/from\s+1\s+for\s+(?:8|12)\b/i);
  });

  it('column comments document the customer-facing identifier shape', () => {
    expect(baseline).toContain('Customer-facing identifier (WHK-{org_prefix}-{16})');
    expect(baseline).toContain('Customer-facing identifier (DLV-{16})');
  });
});

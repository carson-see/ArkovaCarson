import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0473_uat12_anchor_credit_purchase_conservation.sql'),
  'utf8',
);

describe('0473 UAT-12 organization purchase conservation', () => {
  it('replaces the purchase grant without double-booking purchased principal in the ledger', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.grant_purchased_anchor_credits/i);
    const functionBody = migration.match(
      /CREATE OR REPLACE FUNCTION public\.grant_purchased_anchor_credits[\s\S]*?\n\$\$;/i,
    )?.[0] ?? '';

    expect(functionBody).toMatch(/purchased = public\.org_credits\.purchased \+ EXCLUDED\.purchased/i);
    expect(functionBody).not.toMatch(/INSERT INTO public\.org_credit_deductions/i);
  });

  it('corrects only exact legacy purchase receipts with an append-only compensating entry', () => {
    expect(migration).toMatch(/JOIN public\.anchor_credit_purchases p[\s\S]*p\.id = d\.reference_id/i);
    expect(migration).toMatch(/d\.org_id = p\.target_org_id/i);
    expect(migration).toMatch(/d\.reason = 'anchor\.credit_purchase'/i);
    expect(migration).toMatch(/d\.entry_type = 'GRANT'/i);
    expect(migration).toMatch(/d\.amount = p\.quantity/i);
    expect(migration).toMatch(/'anchor\.credit_purchase\.principal_reclassification'/i);
    expect(migration).toMatch(/-p\.quantity[\s\S]*'REVOKE'/i);
    expect(migration).toMatch(/ON CONFLICT \(org_id, reference_id, reason\) DO NOTHING/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+public\.org_credit_deductions/i);
    expect(migration).not.toMatch(/\bUPDATE\s+public\.org_credit_deductions/i);
  });

  it('preserves the service-role-only grant boundary', () => {
    expect(migration).toMatch(/auth\.role\(\)\) IS DISTINCT FROM 'service_role'[\s\S]*service_role_required/i);
    for (const parameter of ['p_quantity', 'p_amount_paid_cents', 'p_currency']) {
      expect(migration).toContain(`${parameter} IS NULL`);
    }
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.grant_purchased_anchor_credits[\s\S]*FROM PUBLIC, anon, authenticated/i);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.grant_purchased_anchor_credits[\s\S]*TO service_role/i);
  });

  it('serializes the replacement and repair against the old grant writer', () => {
    expect(migration).toMatch(/SET LOCAL lock_timeout = '5s'/i);
    expect(migration).toMatch(/LOCK TABLE public\.anchor_credit_purchases IN SHARE ROW EXCLUSIVE MODE/i);
    expect(migration).toMatch(/LOCK TABLE public\.org_credits IN SHARE ROW EXCLUSIVE MODE/i);
    expect(migration).toMatch(/LOCK TABLE public\.org_credit_deductions IN SHARE ROW EXCLUSIVE MODE/i);
    expect(migration).toMatch(/NOTIFY pgrst, 'reload schema'/i);
  });
});

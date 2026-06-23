import { describe, expect, it } from 'vitest';
import { readMigration } from './migrations.js';

// SCRUM-2349 (QUEUE-03) + SCRUM-2350 (QUEUE-04) — Train D credit integrity.
// CI-runnable structural assertions on migration 0341 (no Docker required). The
// behavioral semantics are exercised by supabase/tests/0341_credit_foundation_test.sql
// against a live Postgres.
const migration = readMigration('0341_scrum2349_2350_credit_integrity_foundation.sql');

describe('0341 credit integrity foundation migration', () => {
  it('hardens the EXISTING org_credit_deductions ledger (no new ledger table)', () => {
    expect(migration).not.toMatch(/CREATE TABLE[^;]*\b(credit_ledger|new_credit|org_credit_ledger)\b/i);
    // It mutates the existing ledger in place.
    expect(migration).toContain('ALTER TABLE public.org_credit_deductions');
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS entry_type text");
  });

  it('drops the unsigned CHECKs and adds a signed-amount CHECK (DBA premortem)', () => {
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS org_credit_deductions_amount_check');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS org_credit_deductions_balance_after_check');
    expect(migration).toContain('org_credit_deductions_amount_signed_check');
    // DEBIT must be negative, REFUND positive, amount never zero.
    expect(migration).toContain('amount <> 0');
    expect(migration).toMatch(/entry_type <> 'DEBIT'\s+OR amount < 0/);
    expect(migration).toMatch(/entry_type <> 'REFUND'\s+OR amount > 0/);
  });

  it('drops the old positivity CHECK BEFORE the sign-flip UPDATE (ordering regression)', () => {
    // REGRESSION GUARD: the original 0341 ran `UPDATE ... SET amount = -amount`
    // BEFORE dropping org_credit_deductions_amount_check (amount > 0), so on a
    // non-empty table the negation violated the still-live old CHECK (ERROR
    // 23514). The DROP must come first.
    const dropOldAmountCheck = migration.indexOf(
      'DROP CONSTRAINT IF EXISTS org_credit_deductions_amount_check',
    );
    const signFlipUpdate = migration.indexOf('SET amount = -amount');
    const addSignedCheck = migration.indexOf('org_credit_deductions_amount_signed_check');
    expect(dropOldAmountCheck).toBeGreaterThan(-1);
    expect(signFlipUpdate).toBeGreaterThan(-1);
    // (a) drop old amount>0 CHECK -> (b) negate existing debits -> (c) add signed CHECK.
    expect(dropOldAmountCheck).toBeLessThan(signFlipUpdate);
    expect(signFlipUpdate).toBeLessThan(addSignedCheck);
  });

  it('enforces append-only via a BEFORE UPDATE OR DELETE trigger that rejects mutation', () => {
    expect(migration).toContain('reject_org_credit_deduction_mutation');
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON public\.org_credit_deductions/);
    expect(migration).toContain('append-only');
    expect(migration).toContain('RAISE EXCEPTION');
  });

  it('REVOKEs DELETE on org_credit_deductions from service_role (no row erasure)', () => {
    expect(migration).toContain('REVOKE DELETE ON TABLE public.org_credit_deductions FROM service_role');
  });

  it('refund_org_credit INSERTs a positive REFUND row and never DELETEs', () => {
    const refundFn = migration.slice(
      migration.indexOf('FUNCTION public.refund_org_credit'),
      migration.indexOf('FUNCTION public.debit_and_enqueue_anchor'),
    );
    expect(refundFn).toContain("entry_type");
    expect(refundFn).toContain("'REFUND'");
    expect(refundFn).toContain('INSERT INTO org_credit_deductions');
    // The double-charge vector was the DELETE — it must be gone from refund.
    expect(refundFn).not.toMatch(/DELETE\s+FROM\s+org_credit_deductions/i);
    // Idempotent on retry.
    expect(refundFn).toContain("'idempotent', true");
  });

  it('deduct_org_credit requires a non-null reference_id for securing debits', () => {
    const deductFn = migration.slice(
      migration.indexOf('FUNCTION public.deduct_org_credit'),
      migration.indexOf('FUNCTION public.refund_org_credit'),
    );
    expect(deductFn).toContain('reference_id_required');
    expect(deductFn).toContain('p_reference_id IS NULL');
    // Stores the SIGNED (negative) debit amount.
    expect(deductFn).toContain('-p_amount');
    // Idempotency comparison adjusted for signed storage.
    expect(deductFn).toContain('v_existing.amount <> -p_amount');
  });

  it('adds the QUEUE-04 atomic debit+enqueue RPC (SECURITY DEFINER + search_path + timeout)', () => {
    expect(migration).toContain('FUNCTION public.debit_and_enqueue_anchor');
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public');
    expect(migration).toContain("SET statement_timeout TO '15s'");
    const atomicFn = migration.slice(
      migration.indexOf('FUNCTION public.debit_and_enqueue_anchor'),
      migration.indexOf('FUNCTION public.org_credit_ledger_divergence'),
    );
    // reference_id is the per-anchor id, NOT a batch id.
    expect(atomicFn).toContain('p_anchor_id');
    // Insufficient credit returns before any write — no partial debit.
    expect(atomicFn).toContain('insufficient_credits');
    // Idempotent replay handles crash-after-debit-before-enqueue.
    expect(atomicFn).toContain("'idempotent', true");
    // Atomic transition uses an optimistic expected->target guard.
    expect(atomicFn).toContain('anchor_not_in_expected_status');
  });

  it('ports user-path idempotency to credit_transactions (partial unique index + replay)', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_credit_transactions_user_reference_type',
    );
    expect(migration).toMatch(
      /ON public\.credit_transactions \(user_id, reference_id, transaction_type\)\s*\n?\s*WHERE reference_id IS NOT NULL/,
    );
    const deductCreditFn = migration.slice(
      migration.indexOf('FUNCTION public.deduct_credit'),
      migration.indexOf('-- (10) Grants'),
    );
    expect(deductCreditFn).toContain('idempotency_key_conflict');
    expect(deductCreditFn).toContain("transaction_type = 'DEDUCTION'");
  });

  it('adds a money-conservation reconciliation function for the daily divergence alarm', () => {
    expect(migration).toContain('FUNCTION public.org_credit_ledger_divergence');
    expect(migration).toContain('diverged');
    expect(migration).toContain('p_initial_grant');
  });

  it('reloads the PostgREST schema cache and ships a runnable ROLLBACK', () => {
    expect(migration).toContain("NOTIFY pgrst, 'reload schema'");
    expect(migration).toContain('-- ROLLBACK:');
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.debit_and_enqueue_anchor');
  });
});

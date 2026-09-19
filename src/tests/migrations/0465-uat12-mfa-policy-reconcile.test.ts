import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0465_uat12_new_table_mfa_policy_reconcile.sql'),
  'utf8',
);

const code = sql
  .split('\n')
  .filter((line) => !/^\s*--/.test(line))
  .join('\n');

describe('0465 UAT-12 mandatory-MFA policy reconciliation', () => {
  it('installs the canonical restrictive policy on every table introduced by 0461', () => {
    for (const table of [
      'anchor_private_tags',
      'anchor_instant_intents',
      'anchor_credit_purchases',
    ]) {
      expect(code).toMatch(new RegExp(
        `CREATE POLICY mfa_verified_authenticated ON public\\.${table}`
          + `[\\s\\S]*AS RESTRICTIVE FOR ALL TO authenticated`
          + `[\\s\\S]*USING \\(private\\.is_human_mfa_verified\\(\\)\\)`
          + `[\\s\\S]*WITH CHECK \\(private\\.is_human_mfa_verified\\(\\)\\)`,
        'i',
      ));
    }
  });

  it('retires the non-canonical private-tags policy name without editing 0461', () => {
    expect(code).toMatch(
      /DROP POLICY IF EXISTS anchor_private_tags_mfa ON public\.anchor_private_tags/i,
    );
  });
});

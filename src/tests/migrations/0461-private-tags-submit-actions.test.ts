import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0461_uat12_private_tags_submit_actions.sql'),
  'utf8',
);

describe('0461 UAT-12 private tags and instant-credit lifecycle', () => {
  it('stores tags outside anchors metadata and forces row-level security', () => {
    expect(sql).toMatch(/CREATE TABLE public\.anchor_private_tags/i);
    expect(sql).toMatch(/ALTER TABLE public\.anchor_private_tags FORCE ROW LEVEL SECURITY/i);
    expect(sql).toMatch(/scope IN \('user', 'organization'\)/i);
    expect(sql).toMatch(/AS RESTRICTIVE FOR ALL TO authenticated[\s\S]*private\.is_human_mfa_verified/i);
  });

  it('keeps user tags owner-only and organization tags within the exact tenant', () => {
    expect(sql).toMatch(/owner_user_id = \(SELECT auth\.uid\(\)\)/i);
    expect(sql).toMatch(/org_id IN \(SELECT public\.get_user_org_ids\(\)\)/i);
    expect(sql).not.toMatch(/parent_org_id/i);
  });

  it('claims one exact intent and refunds only a matching prebroadcast debit', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.claim_anchor_instant_intent/i);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.settle_anchor_instant_intent/i);
    expect(sql).toMatch(/FOR UPDATE/i);
    expect(sql).toMatch(/matching_debit_not_found/i);
    expect(sql).toMatch(/prebroadcast_absence_not_proven/i);
    expect(sql).toMatch(/p_expected_attempt/i);
    expect(sql).toMatch(/v_intent\.status NOT IN \('PROCESSING', 'HELD'\)/i);
    expect(sql).toMatch(/'idempotent', true/i);
    expect(sql).toMatch(/transaction_type = 'REFUND'/i);
  });

  it('keeps live instant intents out of ordinary queue claims with a race backstop', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.claim_pending_anchors/i);
    expect(sql).toMatch(/NOT EXISTS[\s\S]*anchor_instant_intents/i);
    expect(sql).toMatch(/CREATE TRIGGER guard_active_instant_anchor_claim/i);
    expect(sql).toMatch(/current_setting\('app\.instant_intent_claim'/i);
  });

  it('explicitly strips every private-tag spelling from public metadata', () => {
    for (const key of ['private_tags', 'user_tags', 'org_tags']) {
      expect(sql).toContain(`- '${key}'`);
    }
    expect(sql).toMatch(/kv\.key NOT LIKE '\\_%'/i);
  });
});

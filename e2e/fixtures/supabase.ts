/**
 * Supabase E2E Test Helpers
 *
 * Centralized Supabase service client for E2E test data setup/teardown.
 * Uses env vars — never hardcode credentials in spec files.
 *
 * @updated 2026-03-10 10:30 PM EST
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Require credentials via environment variables — never hardcode secrets
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
      `Set it in .env.test or your shell before running E2E tests.`
    );
  }
  return value;
}

const SUPABASE_URL = process.env.E2E_SUPABASE_URL || 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_KEY = requireEnv('E2E_SUPABASE_SERVICE_KEY');
const SEED_PASSWORD = requireEnv('E2E_SEED_PASSWORD');

/**
 * Service-role Supabase client for E2E test setup/teardown.
 * Bypasses RLS — use only for test data management, never in app code.
 */
export function getServiceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}

// ── Seed User Constants ─────────────────────────────────────────────────────

export const SEED_USERS = {
  /** Platform admin / ORG_ADMIN at Arkova org — Carson */
  orgAdmin: {
    id: '44444444-0000-0000-0000-000000000001',
    email: 'carson@arkova.ai',
    password: SEED_PASSWORD,
    role: 'ORG_ADMIN' as const,
  },
  /** Platform admin / ORG_ADMIN at Arkova org — Sarah */
  registrar: {
    id: '44444444-0000-0000-0000-000000000002',
    email: 'sarah@arkova.ai',
    password: SEED_PASSWORD,
    role: 'ORG_ADMIN' as const,
  },
  /** Alias for backward compat — points to Sarah */
  orgBAdmin: {
    id: '44444444-0000-0000-0000-000000000002',
    email: 'sarah@arkova.ai',
    password: SEED_PASSWORD,
    role: 'ORG_ADMIN' as const,
  },
  /** Alias for backward compat — points to Carson */
  individual: {
    id: '44444444-0000-0000-0000-000000000001',
    email: 'carson@arkova.ai',
    password: SEED_PASSWORD,
    role: 'ORG_ADMIN' as const,
  },
};

// ── Test Data Helpers ───────────────────────────────────────────────────────

/**
 * Create a test anchor via service client. Returns anchor with public_id if SECURED.
 * Caller is responsible for cleanup via `deleteTestAnchor()`.
 */
export async function createTestAnchor(
  serviceClient: SupabaseClient,
  overrides: {
    userId?: string;
    status?: 'PENDING' | 'SECURED' | 'REVOKED' | 'EXPIRED';
    filename?: string;
    fingerprint?: string;
  } = {}
) {
  const timestamp = Date.now();
  const defaults = {
    user_id: overrides.userId ?? SEED_USERS.individual.id,
    fingerprint: overrides.fingerprint ?? `e2e_test_${timestamp}_${'a'.repeat(44)}`,
    filename: overrides.filename ?? `e2e_test_${timestamp}.pdf`,
    file_size: 12345,
    status: 'PENDING' as const,
  };

  // Insert as PENDING first
  const { data: anchor, error: insertError } = await serviceClient
    .from('anchors')
    .insert(defaults)
    .select()
    .single();

  if (insertError || !anchor) {
    throw new Error(`Failed to create test anchor: ${insertError?.message}`);
  }

  // If requested status is not PENDING, update it
  const targetStatus = overrides.status ?? 'PENDING';
  if (targetStatus !== 'PENDING') {
    const updateFields: Record<string, unknown> = { status: targetStatus };

    if (targetStatus === 'SECURED') {
      updateFields.chain_tx_id = `e2e_receipt_${timestamp}`;
      updateFields.chain_block_height = 99999;
      updateFields.chain_timestamp = new Date().toISOString();
    }

    if (targetStatus === 'REVOKED') {
      updateFields.revocation_reason = 'E2E test revocation';
    }

    await serviceClient
      .from('anchors')
      .update(updateFields)
      .eq('id', anchor.id);
  }

  // Re-fetch to get generated fields (public_id, updated status)
  const { data: final } = await serviceClient
    .from('anchors')
    .select('*')
    .eq('id', anchor.id)
    .single();

  return final!;
}

/**
 * Delete a test anchor by ID. Safe to call even if anchor doesn't exist.
 */
export async function deleteTestAnchor(
  serviceClient: SupabaseClient,
  anchorId: string
) {
  // Delete related audit events first (FK constraint)
  await serviceClient
    .from('audit_events')
    .delete()
    .eq('anchor_id', anchorId);

  await serviceClient
    .from('anchors')
    .delete()
    .eq('id', anchorId);
}
